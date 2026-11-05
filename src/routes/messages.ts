import { Request, Router } from "express";
import { requireAuth } from "../middleware/requireAuth";
import { requireTenantAccess } from "../middleware/requireTenantAccess";
import { requireBusinessAccess } from "../middleware/requireRole";
import { h, asObject, requireString, optId, optBool, optStringArray, parsePageParams } from "../lib/http";
import { AppError } from "../lib/app-error";
import { createMessageService, optOutboundChannel } from "../services/message.service";

export const messagesRouter = Router();
messagesRouter.use(requireAuth);
messagesRouter.use(requireTenantAccess);
messagesRouter.use(requireBusinessAccess());

const svc = (req: Request) => createMessageService(req.tenantPrisma!);

// POST /messages/send — send one SMS/email/WhatsApp to a single customer.
// channel omitted (or "AUTO") = SMS when the customer has a mobile, else EMAIL.
// 400 NO_CONTACT_FOR_CHANNEL · 409 GHL_NOT_CONNECTED · 502 GHL_SEND_FAILED.
messagesRouter.post(
  "/send",
  h(async (req, res) => {
    const b = asObject(req.body);
    const result = await svc(req).send({
      propertyId: optId(b.propertyId, "propertyId") ?? undefined,
      customerId: optId(b.customerId, "customerId") ?? undefined,
      channel: optOutboundChannel(b.channel),
      body: requireString(b.body, "body"),
    });
    res.status(201).json(result);
  })
);

// GET /messages/inbox?customerId=&unreadOnly=true&page=&pageSize=
//   -> { rows: [{ id, customerId, customerName, channel, body, receivedAt, unread }],
//        unreadCount, pagination: { page, pageSize, total, totalPages } }
// Inbound customer replies (stored by the GHL webhook), newest first. unreadCount =
// unread replies within the same filter (customerId); unreadOnly=true lists only those.
messagesRouter.get(
  "/inbox",
  h(async (req, res) => {
    const { page, pageSize } = parsePageParams(req.query as Record<string, unknown>, { defaultPageSize: 50, maxPageSize: 100 });
    const customerId = typeof req.query.customerId === "string" && req.query.customerId ? req.query.customerId : undefined;
    res.json(await svc(req).listInbox({ customerId, unreadOnly: req.query.unreadOnly === "true", page, pageSize }));
  })
);

// POST /messages/inbox/read { ids?: string[], customerId?: string } -> { updated }
// Marks inbound replies read (the given ids, or all unread ones of the customer). 400 when neither is sent.
messagesRouter.post(
  "/inbox/read",
  h(async (req, res) => {
    const b = asObject(req.body);
    res.json(await svc(req).markInboxRead({ ids: optStringArray(b.ids, "ids"), customerId: optId(b.customerId, "customerId") ?? undefined }));
  })
);

const MAX_SCHEDULE_AHEAD_DAYS = 90;

// Optional future ISO timestamp (within 90 days) a broadcast is queued for.
function optScheduledFor(v: unknown): Date | undefined {
  if (v === undefined || v === null) return undefined;
  const at = typeof v === "string" ? new Date(v) : null;
  if (!at || Number.isNaN(at.getTime())) throw new AppError(400, '"scheduledFor" must be an ISO date-time');
  const now = Date.now();
  if (at.getTime() <= now) throw new AppError(400, '"scheduledFor" must be in the future');
  if (at.getTime() > now + MAX_SCHEDULE_AHEAD_DAYS * 86_400_000) {
    throw new AppError(400, `"scheduledFor" must be within ${MAX_SCHEDULE_AHEAD_DAYS} days`);
  }
  return at;
}

// GET /messages/bulk/recipients?roundId=&channel=sms&excludePaymentHold=true
//   -> { total, reachable, recipients: [{ customerId, customerName, address, status: ok|opted_out|no_contact }] }
// The server-confirmed audience of a round broadcast (read-only; GHL need not be connected).
messagesRouter.get(
  "/bulk/recipients",
  h(async (req, res) => {
    const q = req.query as Record<string, unknown>;
    res.json(
      await svc(req).listRoundRecipients({
        roundId: requireString(q.roundId, "roundId"),
        channel: typeof q.channel === "string" && q.channel ? q.channel : undefined,
        excludePaymentHold: q.excludePaymentHold === "true",
      })
    );
  })
);

// POST /messages/bulk — broadcast one message to every customer in a round, now
// or at `scheduledFor`. `customerIds` (optional) narrows it to those recipients — each must be
// one of the round's recipients (400 UNKNOWN_RECIPIENT). {{variables}} are rendered per customer; opted-out
// customers are skipped. -> { queued, sent, scheduled, skippedOptedOut,
// skippedNoContact, failed, scheduledFor, recipients: [{ customerId,
// customerName, status, channel?, error? }] }
messagesRouter.post(
  "/bulk",
  h(async (req, res) => {
    const b = asObject(req.body);
    const result = await svc(req).sendToRound({
      roundId: requireString(b.roundId, "roundId"),
      channel: requireString(b.channel, "channel"),
      body: requireString(b.body, "body"),
      excludePaymentHold: optBool(b.excludePaymentHold, "excludePaymentHold") ?? false,
      customerIds: optStringArray(b.customerIds, "customerIds"),
      templateId: optId(b.templateId, "templateId") ?? null,
      scheduledFor: optScheduledFor(b.scheduledFor),
    });
    res.status(201).json(result);
  })
);
