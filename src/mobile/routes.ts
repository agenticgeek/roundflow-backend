import { Router, Request } from "express";
import { requireAuth } from "../middleware/requireAuth";
import { requireTenantAccess } from "../middleware/requireTenantAccess";
import { prisma } from "../lib/prisma";
import { AppError } from "../lib/app-error";
import { asObject, h, requireString, requireNumber, optString, optReqString, optStringArray, optBool } from "../lib/http";
import { IssueType } from "../generated/tenant-client";
import { ALLOWED_PHOTO_MIME_TYPES, MAX_PHOTO_BYTES } from "../lib/storage.js";
import { createHomeService } from "./services/home.service";
import { createJobDetailService } from "./services/job-detail.service";
import { createJobTrackerService } from "./services/job-tracker.service";
import { createMediaService } from "./services/media.service";
import { createChatService } from "./services/chat.service";
import { createNotificationService } from "./services/notification.service";
import { createUpsellService } from "./services/upsell.service";
import { createVisitCompletionService, parseCompletionPayment } from "../services/visit-completion";
import { requireTechnician, requireVisitOwner, assertRoundMember, assertVisitOwner } from "./ownership";
import { idempotency } from "./idempotency";
import { signAvatar, signChatRows, signPhotos } from "./media-urls";

export const mobileRouter = Router();
mobileRouter.use(requireAuth);
mobileRouter.use(requireTenantAccess);
// D-3: TECHNICIAN role + a linked Technician row (sets req.technician).
mobileRouter.use(requireTechnician);

// Every /mobile/visits/:id/* write: offline-replay dedup, then ownership (A8).
const visitWrite = [idempotency(), requireVisitOwner];

const tp = (req: Request) => {
  if (!req.tenantPrisma) throw new AppError(500, "Tenant client not initialised");
  return req.tenantPrisma;
};
const home    = (req: Request) => createHomeService(tp(req));
const detail  = (req: Request) => createJobDetailService(tp(req));
const tracker = (req: Request) => createJobTrackerService(tp(req));
const media   = (req: Request) => createMediaService(tp(req));
const chat    = (req: Request) => createChatService(tp(req));
const notif   = (req: Request) => createNotificationService(tp(req));
const upsells = (req: Request) => createUpsellService(tp(req));

// Build the GET/PATCH /mobile/me response (public Profile name/DOB + tenant Technician avatar/area).
async function meResponse(req: Request) {
  const profile = await prisma.profile.findUnique({
    where: { supabaseUserId: req.user!.supabaseUserId },
    select: { name: true, dateOfBirth: true },
  });
  const tech = await tp(req).technician.findUnique({
    where: { profileId: req.profile!.id },
    select: { avatarUrl: true, serviceAreas: { select: { serviceArea: { select: { name: true } } }, take: 1 } },
  });
  return {
    name: profile?.name ?? req.profile!.name,
    email: req.user!.email,
    dateOfBirth: profile?.dateOfBirth ?? null,
    avatarUrl: tech?.avatarUrl ?? null,
    // Signed read url (1 h) for displaying the avatar; avatarUrl stays the stored path.
    avatarSignedUrl: await signAvatar(req.profile!.tenantId, tech?.avatarUrl ?? null),
    areaName: tech?.serviceAreas[0]?.serviceArea.name ?? null,
  };
}

function assertMime(mimeType: string) {
  if (!(ALLOWED_PHOTO_MIME_TYPES as readonly string[]).includes(mimeType)) {
    throw new AppError(400, `mimeType must be one of: ${ALLOWED_PHOTO_MIME_TYPES.join(", ")}`);
  }
}

const PROFILE_NAME_MAX_LENGTH = 100;

function assertValidDateOfBirth(dateOfBirth: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateOfBirth)) {
    throw new AppError(400, "dateOfBirth must be in YYYY-MM-DD format");
  }
  const [year, month, day] = dateOfBirth.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  const roundTrips =
    parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;
  if (!roundTrips) {
    throw new AppError(400, "dateOfBirth must be a valid calendar date");
  }
  if (year < 1900 || parsed.getTime() > Date.now()) {
    throw new AppError(400, "dateOfBirth must be between 1900-01-01 and today");
  }
}

