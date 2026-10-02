import { Request, Router } from "express";
import { UserRole } from "@prisma/client";
import { requireAuth } from "../middleware/requireAuth";
import { requireTenantAccess } from "../middleware/requireTenantAccess";
import { requireRole } from "../middleware/requireRole";
import { AppError } from "../lib/app-error";
import { h, asObject, requireString } from "../lib/http";
import { decrypt } from "../lib/crypto";
import { getStripeClient } from "../integrations/stripe/client";
import { createOneTimeSession, createSetupSession } from "../integrations/stripe/checkout";
import { StripeSessionType } from "../generated/tenant-client";
import { prisma } from "../lib/prisma";

export const paymentsRouter = Router();
paymentsRouter.use(requireAuth);
paymentsRouter.use(requireTenantAccess);
paymentsRouter.use(requireRole(UserRole.ADMIN, UserRole.MANAGER));

const FRONTEND_URL = process.env.FRONTEND_URL?.split(",")[0].trim() ?? "";

function getStripe(req: Request) {
  const settings = req as unknown as { _stripeSecretKey?: string };
  // Loaded once per request via getSettings() below.
  return settings._stripeSecretKey ? getStripeClient(settings._stripeSecretKey) : null;
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
