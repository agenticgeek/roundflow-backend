import { Request, Router } from "express";
import { requireAuth } from "../middleware/requireAuth";
import { requireTenantAccess } from "../middleware/requireTenantAccess";
import { requireBusinessAccess } from "../middleware/requireRole";
import { AppError } from "../lib/app-error";
import { h, asObject, requireString, parsePageParams } from "../lib/http";
import { parseOptionalDateOnly } from "../lib/validation";
import { toCsv } from "../lib/csv";
import { decrypt } from "../lib/crypto";
import { getStripeClient } from "../integrations/stripe/client";
import { createOneTimeSession, createSetupSession } from "../integrations/stripe/checkout";
import { StripeSessionType, PaymentMethod, PaymentStatus } from "../generated/tenant-client";
import { createPaymentService, PaymentListFilters } from "../services/payment.service";
export const paymentsRouter = Router();
paymentsRouter.use(requireAuth);
paymentsRouter.use(requireTenantAccess);
paymentsRouter.use(requireBusinessAccess());

function frontendUrl(): string {
  return process.env.FRONTEND_URL?.split(",")[0].trim() ?? "";
}

async function loadStripeClient(req: Request) {
  const bs = await req.tenantPrisma!.businessSettings.findFirst({
    select: { stripeConnected: true, stripeSecretKeyEncrypted: true },
  });
  if (!bs?.stripeConnected || !bs.stripeSecretKeyEncrypted) {
    throw new AppError(400, "Stripe is not connected. Go to Settings → Payment to connect.");
  }
  return getStripeClient(decrypt(bs.stripeSecretKeyEncrypted));
}

async function getTenantId(req: Request): Promise<string> {
  return req.profile!.tenantId;
}

// POST /payments/stripe/checkout — create a one-time payment session for an invoice
paymentsRouter.post(
  "/stripe/checkout",
  h(async (req, res) => {
    const body = asObject(req.body);
    const invoiceId = requireString(body.invoiceId, "invoiceId");

    const invoice = await req.tenantPrisma!.invoice.findUnique({ where: { id: invoiceId } });
    if (!invoice) throw new AppError(404, "Invoice not found");
    if (invoice.status === "PAID") throw new AppError(409, "Invoice is already paid");
    if (invoice.status === "VOID") throw new AppError(409, "Invoice is void");

    // Check no active session already exists for this invoice
    const existing = await req.tenantPrisma!.stripeSession.findFirst({
      where: { invoiceId, status: "PENDING" },
    });
    if (existing) {
      return res.json({ url: existing.url, sessionId: existing.id });
    }

    const customer = await req.tenantPrisma!.customer.findUniqueOrThrow({
      where: { id: invoice.customerId },
    });

    const stripe = await loadStripeClient(req);
    const tenantId = await getTenantId(req);

    const FRONTEND_URL = frontendUrl();
    const result = await createOneTimeSession(stripe, req.tenantPrisma!, {
      tenantId,
      customerId: customer.id,
      invoiceId,
      invoiceNumber: invoice.invoiceNumber,
      amountPence: Math.round(Number(invoice.amount) * 100),
      successUrl: `${FRONTEND_URL}/invoices/${invoiceId}?payment=success`,
      cancelUrl:  `${FRONTEND_URL}/invoices/${invoiceId}?payment=cancelled`,
    });

    const session = await req.tenantPrisma!.stripeSession.create({
      data: {
        stripeSessionId: result.stripeSessionId,
        type: StripeSessionType.ONE_TIME,
        customerId: customer.id,
        invoiceId,
        amountTotal: invoice.amount,
        currency: "gbp",
        url: result.url,
        expiresAt: result.expiresAt,
      },
    });

    return res.status(201).json({ url: session.url, sessionId: session.id });
  })
);