// GET /mobile/me — the signed-in technician's profile (name, DOB, avatar, area).
mobileRouter.get("/me", h(async (req, res) => {
  res.json(await meResponse(req));
}));

// PATCH /mobile/me — update name / date of birth / avatar.
mobileRouter.patch("/me", h(async (req, res) => {
  const body = asObject(req.body);
  const name = optReqString(body.name, "name");
  const dateOfBirth = optString(body.dateOfBirth, "dateOfBirth");
  const avatarUrl = optString(body.avatarUrl, "avatarUrl");
  if (name !== undefined && name.length > PROFILE_NAME_MAX_LENGTH) {
    throw new AppError(400, `"name" must be at most ${PROFILE_NAME_MAX_LENGTH} characters.`);
  }
  if (dateOfBirth) {
    assertValidDateOfBirth(dateOfBirth);
  }
  if (name !== undefined || dateOfBirth !== undefined) {
    await prisma.profile.update({
      where: { supabaseUserId: req.user!.supabaseUserId },
      data: { ...(name !== undefined ? { name } : {}), ...(dateOfBirth !== undefined ? { dateOfBirth } : {}) },
    });
  }
  if (avatarUrl !== undefined) {
    await tp(req).technician.updateMany({ where: { profileId: req.profile!.id }, data: { avatarUrl } });
  }
  res.json(await meResponse(req));
}));

// POST /mobile/me/avatar/upload-url — signed URL to upload a profile photo.
mobileRouter.post("/me/avatar/upload-url", h(async (req, res) => {
  const mimeType = optString(asObject(req.body).mimeType, "mimeType") ?? "image/jpeg";
  assertMime(mimeType);
  res.json(await media(req).getAvatarUploadUrl(req.profile!.id, mimeType, req.profile!.tenantId));
}));

// POST /mobile/messages/attachments/upload-url — signed URL for a chat image.
mobileRouter.post("/messages/attachments/upload-url", h(async (req, res) => {
  const body = asObject(req.body);
  const roundId = requireString(body.roundId, "roundId");
  const mimeType = optString(body.mimeType, "mimeType") ?? "image/jpeg";
  assertMime(mimeType);
  await assertRoundMember(tp(req), roundId, req.technician!.id);
  res.json(await media(req).getChatAttachmentUploadUrl(roundId, mimeType, req.profile!.tenantId));
}));

// GET /mobile/notifications?cursor=
mobileRouter.get("/notifications", h(async (req, res) => {
  const cursor = (req.query.cursor as string | undefined) || undefined;
  res.json(await notif(req).list(req.profile!.id, cursor));
}));

// PATCH /mobile/notifications/:id/read
mobileRouter.patch("/notifications/:id/read", h(async (req, res) => {
  await notif(req).markRead(req.profile!.id, req.params.id);
  res.json({ read: true });
}));

// POST /mobile/notifications/read-all
mobileRouter.post("/notifications/read-all", h(async (req, res) => {
  await notif(req).markAllRead(req.profile!.id);
  res.json({ read: true });
}));

// POST /mobile/devices — register a push token.
mobileRouter.post("/devices", h(async (req, res) => {
  const body = asObject(req.body);
  const pushToken = requireString(body.pushToken, "pushToken");
  const platform = requireString(body.platform, "platform");
  if (platform !== "ios" && platform !== "android") throw new AppError(400, 'platform must be "ios" or "android"');
  await notif(req).registerDevice(req.profile!.id, pushToken, platform);
  res.status(201).json({ registered: true });
}));

// DELETE /mobile/devices/:token — deregister on sign-out.
mobileRouter.delete("/devices/:token", h(async (req, res) => {
  await notif(req).unregisterDevice(req.profile!.id, req.params.token);
  res.json({ unregistered: true });
}));

