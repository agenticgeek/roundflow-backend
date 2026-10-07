import { timingSafeEqual } from "crypto";
import { Router, Request, Response } from "express";
import { prisma } from "../lib/prisma";
import { getTenantPrismaForSchema } from "../lib/tenant-prisma-manager";
import { decrypt } from "../lib/crypto";
import { MessageChannel, MessageDirection } from "../generated/tenant-client";

export const ghlWebhookRouter = Router();

ghlWebhookRouter.post("/", async (req: Request, res: Response) => {
  const tenantId = req.query.tenantId as string | undefined;
  const secret   = req.query.secret   as string | undefined;

  if (!tenantId || !secret) {
    res.status(401).json({ error: "Missing tenantId or secret" });
    return;
  }

  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { schemaName: true } });
  if (!tenant) { res.sendStatus(401); return; }

  const tp = getTenantPrismaForSchema(tenant.schemaName);
  const bs = await tp.businessSettings.findFirst({ select: { ghlWebhookSecretEncrypted: true } });
  if (!bs?.ghlWebhookSecretEncrypted) { res.sendStatus(401); return; }

  const expected = decrypt(bs.ghlWebhookSecretEncrypted);
  try {
    if (!timingSafeEqual(Buffer.from(secret), Buffer.from(expected))) {
      res.sendStatus(401); return;
    }
  } catch {
    res.sendStatus(401); return;
  }

  let payload: GhlEvent;
  try {
    payload = JSON.parse((req.body as Buffer).toString()) as GhlEvent;
  } catch {
    res.status(400).json({ error: "Malformed JSON" }); return;
  }

  // Ack immediately; process async
  res.sendStatus(200);
  processEvent(tenant.schemaName, payload, payload.id).catch((err) =>
    console.error(`[ghlWebhook] ${tenantId}/${payload.type} failed:`, err)
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

  // ContactCreate / ContactUpdate — RoundFlow is master; never overwrite operational data.
  // Inbound contact events are a no-op until the "ready-for-roundflow" tag flow is set up
  // by the GHL automation owner to create new customers from tagged leads.
  if (type === "ContactCreate" || type === "ContactUpdate") {
    return;
  }

  if (type === "InboundMessage") {
    const body = event.message?.body;
    if (!body) return;
    const rawChannel = (event.message?.type ?? "").toUpperCase();
    const channel: MessageChannel =
      rawChannel === "EMAIL" ? MessageChannel.EMAIL :
      rawChannel === "WHATSAPP" ? MessageChannel.WHATSAPP :
      MessageChannel.SMS;

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
    await tp.businessSettings.updateMany({
      data: {
        ghlConnected:                false,
        ghlLocationId:               null,
        ghlAccessTokenEncrypted:     null,
        ghlRefreshTokenEncrypted:    null,
        ghlTokenExpiresAt:           null,
        ghlWebhookSecretEncrypted:   null,
      },
    });
    await prisma.tenant.updateMany({
      where: { schemaName },
      data: { ghlLocationId: null },
    });
    return;
  }
}
