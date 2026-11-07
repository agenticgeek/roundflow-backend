import { Router, Request, Response } from "express";
// @ts-expect-error — gocardless-nodejs ships ESM as main but has a CJS build under require condition
import { parse, InvalidSignatureError } from "gocardless-nodejs";
import { prisma } from "../lib/prisma";
import { guardWebhook } from "../lib/webhook-guard";
import { getTenantPrismaForSchema } from "../lib/tenant-prisma-manager";
import { decrypt, safeEqual } from "../lib/crypto";
import { PaymentStatus } from "../generated/tenant-client";
import { createPaymentService } from "../services/payment.service";
import { processWebhookEvent } from "../services/webhook-events.service";

export const gocardlessWebhookRouter = Router();

gocardlessWebhookRouter.post("/", guardWebhook("gcWebhook", async (req: Request, res: Response) => {
  const tenantId = req.query.tenantId as string | undefined;
  const secret   = req.query.secret   as string | undefined;

  if (!tenantId || !secret) {
    res.status(400).json({ error: "Missing tenantId or secret" });
    return;
  }

  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
  if (!tenant) { res.sendStatus(200); return; }

  const tp = getTenantPrismaForSchema(tenant.schemaName);
  // gocardlessWebhookSecretEncrypted only gates this URL's ?secret= query
  // param (see connect route) — GoCardless signs with its own secret, which
  // the admin must paste in separately after creating the endpoint by hand
  // in their GoCardless dashboard (no API for that, unlike Stripe).
  const bs = await tp.businessSettings.findFirst({
    select: { gocardlessWebhookSecretEncrypted: true, gocardlessWebhookSigningSecretEncrypted: true },
  });
  if (!bs?.gocardlessWebhookSecretEncrypted) { res.sendStatus(200); return; }
  if (!safeEqual(decrypt(bs.gocardlessWebhookSecretEncrypted), secret)) {
    // Wrong (or forged) route token — fail quietly, same as every other
    // "not for this request" branch above, so this endpoint doesn't tell a
    // prober whether a given tenantId exists.
    res.sendStatus(200);
    return;
  }
  if (!bs.gocardlessWebhookSigningSecretEncrypted) {
    // Admin hasn't pasted the real GoCardless-issued secret in yet — nothing
    // we can verify signatures against.
    res.sendStatus(200);
    return;
  }

  const webhookSecret = decrypt(bs.gocardlessWebhookSigningSecretEncrypted);
  const sig = req.headers["webhook-signature"] as string | undefined;

  let events: GcEvent[];
  try {
    events = parse(req.body as Buffer, webhookSecret, sig ?? "");
  } catch (err) {
    if (err instanceof InvalidSignatureError) {
      res.status(401).json({ error: "Invalid webhook signature" });
      return;
    }
    res.status(400).json({ error: "Malformed webhook body" });
    return;
  }

  // Process-then-ack (BE-03): each event gets a durable dedup row (RECEIVED -> DONE/FAILED). If any event's effect
  // fails we answer 500 so GoCardless redelivers the batch; events already DONE are skipped on redelivery and the
  // retry sweep also re-runs FAILED ones.
  let failed = 0;
  for (const event of events) {
    if (!event.id) continue;
    const outcome = await processWebhookEvent(tp, "gocardless", event.id, event, () => handleGocardlessEvent(tp, event));
    if (outcome === "failed") failed++;
  }
  res.sendStatus(failed > 0 ? 500 : 200);
}));

export type GcEvent = {
  id?: string;
  resource_type?: string;
  action?: string;
  links?: { payment?: string; mandate?: string };
};

type TenantDb = Awaited<ReturnType<typeof getTenantPrismaForSchema>>;

// GoCardless payment actions -> our PaymentStatus (BE-07/BE-08, ACT-07):
//   confirmed   = the bank accepted the debit and it is being collected: PROCESSING (NOT paid)
//   paid_out    = the money reached the merchant: PAID
//   failed / cancelled
//   charged_back = the customer's bank took the money back: DISPUTED
//   chargeback_cancelled = the chargeback was reversed: PAID again
//   refunded    = REFUNDED
const PAYMENT_ACTIONS: Record<string, { target: PaymentStatus; note?: string }> = {
  confirmed: { target: PaymentStatus.PROCESSING },
  paid_out: { target: PaymentStatus.PAID },
  failed: { target: PaymentStatus.FAILED },
  cancelled: { target: PaymentStatus.CANCELLED },
  charged_back: { target: PaymentStatus.DISPUTED, note: "GoCardless chargeback" },
  chargeback_cancelled: { target: PaymentStatus.PAID, note: "GoCardless chargeback reversed" },
  refunded: { target: PaymentStatus.REFUNDED, note: "GoCardless refund" },
};

// GoCardless `refunds` events carry the payment link; a settled refund returns the money. The event does not say
// whether it was partial, so any settled refund is treated as a full one (part payments / credit notes deferred).
const REFUND_SETTLED_ACTIONS = new Set(["paid", "refund_settled"]);

/** Applies one GoCardless event. Idempotent; also used by the webhook retry sweep. */
export async function handleGocardlessEvent(tp: TenantDb, event: GcEvent): Promise<void> {
  const resourceType = event.resource_type;
  const action = event.action;

  if (resourceType === "payments" || resourceType === "refunds") {
    const gcPaymentId = event.links?.payment;
    if (!gcPaymentId) return;

    const mapped =
      resourceType === "refunds"
        ? action && REFUND_SETTLED_ACTIONS.has(action)
          ? PAYMENT_ACTIONS.refunded
          : undefined
        : action
          ? PAYMENT_ACTIONS[action]
          : undefined;
    if (!mapped) return;

    const payment = await tp.payment.findUnique({ where: { gocardlessId: gcPaymentId } });
    if (payment) await createPaymentService(tp).transition(payment.id, mapped.target, { note: mapped.note });
    return;
  }

  if (resourceType === "mandates") {
    const gcMandateId = event.links?.mandate;
    if (!gcMandateId) return;

    const statusMap: Record<string, string> = {
      active: "active",
      cancelled: "cancelled",
      failed: "failed",
      expired: "expired",
    };
    const newStatus = action ? statusMap[action] : undefined;
    if (!newStatus) return;

    await tp.customer.updateMany({
      where: { gocardlessMandateId: gcMandateId },
      data: { gocardlessMandateStatus: newStatus },
    });
  }
}
