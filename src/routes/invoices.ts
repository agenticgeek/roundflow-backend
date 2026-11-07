import { Request, Router } from "express";
import { requireAuth } from "../middleware/requireAuth";
import { requireTenantAccess } from "../middleware/requireTenantAccess";
import { requireBusinessAccess } from "../middleware/requireRole";
import { AppError } from "../lib/app-error";
import { adminIdempotency } from "../lib/idempotency";
import { h, asObject, optBool, optReqNumber, optString, optStringArray, parsePageParams } from "../lib/http";
import { optIsoDate, parseIsoDate, parseOptionalDateOnly } from "../lib/validation";
import { toCsv } from "../lib/csv";
import { InvoiceStatus, MessageChannel } from "../generated/tenant-client";
import { createInvoiceSendBatchService, MAX_BATCH, type BulkSendSelection } from "../services/invoice-send-batch.service";
import { createInvoiceService, InvoiceListFilters, InvoiceStatusFilter, ManualPaymentMethod } from "../services/invoice.service";
import { optOutboundChannel } from "../services/message.service";
import { renderHtmlToPdf, invoiceHtml } from "../integrations/pdf/render";

export const invoicesRouter = Router();
invoicesRouter.use(requireAuth);
invoicesRouter.use(requireTenantAccess);
invoicesRouter.use(requireBusinessAccess());

const svc = (req: Request) => createInvoiceService(req.tenantPrisma!);


function parseListFilters(query: Record<string, unknown>): InvoiceListFilters {
  const { status, customerId, q } = query;
  if (status !== undefined && status !== "OVERDUE" && !(Object.values(InvoiceStatus) as unknown[]).includes(status)) {
    throw new AppError(400, `status must be one of: ${[...Object.values(InvoiceStatus), "OVERDUE"].join(", ")}`);
  }
  return {
    status: status as InvoiceStatusFilter | undefined,
    from: parseOptionalDateOnly(query.from, "from"),
    to: parseOptionalDateOnly(query.to, "to"),
    customerId: typeof customerId === "string" && customerId ? customerId : undefined,
    q: typeof q === "string" && q.trim() ? q.trim() : undefined,
  };
}

function parseBulkBody(body: unknown): { date: Date; excludeVisitIds: string[] } {
  const b = asObject(body);
  const date = parseOptionalDateOnly(b.date, "date");
  if (!date) throw new AppError(400, `"date" is required (YYYY-MM-DD)`);
  return { date, excludeVisitIds: optStringArray(b.excludeVisitIds, "excludeVisitIds") ?? [] };
}

// ---- static paths first, so none is captured as an invoice :id ------------

// GET /invoices?status&from&to&customerId&q&page&pageSize (GAP-028)
// → { rows: [{ id, invoiceNumber, customer: { id, name }, total, status,
//      issuedAt, dueDate, paidAt, paymentMethod, visitId }], pagination }
invoicesRouter.get(
  "/",
  h(async (req, res) => {
    const query = req.query as Record<string, unknown>;
    const filters = parseListFilters(query);
    const { page, pageSize } = parsePageParams(query, { defaultPageSize: 50, maxPageSize: 100 });
    return res.json(await svc(req).listInvoices(filters, page, pageSize));
  })
);

// GET /invoices/export.csv?status&from&to&customerId&q — every matching row.
invoicesRouter.get(
  "/export.csv",
  h(async (req, res) => {
    const filters = parseListFilters(req.query as Record<string, unknown>);
    const rows = await svc(req).exportInvoices(filters);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="invoices.csv"`);
    return res.send(toCsv(rows));
  })
);

// GET /invoices/preview?visitId=
invoicesRouter.get(
  "/preview",
  h(async (req, res) => {
    const visitId = req.query.visitId as string | undefined;
    if (!visitId) return res.status(400).json({ error: "visitId query param is required" });
    const preview = await svc(req).previewInvoice(visitId);
    return res.json(preview);
  })
);

// GET /invoices/preview/pdf?visitId= — PDF of an invoice preview (before it's saved).
// Registered before /:id/pdf so "preview" isn't captured as an invoice id.
invoicesRouter.get(
  "/preview/pdf",
  h(async (req, res) => {
    const visitId = req.query.visitId as string | undefined;
    if (!visitId) return res.status(400).json({ error: "visitId query param is required" });
    const preview = await svc(req).previewInvoice(visitId);
    const pdf = await renderHtmlToPdf(invoiceHtml({ ...preview, status: "PREVIEW" }));
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="${preview.invoiceNumber}-preview.pdf"`);
    return res.send(pdf);
  })
);