function parsePaymentFilters(query: Record<string, unknown>): PaymentListFilters {
  const { status, method } = query;
  if (status !== undefined && !(Object.values(PaymentStatus) as unknown[]).includes(status)) {
    throw new AppError(400, `status must be one of: ${Object.values(PaymentStatus).join(", ")}`);
  }
  if (method !== undefined && !(Object.values(PaymentMethod) as unknown[]).includes(method)) {
    throw new AppError(400, `method must be one of: ${Object.values(PaymentMethod).join(", ")}`);
  }
  return {
    status: status as PaymentStatus | undefined,
    method: method as PaymentMethod | undefined,
    from: parseOptionalDateOnly(query.from, "from"),
    to: parseOptionalDateOnly(query.to, "to"),
  };
}

// GET /payments?status&method&from&to&page&pageSize (GAP-028)
// → { rows: [{ id, customer: { id, name }, amount, method, status, paidAt,
//      createdAt, visitId, visitDate, invoiceId, invoiceNumber }], pagination }
paymentsRouter.get(
  "/",
  h(async (req, res) => {
    const query = req.query as Record<string, unknown>;
    const filters = parsePaymentFilters(query);
    const { page, pageSize } = parsePageParams(query, { defaultPageSize: 50, maxPageSize: 100 });
    const result = await createPaymentService(req.tenantPrisma!).listPayments(filters, page, pageSize);
    return res.json(result);
  })
);

// GET /payments/export.csv?status&method&from&to — every matching row, text/csv.
paymentsRouter.get(
  "/export.csv",
  h(async (req, res) => {
    const filters = parsePaymentFilters(req.query as Record<string, unknown>);
    const rows = await createPaymentService(req.tenantPrisma!).exportPayments(filters);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="payments.csv"`);
    return res.send(toCsv(rows));
  })
);

// PATCH /payments/:id/status — manual reconciliation for payment methods with
// no settlement webhook (BACS, cheque). GoCardless/Stripe stay webhook-only;
// overriding those here could race with the real webhook arriving later.
paymentsRouter.patch(
  "/:id/status",
  h(async (req, res) => {
    const body = asObject(req.body);
    const status = requireString(body.status, "status");
    if (status !== "PAID" && status !== "FAILED") {
      throw new AppError(400, "status must be PAID or FAILED");
    }

    const payment = await req.tenantPrisma!.payment.findUnique({ where: { id: req.params.id } });
    if (!payment) throw new AppError(404, "Payment not found");
    if (payment.method !== PaymentMethod.BACS && payment.method !== PaymentMethod.CHEQUE) {
      throw new AppError(409, "Only BACS and cheque payments can be manually reconciled");
    }
    if (payment.status === PaymentStatus.PAID) {
      throw new AppError(409, "Payment is already paid and cannot be changed");
    }

    const updated = await createPaymentService(req.tenantPrisma!).applyOutcome(req.params.id, status);
    return res.json(updated);
  })
);

// POST /payments/stripe/setup — save a card for recurring automatic charges
paymentsRouter.post(
  "/stripe/setup",
  h(async (req, res) => {
    const body = asObject(req.body);
    const customerId = requireString(body.customerId, "customerId");

    const customer = await req.tenantPrisma!.customer.findUnique({ where: { id: customerId } });
    if (!customer) throw new AppError(404, "Customer not found");

    const stripe = await loadStripeClient(req);
    const tenantId = await getTenantId(req);

    const FRONTEND_URL = frontendUrl();
    const result = await createSetupSession(stripe, req.tenantPrisma!, {
      tenantId,
      customerId,
      successUrl: `${FRONTEND_URL}/customers/${customerId}?setup=success`,
      cancelUrl:  `${FRONTEND_URL}/customers/${customerId}?setup=cancelled`,
    });

    const session = await req.tenantPrisma!.stripeSession.create({
      data: {
        stripeSessionId: result.stripeSessionId,
        type: StripeSessionType.SETUP,
        customerId,
        currency: "gbp",
        url: result.url,
        expiresAt: result.expiresAt,
      },
    });

    return res.status(201).json({ url: session.url, sessionId: session.id });
  })
);