// GET /mobile/company — Help & Support contact details + policy links.
mobileRouter.get("/company", h(async (req, res) => {
  const bs = await tp(req).businessSettings.findFirst({
    select: { businessName: true, phone: true, email: true, termsUrl: true, privacyUrl: true },
  });
  res.json({
    name: bs?.businessName ?? null,
    phone: bs?.phone ?? null,
    email: bs?.email ?? null,
    termsUrl: bs?.termsUrl ?? null,
    privacyUrl: bs?.privacyUrl ?? null,
  });
}));

// POST /mobile/support/reports — "Report a problem".
mobileRouter.post("/support/reports", h(async (req, res) => {
  const body = asObject(req.body);
  const description = requireString(body.description, "description");
  const appVersion = optString(body.appVersion, "appVersion");
  const device = optString(body.device, "device");
  const report = await tp(req).supportReport.create({
    data: { profileId: req.profile!.id, description, appVersion: appVersion ?? null, device: device ?? null },
  });
  res.status(201).json({ id: report.id, createdAt: report.createdAt });
}));

// GET /mobile/rounds/today
mobileRouter.get("/rounds/today", h(async (req, res) => {
  res.json(await home(req).getRoundsSummary(req.profile!.id));
}));

// GET /mobile/visits/today
mobileRouter.get("/visits/today", h(async (req, res) => {
  res.json(await home(req).getTodayVisits(req.profile!.id));
}));

// GET /mobile/completions
mobileRouter.get("/completions", h(async (req, res) => {
  res.json(await home(req).getCompletions(req.profile!.id));
}));

// GET /mobile/visits/:id
mobileRouter.get("/visits/:id", requireVisitOwner, h(async (req, res) => {
  const visit = await detail(req).getVisitDetail(req.params.id);
  res.json({ ...visit, photos: await signPhotos(req.profile!.tenantId, visit.photos) });
}));

// PATCH /mobile/visits/:id/start
mobileRouter.patch("/visits/:id/start", ...visitWrite, h(async (req, res) => {
  await tracker(req).startVisit(req.params.id, req.user!.supabaseUserId);
  res.json({ status: "IN_PROGRESS" });
}));

// PATCH /mobile/visits/:id/arrive
mobileRouter.patch("/visits/:id/arrive", ...visitWrite, h(async (req, res) => {
  await tracker(req).markArrived(req.params.id);
  res.json({ status: "IN_PROGRESS" });
}));

// PATCH /mobile/visits/:id/skip
mobileRouter.patch("/visits/:id/skip", ...visitWrite, h(async (req, res) => {
  const body = asObject(req.body);
  const reason = requireString(body.reason, "reason");
  const description = optString(body.description, "description");
  await tracker(req).skipVisit(req.params.id, reason, description ?? undefined);
  res.json({ status: "SKIPPED" });
}));

// PATCH /mobile/visits/:id/price
mobileRouter.patch("/visits/:id/price", ...visitWrite, h(async (req, res) => {
  const body = asObject(req.body);
  const price = Number(requireString(String(body.price ?? ""), "price"));
  if (isNaN(price)) throw new AppError(400, "price must be a number");
  const reason = optString(body.reason, "reason");
  await tracker(req).adjustPrice(req.params.id, price, reason ?? undefined);
  res.json({ adjusted: true });
}));

const MAX_ACCESS_ISSUE_PHOTOS = 10;

