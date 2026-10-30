import { Request, Router } from "express";
import { requireAuth } from "../middleware/requireAuth";
import { requireTenantAccess } from "../middleware/requireTenantAccess";
import { requireBusinessAccess } from "../middleware/requireRole";
import { h, asObject, requireString, optId, optBool } from "../lib/http";
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

// POST /messages/bulk — broadcast one message to every customer in a round.
messagesRouter.post(
  "/bulk",
  h(async (req, res) => {
    const b = asObject(req.body);
    const result = await svc(req).sendToRound({
      roundId: requireString(b.roundId, "roundId"),
      channel: requireString(b.channel, "channel"),
      body: requireString(b.body, "body"),
      excludePaymentHold: optBool(b.excludePaymentHold, "excludePaymentHold") ?? false,
    });
    res.status(201).json(result); // { queued }
  })
);
