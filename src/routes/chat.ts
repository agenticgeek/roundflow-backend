import { Request, Router } from "express";
import { requireAuth } from "../middleware/requireAuth";
import { requireTenantAccess } from "../middleware/requireTenantAccess";
import { requireBusinessAccess } from "../middleware/requireRole";
import { AppError } from "../lib/app-error";
import { asObject, h, optString, optStringArray } from "../lib/http";
import {
  assertChatPhotoUrls,
  createChatAdminService,
  parseChatListQuery,
  parseChatText,
  parseClientMsgId,
} from "../services/chat.service";
import { tenantToday } from "../services/business-time";
import { signChatRows } from "../mobile/media-urls";

// Office side of the round chat (one thread per round). ADMIN/MANAGER only:
// technicians use /mobile/chat/* and get 403 here. Polling-based.
export const chatRouter = Router();
chatRouter.use(requireAuth);
chatRouter.use(requireTenantAccess);
chatRouter.use(requireBusinessAccess());

const svc = (req: Request) => {
  if (!req.tenantPrisma) throw new AppError(500, "Tenant client not initialised");
  return createChatAdminService(req.tenantPrisma);
};
const viewer = (req: Request) => ({ profileId: req.profile!.id, supabaseUserId: req.user?.supabaseUserId });

// GET /chat/threads -> { threads: [{ roundId, roundName, technicians: [{ id, name, active }],
//   lastMessage: { id, type, body, senderRole, senderProfileId, createdAt } | null, unreadCount }] }
// Rounds that have at least one message, most recent activity first.
chatRouter.get(
  "/threads",
  h(async (req, res) => {
    res.json(await svc(req).listThreads(viewer(req)));
  })
);

// GET /chat/unread-count -> { total, rounds: [{ roundId, unread }] } (rounds with unread > 0)
// Registered before the :roundId routes; "unread-count" can never be a round id here.
chatRouter.get(
  "/unread-count",
  h(async (req, res) => {
    res.json(await svc(req).unreadCount(viewer(req)));
  })
);

// GET /chat/rounds/:roundId/messages?since=ISO&before=ISO&limit=1..200 (default 100)
//   -> { messages: [{ id, roundId, senderProfileId, senderRole: "TECHNICIAN"|"OFFICE", senderName,
//        body, type, visitId, photoUrls, photoSignedUrls, clientMsgId, createdAt, isMine }], hasMore }
// Oldest first. since = poll for newer messages (ascending from that point);
// without since = the newest `limit` messages, or those older than `before` (older pages).
// 404 unknown round · 400 invalid since/before/limit (or both since and before).
chatRouter.get(
  "/rounds/:roundId/messages",
  h(async (req, res) => {
    const opts = parseChatListQuery(req.query as Record<string, unknown>);
    const { messages, hasMore } = await svc(req).listMessages(req.params.roundId, viewer(req), opts);
    res.json({ messages: await signChatRows(req.profile!.tenantId, messages), hasMore });
  })
);

// POST /chat/rounds/:roundId/messages { text?, photoUrls?, clientMsgId? }
//   text: 1..2000 chars (required unless photoUrls is given); photoUrls: storage paths from
//   a chat attachment upload for this round (max 10); clientMsgId: client-generated id
//   (max 100) — a repeat returns the existing message with 200 instead of posting twice.
//   -> 201 (200 on duplicate) the message as above. senderRole is always OFFICE; the round's
//   technicians get an in-app notification (+ push when they have a registered device).
chatRouter.post(
  "/rounds/:roundId/messages",
  h(async (req, res) => {
    const body = asObject(req.body);
    const photoUrls = optStringArray(body.photoUrls, "photoUrls") ?? [];
    assertChatPhotoUrls(photoUrls, req.profile!.tenantId, req.params.roundId);
    const rawText = optString(body.text, "text");
    const hasText = rawText !== undefined && rawText !== null && rawText !== "";
    const text = photoUrls.length > 0 && !hasText ? null : parseChatText(rawText);
    const { message, duplicate } = await svc(req).send(
      req.params.roundId,
      { profileId: req.profile!.id, name: req.profile!.name },
      { text, photoUrls, clientMsgId: parseClientMsgId(body.clientMsgId) },
      await tenantToday(req.tenantPrisma!)
    );
    const [signed] = await signChatRows(req.profile!.tenantId, [message]);
    res.status(duplicate ? 200 : 201).json(signed);
  })
);

// POST /chat/rounds/:roundId/read -> { roundId, lastReadAt }
// Marks the thread read for the signed-in office user (unread counts are per user).
chatRouter.post(
  "/rounds/:roundId/read",
  h(async (req, res) => {
    res.json(await svc(req).markRead(req.params.roundId, viewer(req)));
  })
);
