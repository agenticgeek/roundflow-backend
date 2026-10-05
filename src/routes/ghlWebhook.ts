import { createHmac, timingSafeEqual } from "crypto";
import { Router, Request, Response } from "express";
import { prisma } from "../lib/prisma";
import { getTenantPrismaForSchema } from "../lib/tenant-prisma-manager";
import { MessageChannel, MessageDirection } from "../generated/tenant-client";

export const ghlWebhookRouter = Router();

ghlWebhookRouter.post("/", async (req: Request, res: Response) => {
  const secret = process.env.GHL_WEBHOOK_SECRET;
  if (!secret) { res.sendStatus(200); return; }

  const sig = req.headers["x-ghl-signature"] as string | undefined;
  if (!sig) { res.status(401).json({ error: "Missing signature" }); return; }

  const computed = createHmac("sha256", secret)
    .update(req.body as Buffer)
    .digest("hex");
  try {
    if (!timingSafeEqual(Buffer.from(computed), Buffer.from(sig))) {
      res.status(401).json({ error: "Invalid signature" });
      return;
    }
  } catch {
    res.status(401).json({ error: "Invalid signature" });
    return;
  }

  let payload: GhlEvent;
  try {
    payload = JSON.parse((req.body as Buffer).toString()) as GhlEvent;
  } catch {
    res.status(400).json({ error: "Malformed JSON" });
    return;
  }

  const { locationId, type, id: eventId } = payload;
  if (!locationId) { res.sendStatus(200); return; }

  const tenant = await prisma.tenant.findUnique({ where: { ghlLocationId: locationId } });
  if (!tenant) { res.sendStatus(200); return; }

  // Ack immediately; process async
  res.sendStatus(200);
  processEvent(tenant.schemaName, payload, eventId).catch((err) =>
    console.error(`[ghlWebhook] ${locationId}/${type} failed:`, err)
  );
});

type GhlEvent = {
  type?: string;
  id?: string;
  locationId?: string;
  contactId?: string;
  firstName?: string;
  lastName?: string;
  phone?: string;
  email?: string;
  message?: { body?: string; type?: string };
};

async function processEvent(schemaName: string, event: GhlEvent, eventId?: string): Promise<void> {
  const tp = getTenantPrismaForSchema(schemaName);
  const { type, contactId } = event;

  // Idempotency for events that carry an id
  if (eventId) {
    try {
      await tp.webhookEvent.create({ data: { source: "ghl", externalId: eventId } });
    } catch {
      return; // already processed
    }
  }

  if (type === "ContactCreate" || type === "ContactUpdate") {
    if (!contactId) return;
    const name = [event.firstName, event.lastName].filter(Boolean).join(" ") || undefined;
    await tp.customer.updateMany({
      where: { ghlContactId: contactId },
      data: {
        ...(name ? { name } : {}),
        ...(event.phone ? { phone: event.phone } : {}),
        ...(event.email ? { email: event.email } : {}),
      },
    });
    return;
  }

  if (type === "InboundMessage") {
    const body = event.message?.body;
    if (!body) return;
    // Best-effort channel detection from GHL message type
    const rawChannel = (event.message?.type ?? "").toUpperCase();
    const channel: MessageChannel =
      rawChannel === "EMAIL" ? MessageChannel.EMAIL :
      rawChannel === "WHATSAPP" ? MessageChannel.WHATSAPP :
      MessageChannel.SMS;

    // Look up customer by ghlContactId for FK, fall back to no link
    let customerId: string | undefined;
    if (contactId) {
      const customer = await tp.customer.findFirst({
        where: { ghlContactId: contactId },
        select: { id: true },
      });
      customerId = customer?.id ?? undefined;
    }

    await tp.message.create({
      data: {
        channel,
        direction: MessageDirection.INBOUND,
        body,
        ...(customerId ? { customerId } : {}),
        sentAt: new Date(),
      },
    });
    return;
  }

  if (type === "Uninstall") {
    // Clear per-tenant GHL fields
    await tp.businessSettings.updateMany({
      data: {
        ghlConnected: false,
        ghlLocationId: null,
        ghlAccessTokenEncrypted: null,
        ghlRefreshTokenEncrypted: null,
        ghlTokenExpiresAt: null,
      },
    });
    // Clear global tenant lookup key
    await prisma.tenant.updateMany({
      where: { schemaName },
      data: { ghlLocationId: null },
    });
    return;
  }
}
