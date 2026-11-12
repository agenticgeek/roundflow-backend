import { Request, Response, Router } from "express";
import { prisma } from "../lib/prisma";
import { guardWebhook } from "../lib/webhook-guard";
import { getTenantPrismaForSchema, type TenantPrismaClient } from "../lib/tenant-prisma-manager";
import { confirmSubscription, verifySnsMessage, type SnsMessage } from "../lib/mailer/sns";
import { applySesEvent, parseSesEvent } from "../services/email-events.service";
import { processWebhookEvent } from "../services/webhook-events.service";

// POST /webhooks/ses: Amazon SNS delivering SES events (configuration set -> SNS topic -> this URL).
// Unauthenticated by design: the SNS signature (and optionally SES_SNS_TOPIC_ARN) is the authentication.
export const sesWebhookRouter = Router();

sesWebhookRouter.post("/", guardWebhook("sesWebhook", async (req: Request, res: Response) => {
  let msg: SnsMessage;
  try {
    msg = JSON.parse((req.body as Buffer).toString()) as SnsMessage;
  } catch {
    res.status(400).json({ error: "Malformed JSON" });
    return;
  }
  const topic = process.env.SES_SNS_TOPIC_ARN?.trim();
  if (!(await verifySnsMessage(msg, { expectedTopicArn: topic || undefined }))) {
    res.sendStatus(403);
    return;
  }

  if (msg.Type === "SubscriptionConfirmation") {
    try {
      await confirmSubscription(msg);
    } catch (err) {
      console.error("[sesWebhook] subscription confirmation failed:", (err as Error).message);
      res.sendStatus(500);
      return;
    }
    res.sendStatus(200);
    return;
  }
  if (msg.Type !== "Notification") {
    res.sendStatus(200);
    return;
  }

  let payload: unknown;
  try {
    payload = JSON.parse(msg.Message);
  } catch {
    res.sendStatus(200);
    return;
  }
  const event = parseSesEvent(payload);
  if (!event?.tenantId) {
    res.sendStatus(200);
    return;
  }
  const tenant = await prisma.tenant.findUnique({ where: { id: event.tenantId }, select: { schemaName: true } });
  if (!tenant) {
    res.sendStatus(200);
    return;
  }
  const tp = getTenantPrismaForSchema(tenant.schemaName);
  // Idempotent via the WebhookEvent status machine (BE-03): SNS retries and redeliveries never double-count.
  const outcome = await processWebhookEvent(tp, "ses", msg.MessageId, payload, () => applySesEvent(tp, event));
  res.sendStatus(outcome === "failed" ? 500 : 200);
}));

/** Replays a stored event (webhook retry sweep). */
export async function handleSesPayload(tp: TenantPrismaClient, payload: unknown): Promise<void> {
  const event = parseSesEvent(payload);
  if (event) await applySesEvent(tp, event);
}