// POST /invoices/bulk/preview { date, excludeVisitIds? } (B5)
// → { items: [{ visitId, customerName, address, amount, vat, total, paymentMethod }],
//     skipped: [{ visitId, customerName, reason }], totals: { count, amount } }
invoicesRouter.post(
  "/bulk/preview",
  h(async (req, res) => {
    const { date, excludeVisitIds } = parseBulkBody(req.body);
    return res.json(await svc(req).previewBulk(date, excludeVisitIds));
  })
);

// POST /invoices/bulk { date, excludeVisitIds?, sendNow?, channel? } (B5)
// → { created: [{ visitId, invoiceId, invoiceNumber, total, sent? }],
//     failed: [{ visitId, invoiceId?, error }], totals: { count, amount } }
invoicesRouter.post(
  "/bulk",
  h(async (req, res) => {
    const { date, excludeVisitIds } = parseBulkBody(req.body);
    const b = req.body as Record<string, unknown>;
    const result = await svc(req).createBulk(date, excludeVisitIds, {
      sendNow: optBool(b.sendNow, "sendNow") ?? false,
      channel: optOutboundChannel(b.channel),
    });
    return res.json(result);
  })
);

// ---- bulk send (ACT-01) -----------------------------------------------------

function parseBulkSend(body: unknown): BulkSendSelection {
  const b = asObject(body);
  const ids = optStringArray(b.ids, "ids");
  if (ids && (ids.length === 0 || ids.length > MAX_BATCH)) {
    throw new AppError(400, `"ids" must contain 1 to ${MAX_BATCH} invoice ids`, "INVALID_BATCH_SIZE");
  }
  const status = b.status === undefined ? undefined : (parseListFilters({ status: b.status }).status as InvoiceStatusFilter);
  const { customerId, q, from, to } = parseListFilters(asObject(b.filters ?? {}) as Record<string, unknown>);
  return {
    ids,
    status,
    filters: { customerId, q, from, to },
    channel: optOutboundChannel(b.channel),
    resend: optBool(b.resend, "resend") ?? false,
  };
}

// POST /invoices/bulk-send/preview { ids? | status?: DRAFT (default), filters?, channel?, resend? }
// → { total, willSend, byChannel: { SMS?, EMAIL?, WHATSAPP? }, skipped: { <reason>: n }, truncated, totalMatching,
//     invoices: [{ id, invoiceNumber, customerName, channel|null, skip|null }] }
//   skip reasons: NOT_DRAFT PAID VOID NO_CONTACT_FOR_CHANNEL OPTED_OUT GHL_NOT_CONNECTED NOT_FOUND
invoicesRouter.post(
  "/bulk-send/preview",
  h(async (req, res) => res.json(await createInvoiceSendBatchService(req.tenantPrisma!).preview(parseBulkSend(req.body))))
);

// POST /invoices/bulk-send { ids? | status?: DRAFT (default), filters?, channel?, resend?: false }
// → 202 { batchId, queued, skipped: [{ id, reason }], truncated? } — max 500 per batch; sends run from the outbox.
//   A second identical request while the first is in flight skips with ALREADY_QUEUED.
invoicesRouter.post(
  "/bulk-send",
  h(async (req, res) => res.status(202).json(await createInvoiceSendBatchService(req.tenantPrisma!).send(parseBulkSend(req.body))))
);

