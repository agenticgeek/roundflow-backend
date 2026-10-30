import { Request, Router } from "express";
import { requireAuth } from "../middleware/requireAuth";
import { requireTenantAccess } from "../middleware/requireTenantAccess";
import { requireBusinessAccess } from "../middleware/requireRole";
import { AppError } from "../lib/app-error";
import { h, asObject, optBool, optReqNumber, optString, optStringArray, parsePageParams } from "../lib/http";
import { optIsoDate, parseOptionalDateOnly } from "../lib/validation";
import { toCsv } from "../lib/csv";
import { InvoiceStatus } from "../generated/tenant-client";
import { createInvoiceService, InvoiceListFilters, ManualPaymentMethod } from "../services/invoice.service";
import { optOutboundChannel } from "../services/message.service";
import { renderHtmlToPdf, invoiceHtml } from "../integrations/pdf/render";

export const invoicesRouter = Router();
invoicesRouter.use(requireAuth);
invoicesRouter.use(requireTenantAccess);
invoicesRouter.use(requireBusinessAccess());

const svc = (req: Request) => createInvoiceService(req.tenantPrisma!);

const MANUAL_METHODS: ManualPaymentMethod[] = ["BACS", "CHEQUE", "CASH"];

function parseListFilters(query: Record<string, unknown>): InvoiceListFilters {
  const { status, customerId, q } = query;
  if (status !== undefined && !(Object.values(InvoiceStatus) as unknown[]).includes(status)) {
    throw new AppError(400, `status must be one of: ${Object.values(InvoiceStatus).join(", ")}`);
  }
  return {
    status: status as InvoiceStatus | undefined,
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
  h(async (req, res) => {
    const { visitId, notes, dueDate, sendEmail } = req.body ?? {};
    if (!visitId || typeof visitId !== "string") {
      return res.status(400).json({ error: "visitId is required" });
    }
    const invoice = await svc(req).createInvoice({
      visitId,
      notes: optString(notes, "notes") ?? null,
      dueDate: optString(dueDate, "dueDate") ?? null,
      sendEmail: sendEmail === true,
    });
    return res.status(201).json(invoice);
  })
);

// POST /invoices/:id/send { channel?, resend? }
// 409 INVOICE_NOT_SENDABLE (PAID/VOID) · 409 INVOICE_ALREADY_SENT (unless resend)
// 409 GHL_NOT_CONNECTED · 400 NO_CONTACT_FOR_CHANNEL · 502 GHL_SEND_FAILED
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
    if (!MANUAL_METHODS.includes(b.method as ManualPaymentMethod)) {
      throw new AppError(400, `method must be one of: ${MANUAL_METHODS.join(", ")}`);
    }
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
