import { Router, Request, Response } from "express";
import Stripe from "stripe";
import { prisma } from "../lib/prisma";
import { getTenantPrismaForSchema } from "../lib/tenant-prisma-manager";
import { decrypt } from "../lib/crypto";
import { getStripeClient } from "../integrations/stripe/client";
import { PaymentMethod, PaymentStatus, StripeSessionStatus } from "../generated/tenant-client";

export const stripeWebhookRouter = Router();

stripeWebhookRouter.post("/", async (req: Request, res: Response) => {
  const tenantId = req.query.tenantId as string | undefined;
  const secret   = req.query.secret   as string | undefined;

  if (!tenantId || !secret) {
    res.status(400).json({ error: "Missing tenantId or secret" });
    return;
  }

  // Look up tenant and load BusinessSettings for this schema
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
  if (!tenant) { res.sendStatus(200); return; }

  const tp = getTenantPrismaForSchema(tenant.schemaName);
  const bs = await tp.businessSettings.findFirst({
    select: { stripeWebhookSecretEncrypted: true, stripeSecretKeyEncrypted: true },
  });
  if (!bs?.stripeWebhookSecretEncrypted || !bs.stripeSecretKeyEncrypted) {
    res.sendStatus(200);
    return;
  }

  // Verify Stripe signature — requires raw body
  const webhookSecret = decrypt(bs.stripeWebhookSecretEncrypted);
  const sig = req.headers["stripe-signature"] as string;
  let event: Stripe.Event;
  try {
    const stripe = getStripeClient(decrypt(bs.stripeSecretKeyEncrypted));
    event = stripe.webhooks.constructEvent(req.body as Buffer, sig, webhookSecret);
  } catch {
    res.status(400).json({ error: "Webhook signature verification failed" });
    return;
  }

  // Idempotency — reject replays
  try {
    await tp.webhookEvent.create({
      data: { source: "stripe", externalId: event.id },
    });
  } catch {
    // Unique constraint violation = already processed
    res.sendStatus(200);
    return;
  }

  // Process asynchronously; always ack 200 immediately
  res.sendStatus(200);
  handleEvent(tp, tenantId, event).catch((err) =>
    console.error(`[stripeWebhook] ${tenantId} event ${event.id} failed:`, err)
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

  // GHL outbox: payment.failed (non-fatal — outbox table added with ghl branch)
  const customer = await tp.customer.findUnique({ where: { id: invoice.customerId } });
  if (customer?.ghlContactId) {
    try {
      await (tp as any).integrationOutbox?.create?.({
        data: {
          eventType: "payment.failed",
          payload: {
            ghlContactId: customer.ghlContactId,
            amount: Number(invoice.amount),
            balanceOwed: Number(invoice.amount),
          },
        },
      });
    } catch { /* outbox not yet available on this branch */ }
  }
}

