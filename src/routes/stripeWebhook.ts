import { Router, Request, Response } from "express";
import Stripe from "stripe";
import { prisma } from "../lib/prisma";
import { getTenantPrismaForSchema } from "../lib/tenant-prisma-manager";
import { getStripeClient } from "../integrations/stripe/client";
import { Prisma, PaymentMethod, PaymentStatus, StripeSessionStatus } from "../generated/tenant-client";
import { queueGhlEvent } from "../integrations/ghl/sync";

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
stripeWebhookRouter.post("/", async (req: Request, res: Response) => {
  const connectSecret = process.env.STRIPE_CONNECT_WEBHOOK_SECRET;
  if (!connectSecret) {
    console.error("[stripeWebhook] STRIPE_CONNECT_WEBHOOK_SECRET is not configured");
    res.sendStatus(500);
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

  // Idempotency — reject replays. Only a genuine unique-constraint violation
  // means "already processed, safe to skip". Any other error (e.g. a
  // transient DB failure) must NOT be silently acked — doing so would tell
  // Stripe "got it" for an event we never actually recorded or processed,
  // and Stripe would then never retry it.
  try {
    await tp.webhookEvent.create({
      data: { source: "stripe", externalId: event.id },
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      res.sendStatus(200);
      return;
    }
    console.error(`[stripeWebhook] ${tenant.id} failed to record webhook event ${event.id}:`, err);
    res.sendStatus(500);
    return;
  }

  // Process asynchronously; always ack 200 immediately once recorded.
  res.sendStatus(200);
  handleEvent(tp, tenant.id, event).catch((err) =>
    console.error(`[stripeWebhook] ${tenant.id} event ${event.id} failed:`, err)
  );
});

async function handleEvent(
  tp: Awaited<ReturnType<typeof getTenantPrismaForSchema>>,
  tenantId: string,
  event: Stripe.Event
): Promise<void> {
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
  }
}

async function handleSessionCompleted(
  tp: Awaited<ReturnType<typeof getTenantPrismaForSchema>>,
  tenantId: string,
  session: Stripe.Checkout.Session
): Promise<void> {
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

  // ONE_TIME — create Payment, mark Invoice PAID
  if (!stripeSession.invoiceId) return;

  const invoice = await tp.invoice.findUnique({ where: { id: stripeSession.invoiceId } });
  if (!invoice || invoice.status === "PAID") return;

  const piId = typeof session.payment_intent === "string"
    ? session.payment_intent
    : (session.payment_intent as Stripe.PaymentIntent | null)?.id ?? null;

  await tp.$transaction([
    tp.payment.create({
      data: {
        customerId: invoice.customerId,
        visitId: invoice.visitId ?? undefined,
        amount: stripeSession.amountTotal ?? invoice.amount,
        method: PaymentMethod.STRIPE,
        status: PaymentStatus.PAID,
        stripeId: piId,
        paidAt: new Date(),
      },
    }),
    tp.invoice.update({
      where: { id: invoice.id },
      data: { status: "PAID" },
    }),
  ]);
  queueGhlEvent(tp, "payment.collected", invoice.customerId).catch(console.error);
}

async function handlePaymentFailed(
  tp: Awaited<ReturnType<typeof getTenantPrismaForSchema>>,
  _tenantId: string,
  pi: Stripe.PaymentIntent
): Promise<void> {
  // Find the payment by stripeId if it exists, otherwise find via metadata
  const invoiceId = pi.metadata?.invoiceId;
  if (!invoiceId) return;

  const invoice = await tp.invoice.findUnique({ where: { id: invoiceId } });
  if (!invoice) return;

  // Upsert payment record as FAILED
  const existing = await tp.payment.findFirst({ where: { stripeId: pi.id } });
  if (existing) {
    await tp.payment.update({ where: { id: existing.id }, data: { status: PaymentStatus.FAILED } });
  } else {
    await tp.payment.create({
      data: {
        customerId: invoice.customerId,
        visitId: invoice.visitId ?? undefined,
        amount: invoice.amount,
        method: PaymentMethod.STRIPE,
        status: PaymentStatus.FAILED,
        stripeId: pi.id,
      },
    });
  }

}
