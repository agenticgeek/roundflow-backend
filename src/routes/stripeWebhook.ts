import { Router, Request, Response } from "express";
import Stripe from "stripe";
import { prisma } from "../lib/prisma";
import { guardWebhook } from "../lib/webhook-guard";
import { getTenantPrismaForSchema } from "../lib/tenant-prisma-manager";
import { getStripeClient } from "../integrations/stripe/client";
import { Prisma, PaymentMethod, PaymentStatus, StripeSessionStatus } from "../generated/tenant-client";
import { createPaymentService } from "../services/payment.service";
import { notifyPaymentEvent } from "../services/notify";
import { processWebhookEvent } from "../services/webhook-events.service";

export const stripeWebhookRouter = Router();

// Platform-level Connect webhook — one endpoint, created once in RoundFlow's
// own Stripe account (dashboard: Developers -> Webhooks -> Add endpoint,
// "Listen to events on Connected accounts"), receives events for every
// tenant's connected account automatically, tagged by `event.account`.
//
// This replaces a per-tenant design where RoundFlow generated its own random
// "webhook secret" per tenant and asked the admin to manually register a
// per-tenant URL in their own Stripe dashboard. That never actually worked:
// Stripe generates and owns the real signing secret for whatever endpoint is
// registered, so a self-invented value could never match it — signature
// verification would fail on every event, forever. See
// docs/handoff/backend for the full writeup.
stripeWebhookRouter.post("/", guardWebhook("stripeWebhook", async (req: Request, res: Response) => {
  const connectSecret = process.env.STRIPE_CONNECT_WEBHOOK_SECRET;
  if (!connectSecret) {
    // A6: a config gap, not a crash — 503 tells Stripe (and whoever reads the
    // dashboard's delivery log) the endpoint is unavailable, and it retries.
    console.error("[stripeWebhook] STRIPE_CONNECT_WEBHOOK_SECRET is not configured");
    res.status(503).json({ error: "Stripe webhook is not configured", code: "WEBHOOK_NOT_CONFIGURED" });
    return;
  }

  const sig = req.headers["stripe-signature"] as string;
  let event: Stripe.Event;
  try {
    const stripe = getStripeClient(process.env.STRIPE_SECRET_KEY!);
    event = stripe.webhooks.constructEvent(req.body as Buffer, sig, connectSecret);
  } catch {
    res.status(400).json({ error: "Webhook signature verification failed" });
    return;
  }

  const stripeAccountId = event.account;
  if (!stripeAccountId) {
    // Not a connected-account event — nothing for RoundFlow to do with it.
    res.sendStatus(200);
    return;
  }

  const tenant = await prisma.tenant.findUnique({ where: { stripeConnectAccountId: stripeAccountId } });
  if (!tenant) { res.sendStatus(200); return; }

  const tp = getTenantPrismaForSchema(tenant.schemaName);

  // Process-then-ack (BE-03): the dedup row is written first (status RECEIVED), the effect runs, then the row is
  // marked DONE. If the effect fails the row stays FAILED and we answer 500, so Stripe redelivers the event (and
  // the retry sweep re-runs it) instead of the event being lost. A replay of a DONE event is acknowledged and skipped.
  const outcome = await processWebhookEvent(tp, "stripe", event.id, event, () => handleStripeEvent(tp, tenant.id, event));
  res.sendStatus(outcome === "failed" ? 500 : 200);
}));

type TenantDb = Awaited<ReturnType<typeof getTenantPrismaForSchema>>;

/** Applies one verified Stripe event to the tenant. Idempotent; also used by the webhook retry sweep. */
export async function handleStripeEvent(tp: TenantDb, tenantId: string, event: Stripe.Event): Promise<void> {
  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object as Stripe.Checkout.Session;
      await handleSessionCompleted(tp, tenantId, session);
      break;
    }
    case "checkout.session.expired": {
      const session = event.data.object as Stripe.Checkout.Session;
      await tp.stripeSession.updateMany({
        where: { stripeSessionId: session.id },
        data: { status: StripeSessionStatus.EXPIRED },
      });
      break;
    }
    case "payment_intent.payment_failed": {
      const pi = event.data.object as Stripe.PaymentIntent;
      await handlePaymentFailed(tp, tenantId, pi);
      break;
    }
    case "charge.refunded":
      await handleChargeRefunded(tp, event.data.object as Stripe.Charge);
      break;
    case "charge.dispute.created":
      await handleDispute(tp, event.data.object as Stripe.Dispute, "created");
      break;
    case "charge.dispute.closed":
      await handleDispute(tp, event.data.object as Stripe.Dispute, "closed");
      break;
  }
}

