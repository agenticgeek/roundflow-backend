import { Request, Router } from "express";
import { requireAuth } from "../middleware/requireAuth";
import { requireTenantAccess } from "../middleware/requireTenantAccess";
import { requireBusinessAccess } from "../middleware/requireRole";
import { h } from "../lib/http";
import { createDebtService } from "../services/debt.service";
import { decrypt } from "../lib/crypto";
import { getStripeClient } from "../integrations/stripe/client";
import { createOneTimeSession } from "../integrations/stripe/checkout";
import { StripeSessionType } from "../generated/tenant-client";
import { queueGhlEvent } from "../integrations/ghl/sync";

export const debtRouter = Router();
debtRouter.use(requireAuth);
debtRouter.use(requireTenantAccess);
debtRouter.use(requireBusinessAccess());

const svc = (req: Request) => createDebtService(req.tenantPrisma!);

// GET /debt/kpis
debtRouter.get("/kpis", h(async (req, res) => {
  const kpis = await svc(req).getKpis();
  return res.json(kpis);
}));

// GET /debt/board?bucket=&roundId=&paymentMethod=
debtRouter.get("/board", h(async (req, res) => {
  const { bucket, roundId, paymentMethod } = req.query as Record<string, string | undefined>;
  if (!bucket) return res.status(400).json({ error: "bucket query param is required" });
  const items = await svc(req).getBoard(bucket, roundId, paymentMethod);
  return res.json(items);
}));

// POST /debt/:id/remind
debtRouter.post("/:id/remind", h(async (req, res) => {
  const { channel, message } = req.body ?? {};
  if (!channel || !message) return res.status(400).json({ error: "channel and message are required" });
  const result = await svc(req).sendReminder(req.params.id, channel, message);
  const invoice = await req.tenantPrisma!.invoice.findUnique({ where: { id: req.params.id }, select: { customerId: true } });
  if (invoice?.customerId) {
    queueGhlEvent(req.tenantPrisma!, "debt.overdue", invoice.customerId).catch(console.error);
  }
  return res.json(result);
}));

// POST /debt/:id/payment-link
// If Stripe is connected, creates a real Stripe Checkout Session and returns
// the hosted URL. Falls back to the static pay.roundflow.app link otherwise.
debtRouter.post("/:id/payment-link", h(async (req, res) => {
  const { message } = req.body ?? {};
  if (!message) return res.status(400).json({ error: "message is required" });

  // Try Stripe checkout first
  const bs = await req.tenantPrisma!.businessSettings.findFirst({
    select: { stripeConnected: true, stripeSecretKeyEncrypted: true },
  });
  if (bs?.stripeConnected && bs.stripeSecretKeyEncrypted) {
    const invoice = await req.tenantPrisma!.invoice.findUnique({ where: { id: req.params.id } });
    if (invoice && invoice.status !== "PAID" && invoice.status !== "VOID") {
      const existing = await req.tenantPrisma!.stripeSession.findFirst({
        where: { invoiceId: invoice.id, status: "PENDING" },
      });
      const checkoutUrl = existing?.url ?? await (async () => {
        const stripe = getStripeClient(decrypt(bs.stripeSecretKeyEncrypted!));
        const FRONTEND = process.env.FRONTEND_URL?.split(",")[0].trim() ?? "";
        const result = await createOneTimeSession(stripe, req.tenantPrisma!, {
          tenantId: req.profile!.tenantId,
          customerId: invoice.customerId,
          invoiceId: invoice.id,
          invoiceNumber: invoice.invoiceNumber,
          amountPence: Math.round(Number(invoice.amount) * 100),
          successUrl: `${FRONTEND}/invoices/${invoice.id}?payment=success`,
          cancelUrl:  `${FRONTEND}/invoices/${invoice.id}?payment=cancelled`,
        });
        await req.tenantPrisma!.stripeSession.create({
          data: {
            stripeSessionId: result.stripeSessionId,
            type: StripeSessionType.ONE_TIME,
            customerId: invoice.customerId,
            invoiceId: invoice.id,
            amountTotal: invoice.amount,
            currency: "gbp",
            url: result.url,
            expiresAt: result.expiresAt,
          },
        });
        return result.url;
      })();
      const result = await svc(req).sendPaymentLink(req.params.id, message, checkoutUrl);
      return res.json(result);
    }
  }

  const result = await svc(req).sendPaymentLink(req.params.id, message);
  return res.json(result);
}));

// PATCH /debt/:id/bad-debt
debtRouter.patch("/:id/bad-debt", h(async (req, res) => {
  const { flag } = req.body ?? {};
  if (typeof flag !== "boolean") return res.status(400).json({ error: "flag (boolean) is required" });
  const result = await svc(req).flagBadDebt(req.params.id, flag);
  return res.json(result);
}));

// PATCH /debt/:id/hold
debtRouter.patch("/:id/hold", h(async (req, res) => {
  const { flag } = req.body ?? {};
  if (typeof flag !== "boolean") return res.status(400).json({ error: "flag (boolean) is required" });
  const result = await svc(req).flagHold(req.params.id, flag);
  return res.json(result);
}));