// GET /invoices/bulk-send/:batchId
// → { batchId, total, done, counts: { QUEUED, SENT, FAILED, SKIPPED }, results: [{ id, status, error?, code? }] } · 404 BATCH_NOT_FOUND
invoicesRouter.get(
  "/bulk-send/:batchId",
  h(async (req, res) => res.json(await createInvoiceSendBatchService(req.tenantPrisma!).getBatch(req.params.batchId)))
);

// ---- per-invoice ------------------------------------------------------------

// GET /invoices/:id
invoicesRouter.get(
  "/:id",
  h(async (req, res) => {
    const invoice = await svc(req).getInvoice(req.params.id);
    return res.json(invoice);
  })
);

// GET /invoices/:id/pdf — rendered invoice (used for both download and print)
invoicesRouter.get(
  "/:id/pdf",
  h(async (req, res) => {
    const data = await svc(req).getRenderData(req.params.id);
    const pdf = await renderHtmlToPdf(invoiceHtml(data));
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="${data.invoiceNumber}.pdf"`);
    return res.send(pdf);
  })
);

// POST /invoices — 409 VISIT_NOT_COMPLETED / ALREADY_INVOICED; dueDate
// defaults to today + BusinessSettings.invoiceDueDays.
invoicesRouter.post(
  "/",
  adminIdempotency(), // BE-17: optional Idempotency-Key
  h(async (req, res) => {
    const { visitId, notes, dueDate, sendEmail } = req.body ?? {};
    if (!visitId || typeof visitId !== "string") {
      return res.status(400).json({ error: "visitId is required" });
    }
    if (sendEmail !== undefined && typeof sendEmail !== "boolean") {
      throw new AppError(400, '"sendEmail" must be true or false', "VALIDATION_FAILED");
    }
    const invoice = await svc(req).createInvoice({
      visitId,
      notes: optString(notes, "notes") ?? null,
      dueDate: dueDate === undefined || dueDate === null ? null : (parseIsoDate(dueDate, "dueDate"), String(dueDate)),
      sendEmail: false,
    });
    if (sendEmail !== true) return res.status(201).json(invoice);
    // The invoice exists either way; the email result is reported next to it (SENT only after SES accepted it).
    try {
      const sent = await svc(req).sendInvoice(invoice.id, { channel: MessageChannel.EMAIL });
      return res.status(201).json({ ...invoice, emailSent: true, pdfAttached: sent.pdfAttached });
    } catch (err) {
      const raw = (err as { code?: unknown }).code;
      const code = typeof raw === "string" ? raw : "EMAIL_SEND_FAILED";
      return res.status(201).json({ ...invoice, emailSent: false, emailError: { code, message: (err as Error).message } });
    }
  })
);

// POST /invoices/:id/send { channel?, resend? }
// 409 INVOICE_NOT_SENDABLE (PAID/VOID) · 409 INVOICE_ALREADY_SENT (unless resend)
// 409 CHANNEL_UNAVAILABLE (reason) · 400 NO_CONTACT_FOR_CHANNEL · 502 GHL_SEND_FAILED / EMAIL_SEND_FAILED
invoicesRouter.post(
  "/:id/send",
  h(async (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const result = await svc(req).sendInvoice(req.params.id, {
      channel: optOutboundChannel(b.channel),
      resend: optBool(b.resend, "resend") ?? false,
    });
    return res.json(result);
  })
);

// POST /invoices/:id/mark-paid { method: BACS|CHEQUE|CASH, reference?, paidAt?, amount? } (A7)
// → { invoice: { id, invoiceNumber, status, paidAt, amount }, payment }
// 409 INVOICE_ALREADY_PAID / INVOICE_VOID · 400 AMOUNT_MISMATCH
invoicesRouter.post(
  "/:id/mark-paid",
  h(async (req, res) => {
    const b = asObject(req.body);
    const result = await svc(req).markPaid(
      req.params.id,
      {
        method: b.method as ManualPaymentMethod,
        reference: optString(b.reference, "reference", { maxLength: 100 }) ?? null,
        paidAt: optIsoDate(b.paidAt, "paidAt") ?? null,
        amount: optReqNumber(b.amount, "amount"),
      },
      { id: req.profile?.id, role: req.profile?.role }
    );
    return res.json(result);
  })
);