async function handleSessionCompleted(tp: TenantDb, tenantId: string, session: Stripe.Checkout.Session): Promise<void> {
  const stripeSession = await tp.stripeSession.findUnique({
    where: { stripeSessionId: session.id },
  });
  if (!stripeSession) return;

  await tp.stripeSession.update({
    where: { id: stripeSession.id },
    data: { status: StripeSessionStatus.COMPLETE, completedAt: new Date() },
  });

  if (stripeSession.type === "SETUP") {
    // Save the default payment method on the customer
    const pm = session.setup_intent
      ? (typeof session.setup_intent === "string"
          ? session.setup_intent
          : (session.setup_intent as Stripe.SetupIntent).payment_method)
      : null;
    if (pm && typeof pm === "string") {
      await tp.customer.update({
        where: { id: stripeSession.customerId },
        data: { stripeDefaultPaymentMethodId: pm },
      });
    }
    return;
  }

  // ONE_TIME — find or create the Payment, then settle it through the state machine (invoice PAID, hold release,
  // notification all happen exactly once, even when this event is retried).
  if (!stripeSession.invoiceId) return;

  const invoice = await tp.invoice.findUnique({ where: { id: stripeSession.invoiceId } });
  if (!invoice) return;

  const piId = idOf(session.payment_intent);
  const payment = await ensureStripePayment(tp, invoice, piId, stripeSession.amountTotal ?? invoice.amount);
  const result = await createPaymentService(tp).transition(payment.id, PaymentStatus.PAID, {
    invoiceId: invoice.id,
    note: "Stripe checkout completed",
  });
  if (!result.changed && invoice.status !== "PAID") {
    // The payment was already PAID (or the invoice has no visit): make sure the invoice itself follows.
    await tp.invoice.updateMany({
      where: { id: invoice.id, status: { in: ["DRAFT", "SENT"] } },
      data: { status: "PAID", paidAt: new Date() },
    });
  }
}

const idOf = (v: string | { id: string } | null | undefined): string | null => (typeof v === "string" ? v : v?.id ?? null);

type InvoiceLike = { customerId: string; visitId: string | null; amount: Prisma.Decimal };

// The Payment row for a Stripe PaymentIntent: by stripeId, else the visit's Payment (visitId is unique, so a visit
// that already has one must reuse it), else a new PENDING one. stripeId is unique, so a concurrent create is re-read.
async function ensureStripePayment(tp: TenantDb, invoice: InvoiceLike, piId: string | null, amount: Prisma.Decimal | number) {
  let payment = piId ? await tp.payment.findUnique({ where: { stripeId: piId } }) : null;
  if (!payment && invoice.visitId) payment = await tp.payment.findUnique({ where: { visitId: invoice.visitId } });
  if (payment) {
    if (piId && !payment.stripeId) payment = await tp.payment.update({ where: { id: payment.id }, data: { stripeId: piId } });
    return payment;
  }
  try {
    return await tp.payment.create({
      data: {
        customerId: invoice.customerId,
        visitId: invoice.visitId ?? undefined,
        amount,
        method: PaymentMethod.STRIPE,
        status: PaymentStatus.PENDING,
        stripeId: piId,
      },
    });
  } catch (err) {
    if (piId && err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      const raced = await tp.payment.findUnique({ where: { stripeId: piId } });
      if (raced) return raced;
    }
    throw err;
  }
}

async function handlePaymentFailed(tp: TenantDb, _tenantId: string, pi: Stripe.PaymentIntent): Promise<void> {
  const invoiceId = pi.metadata?.invoiceId;
  if (!invoiceId) return;

  const invoice = await tp.invoice.findUnique({ where: { id: invoiceId } });
  if (!invoice) return;

  // Same shared state machine as GoCardless / manual reconciliation: a FAILED that arrives after the payment was
  // PAID (late or replayed event) is ignored.
  const payment = await ensureStripePayment(tp, invoice, pi.id, invoice.amount);
  await createPaymentService(tp).transition(payment.id, PaymentStatus.FAILED);
}

const money = (pence: number) => `GBP ${(pence / 100).toFixed(2)}`;

// BE-08: charge.refunded. A full refund moves the payment to REFUNDED (invoice VOID, activity log, office
// notified). A partial refund changes no state (part payments / credit notes are deferred): the office is told to
// reconcile by hand.
async function handleChargeRefunded(tp: TenantDb, charge: Stripe.Charge): Promise<void> {
  const piId = idOf(charge.payment_intent);
  const payment = piId ? await tp.payment.findUnique({ where: { stripeId: piId } }) : null;
  if (!payment) return;
  if (charge.refunded) {
    await createPaymentService(tp).transition(payment.id, PaymentStatus.REFUNDED, { note: "Stripe charge.refunded" });
    return;
  }
  const detail = `Partial refund of ${money(charge.amount_refunded)} (charge ${money(charge.amount)}): reconcile manually`;
  await tp.activityLog.create({
    data: { type: "PAYMENT_PARTIAL_REFUND", message: detail, entityId: payment.id, details: { customerId: payment.customerId } },
  });
  await notifyPaymentEvent(tp, { customerId: payment.customerId, title: "Partial refund recorded", body: detail });
}

// BE-08: charge.dispute.created -> DISPUTED (invoice reopened, office notified). charge.dispute.closed: won ->
// PAID again; lost -> stays DISPUTED, recorded and the office told. Other closing statuses are ignored.
async function handleDispute(tp: TenantDb, dispute: Stripe.Dispute, phase: "created" | "closed"): Promise<void> {
  const piId = idOf(dispute.payment_intent);
  const payment = piId ? await tp.payment.findUnique({ where: { stripeId: piId } }) : null;
  if (!payment) return;
  const svc = createPaymentService(tp);
  if (phase === "created") {
    await svc.transition(payment.id, PaymentStatus.DISPUTED, { note: `Stripe dispute: ${dispute.reason}` });
  } else if (dispute.status === "won") {
    await svc.transition(payment.id, PaymentStatus.PAID, { note: "Stripe dispute won" });
  } else if (dispute.status === "lost") {
    await tp.activityLog.create({
      data: { type: "PAYMENT_DISPUTE_LOST", message: "Payment dispute lost (Stripe)", entityId: payment.id, details: { customerId: payment.customerId } },
    });
    await notifyPaymentEvent(tp, {
      customerId: payment.customerId,
      title: "Payment dispute lost",
      body: "The dispute was decided against you; the money is not coming back.",
    });
  }
}