// POST /mobile/visits/:id/access-issues
// Optional photoPaths: storage paths from POST /photos/upload-url with type
// ACCESS_ISSUE — must be this visit's objects ("<tenant>/visits/<visit>/...").
mobileRouter.post("/visits/:id/access-issues", ...visitWrite, h(async (req, res) => {
  const body = asObject(req.body);
  const type = requireString(body.type, "type") as IssueType;
  if (!Object.values(IssueType).includes(type)) {
    throw new AppError(400, `type must be one of: ${Object.values(IssueType).join(", ")}`);
  }
  const description = requireString(body.description, "description");
  const photoPaths = optStringArray(body.photoPaths, "photoPaths") ?? [];
  if (photoPaths.length > MAX_ACCESS_ISSUE_PHOTOS) {
    throw new AppError(400, `photoPaths may hold at most ${MAX_ACCESS_ISSUE_PHOTOS} items`);
  }
  const prefix = `${req.profile!.tenantId}/visits/${req.params.id}/`;
  if (photoPaths.some((p) => !p.startsWith(prefix) || p.includes(".."))) {
    throw new AppError(400, "photoPaths must be storage paths returned by this visit's photos/upload-url");
  }
  const { id } = await tracker(req).reportAccessIssue(req.params.id, type, description, photoPaths);
  res.status(201).json({ recorded: true, id, photoCount: photoPaths.length });
}));

// POST /mobile/visits/:id/notes
mobileRouter.post("/visits/:id/notes", ...visitWrite, h(async (req, res) => {
  const body = asObject(req.body);
  await media(req).addVisitNote(req.params.id, requireString(body.text, "text"));
  res.status(201).json({ recorded: true });
}));

// POST /mobile/visits/:id/photos/upload-url
// type ACCESS_ISSUE: the path is then sent in POST /access-issues photoPaths.
mobileRouter.post("/visits/:id/photos/upload-url", requireVisitOwner, h(async (req, res) => {
  const body = asObject(req.body);
  const type = requireString(body.type, "type");
  if (type !== "BEFORE" && type !== "AFTER" && type !== "ACCESS_ISSUE") {
    throw new AppError(400, 'type must be "BEFORE", "AFTER" or "ACCESS_ISSUE"');
  }
  const mimeType = optString(body.mimeType, "mimeType") ?? "image/jpeg";
  if (!(ALLOWED_PHOTO_MIME_TYPES as readonly string[]).includes(mimeType)) {
    throw new AppError(400, `mimeType must be one of: ${ALLOWED_PHOTO_MIME_TYPES.join(", ")}`);
  }
  const contentLength = body.contentLength !== undefined ? Number(body.contentLength) : null;
  if (contentLength !== null && (isNaN(contentLength) || contentLength > MAX_PHOTO_BYTES)) {
    throw new AppError(413, `File too large. Maximum size is ${MAX_PHOTO_BYTES / 1024 / 1024} MB`);
  }
  res.json(await media(req).getPhotoUploadUrl(req.params.id, type, mimeType, req.profile!.tenantId));
}));

// POST /mobile/visits/:id/photos
mobileRouter.post("/visits/:id/photos", ...visitWrite, h(async (req, res) => {
  const body = asObject(req.body);
  const type = requireString(body.type, "type");
  if (type !== "BEFORE" && type !== "AFTER") throw new AppError(400, 'type must be "BEFORE" or "AFTER"');
  // `path` (from upload-url) is accepted as an alias for `url`.
  const url = body.url !== undefined ? requireString(body.url, "url") : requireString(body.path, "path");
  await media(req).addVisitPhoto(req.params.id, url, type);
  res.status(201).json({ recorded: true });
}));

// POST /mobile/visits/:id/debt-payment
mobileRouter.post("/visits/:id/debt-payment", ...visitWrite, h(async (req, res) => {
  const body = asObject(req.body);
  const cashConfirmed = optBool(body.cashConfirmed, "cashConfirmed") ?? false;
  const method = body.method ?? (cashConfirmed ? "CASH" : undefined);
  if (method !== "CASH" && method !== "CHEQUE") {
    throw new AppError(400, 'method must be "CASH" or "CHEQUE" (or send cashConfirmed: true)', "INVALID_PAYMENT");
  }
  let chequeNumber: string | undefined;
  if (method === "CHEQUE") {
    chequeNumber = requireString(body.chequeNumber, "chequeNumber", { maxLength: 50 }).trim();
  }
  res.json(await detail(req).collectDebtPayment(req.params.id, { method, chequeNumber, actorProfileId: req.profile!.id }));
}));

