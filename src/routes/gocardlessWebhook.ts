import { Router, Request, Response } from "express";
// @ts-ignore — gocardless-nodejs ships ESM as main but has a CJS build under require condition
import { parse, InvalidSignatureError } from "gocardless-nodejs";
import { prisma } from "../lib/prisma";
import { getTenantPrismaForSchema } from "../lib/tenant-prisma-manager";
import { decrypt } from "../lib/crypto";
import { PaymentStatus } from "../generated/tenant-client";
import { queueGhlEvent } from "../integrations/ghl/sync";

export const gocardlessWebhookRouter = Router();

gocardlessWebhookRouter.post("/", async (req: Request, res: Response) => {
  const tenantId = req.query.tenantId as string | undefined;
  const secret   = req.query.secret   as string | undefined;

  if (!tenantId || !secret) {
    res.status(400).json({ error: "Missing tenantId or secret" });
    return;
  }

  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
  if (!tenant) { res.sendStatus(200); return; }

  const tp = getTenantPrismaForSchema(tenant.schemaName);
  const bs = await tp.businessSettings.findFirst({
    select: { gocardlessWebhookSecretEncrypted: true },
  });
  if (!bs?.gocardlessWebhookSecretEncrypted) { res.sendStatus(200); return; }

  const webhookSecret = decrypt(bs.gocardlessWebhookSecretEncrypted);
  const sig = req.headers["webhook-signature"] as string | undefined;

  let events: Event[];
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

  // Ack immediately; process async
  res.sendStatus(200);
  processEvents(tp, events).catch((err) =>
    console.error(`[gcWebhook] ${tenantId} processing failed:`, err)
  );
});

async function processEvents(
  tp: Awaited<ReturnType<typeof getTenantPrismaForSchema>>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  events: any[]
): Promise<void> {
  for (const event of events as Array<{ id?: string; resource_type?: string; action?: string; links?: { payment?: string; mandate?: string } }>) {
    if (!event.id) continue;

    // Idempotency — skip replays
    try {
      await tp.webhookEvent.create({
        data: { source: "gocardless", externalId: event.id },
      });
    } catch {
      continue; // unique constraint → already processed
    }

    try {
      await handleEvent(tp, event);
    } catch (err) {
      console.error(`[gcWebhook] event ${event.id} (${event.resource_type}.${event.action}) failed:`, err);
    }
  }
}

type GcEvent = { id?: string; resource_type?: string; action?: string; links?: { payment?: string; mandate?: string } };

async function handleEvent(
  tp: Awaited<ReturnType<typeof getTenantPrismaForSchema>>,
  event: GcEvent
): Promise<void> {
  const resourceType = event.resource_type;
  const action = event.action;

  if (resourceType === "payments") {
    const gcPaymentId = event.links?.payment;
    if (!gcPaymentId) return;

    if (action === "paid" || action === "confirmed") {
      await tp.payment.updateMany({
        where: { gocardlessId: gcPaymentId },
        data: { status: PaymentStatus.PAID, paidAt: new Date() },
      });
      const payment = await tp.payment.findFirst({ where: { gocardlessId: gcPaymentId }, select: { customerId: true } });
      if (payment?.customerId) {
        queueGhlEvent(tp, "payment.collected", payment.customerId).catch(console.error);
      }
    } else if (action === "failed") {
      await tp.payment.updateMany({
        where: { gocardlessId: gcPaymentId },
        data: { status: PaymentStatus.FAILED },
      });
    } else if (action === "cancelled") {
      await tp.payment.updateMany({
        where: { gocardlessId: gcPaymentId },
        data: { status: PaymentStatus.CANCELLED },
      });
    }
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