// GET /mobile/chat/messages?roundId=X[&since=ISO]
mobileRouter.get("/chat/messages", h(async (req, res) => {
  const roundId = requireString(req.query.roundId as string | undefined, "roundId");
  const sinceStr = req.query.since as string | undefined;
  const since = sinceStr ? new Date(sinceStr) : undefined;
  if (since && isNaN(since.getTime())) throw new AppError(400, "since must be a valid ISO date");
  await assertRoundMember(tp(req), roundId, req.technician!.id);
  const rows = await chat(req).getChatMessages(roundId, { profileId: req.profile!.id, supabaseUserId: req.user!.supabaseUserId }, since);
  res.json(await signChatRows(req.profile!.tenantId, rows));
}));

// POST /mobile/chat/messages
mobileRouter.post("/chat/messages", h(async (req, res) => {
  const body = asObject(req.body);
  const roundId = requireString(body.roundId, "roundId");
  const type = optString(body.type, "type") ?? "TEXT";
  await assertRoundMember(tp(req), roundId, req.technician!.id);
  // D-4: senderProfileId is the public Profile id, not the Supabase user id.
  const sender = req.profile!.id;
  if (type === "WORK_PHOTOS") {
    const visitId = requireString(body.visitId, "visitId");
    await assertVisitOwner(tp(req), visitId, req.technician!.id);
    const msg = await chat(req).sendWorkPhotosMessage(roundId, sender, visitId);
    return res.status(201).json((await signChatRows(req.profile!.tenantId, [msg]))[0]);
  }
  if (type === "PHOTOS") {
    const photoUrls = optStringArray(body.photoUrls, "photoUrls") ?? [];
    if (photoUrls.length === 0) throw new AppError(400, "photoUrls must be a non-empty array for type PHOTOS");
    const text = optString(body.text, "text");
    const msg = await chat(req).sendPhotosMessage(roundId, sender, photoUrls, text ?? undefined);
    return res.status(201).json((await signChatRows(req.profile!.tenantId, [msg]))[0]);
  }
  if (type !== "TEXT") throw new AppError(400, 'type must be "TEXT", "WORK_PHOTOS", or "PHOTOS"');
  const msg = await chat(req).sendChatMessage(roundId, sender, requireString(body.text, "text"));
  res.status(201).json((await signChatRows(req.profile!.tenantId, [msg]))[0]);
}));

// PATCH /mobile/visits/:id/complete
// Body: { payment?: { method: CASH|CHEQUE|NONE, amount?, chequeNumber? }, note? }
// (cashConfirmed: true is a deprecated alias for payment.method CASH). Shares
// the web completion logic: validate first, then one transaction (D-2), and
// queues the visit.completed + "Visit completed" message outbox events (D-9/A5).
mobileRouter.patch("/visits/:id/complete", ...visitWrite, h(async (req, res) => {
  const body = asObject(req.body);
  const payment = parseCompletionPayment(body);
  const note = optString(body.note, "note", { maxLength: 2000 });
  const result = await createVisitCompletionService(tp(req)).completeVisit(req.params.id, {
    payment,
    note: note?.trim() || undefined,
    actorProfileId: req.profile!.id,
    actorRole: req.profile!.role,
  });
  res.json(result);
}));

// POST /mobile/visits/:id/upsells — record an upsell on the job (B6).
// Body: { description, amount > 0 } -> 201 { id, type: "UPSELL", amount, note, visitId, createdAt }
mobileRouter.post("/visits/:id/upsells", ...visitWrite, h(async (req, res) => {
  const body = asObject(req.body);
  const description = requireString(body.description, "description", { maxLength: 500 }).trim();
  const amount = requireNumber(body.amount, "amount");
  if (amount <= 0 || amount > 9999.99) throw new AppError(400, '"amount" must be > 0 and <= 9999.99');
  const row = await upsells(req).recordUpsell({
    visitId: req.params.id,
    technicianId: req.technician!.id,
    createdById: req.profile!.id,
    description,
    amount: Math.round(amount * 100) / 100,
  });
  res.status(201).json(row);
}));
