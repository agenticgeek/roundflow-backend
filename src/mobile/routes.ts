import { Router, Request } from "express";
import { requireAuth } from "../middleware/requireAuth";
import { requireTenantAccess } from "../middleware/requireTenantAccess";
import { AppError } from "../lib/app-error";
import { asObject, h, requireString, optString, optBool } from "../lib/http";
import { IssueType, PaymentMethod, PaymentStatus, VisitStatus } from "../generated/tenant-client";
import { ALLOWED_PHOTO_MIME_TYPES, MAX_PHOTO_BYTES } from "../lib/storage.js";
import { createHomeService } from "./services/home.service";
import { createJobDetailService } from "./services/job-detail.service";
import { createJobTrackerService } from "./services/job-tracker.service";
import { createMediaService } from "./services/media.service";
import { createChatService } from "./services/chat.service";

export const mobileRouter = Router();
mobileRouter.use(requireAuth);
mobileRouter.use(requireTenantAccess);

const tp = (req: Request) => {
  if (!req.tenantPrisma) throw new AppError(500, "Tenant client not initialised");
  return req.tenantPrisma;
};
const home    = (req: Request) => createHomeService(tp(req));
const detail  = (req: Request) => createJobDetailService(tp(req));
const tracker = (req: Request) => createJobTrackerService(tp(req));
const media   = (req: Request) => createMediaService(tp(req));
const chat    = (req: Request) => createChatService(tp(req));

// GET /mobile/rounds/today
mobileRouter.get("/rounds/today", h(async (req, res) => {
  res.json(await home(req).getRoundsSummary(req.user!.supabaseUserId));
}));

// GET /mobile/visits/today
mobileRouter.get("/visits/today", h(async (req, res) => {
  res.json(await home(req).getTodayVisits(req.user!.supabaseUserId));
}));

// GET /mobile/completions
mobileRouter.get("/completions", h(async (req, res) => {
  res.json(await home(req).getCompletions(req.user!.supabaseUserId));
}));

// GET /mobile/visits/:id
mobileRouter.get("/visits/:id", h(async (req, res) => {
  res.json(await detail(req).getVisitDetail(req.params.id));
}));

// PATCH /mobile/visits/:id/start
mobileRouter.patch("/visits/:id/start", h(async (req, res) => {
  await tracker(req).startVisit(req.params.id, req.user!.supabaseUserId);
  res.json({ status: "IN_PROGRESS" });
}));

// PATCH /mobile/visits/:id/arrive
mobileRouter.patch("/visits/:id/arrive", h(async (req, res) => {
  await tracker(req).markArrived(req.params.id);
  res.json({ status: "IN_PROGRESS" });
}));

// PATCH /mobile/visits/:id/skip
mobileRouter.patch("/visits/:id/skip", h(async (req, res) => {
  const body = asObject(req.body);
  const reason = requireString(body.reason, "reason");
  const description = optString(body.description, "description");
  await tracker(req).skipVisit(req.params.id, reason, description ?? undefined);
  res.json({ status: "SKIPPED" });
}));

// PATCH /mobile/visits/:id/price
mobileRouter.patch("/visits/:id/price", h(async (req, res) => {
  const body = asObject(req.body);
  const price = Number(requireString(String(body.price ?? ""), "price"));
  if (isNaN(price)) throw new AppError(400, "price must be a number");
  await tracker(req).adjustPrice(req.params.id, price);
  res.json({ adjusted: true });
}));

// POST /mobile/visits/:id/access-issues
mobileRouter.post("/visits/:id/access-issues", h(async (req, res) => {
  const body = asObject(req.body);
  const type = requireString(body.type, "type") as IssueType;
  if (!Object.values(IssueType).includes(type)) {
    throw new AppError(400, `type must be one of: ${Object.values(IssueType).join(", ")}`);
  }
  await tracker(req).reportAccessIssue(req.params.id, type, requireString(body.description, "description"));
  res.status(201).json({ recorded: true });
}));

// POST /mobile/visits/:id/notes
mobileRouter.post("/visits/:id/notes", h(async (req, res) => {
  const body = asObject(req.body);
  await media(req).addVisitNote(req.params.id, requireString(body.text, "text"));
  res.status(201).json({ recorded: true });
}));

// POST /mobile/visits/:id/photos/upload-url
mobileRouter.post("/visits/:id/photos/upload-url", h(async (req, res) => {
  const body = asObject(req.body);
  const type = requireString(body.type, "type");
  if (type !== "BEFORE" && type !== "AFTER") throw new AppError(400, 'type must be "BEFORE" or "AFTER"');
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
mobileRouter.post("/visits/:id/photos", h(async (req, res) => {
  const body = asObject(req.body);
  const type = requireString(body.type, "type");
  if (type !== "BEFORE" && type !== "AFTER") throw new AppError(400, 'type must be "BEFORE" or "AFTER"');
  await media(req).addVisitPhoto(req.params.id, requireString(body.url, "url"), type);
  res.status(201).json({ recorded: true });
}));

// POST /mobile/visits/:id/debt-payment
mobileRouter.post("/visits/:id/debt-payment", h(async (req, res) => {
  const body = asObject(req.body);
  if (!(optBool(body.cashConfirmed, "cashConfirmed") ?? false)) throw new AppError(400, "cashConfirmed is required");
  res.json(await detail(req).collectDebtPayment(req.params.id));
}));

// GET /mobile/chat/messages?roundId=X[&since=ISO]
mobileRouter.get("/chat/messages", h(async (req, res) => {
  const roundId = requireString(req.query.roundId as string | undefined, "roundId");
  const sinceStr = req.query.since as string | undefined;
  const since = sinceStr ? new Date(sinceStr) : undefined;
  if (since && isNaN(since.getTime())) throw new AppError(400, "since must be a valid ISO date");
  res.json(await chat(req).getChatMessages(roundId, since));
}));

// POST /mobile/chat/messages
mobileRouter.post("/chat/messages", h(async (req, res) => {
  const body = asObject(req.body);
  const roundId = requireString(body.roundId, "roundId");
  const type = optString(body.type, "type") ?? "TEXT";
  if (type === "WORK_PHOTOS") {
    const msg = await chat(req).sendWorkPhotosMessage(roundId, req.user!.supabaseUserId, requireString(body.visitId, "visitId"));
    return res.status(201).json(msg);
  }
  if (type !== "TEXT") throw new AppError(400, 'type must be "TEXT" or "WORK_PHOTOS"');
  res.status(201).json(await chat(req).sendChatMessage(roundId, req.user!.supabaseUserId, requireString(body.text, "text")));
}));

// PATCH /mobile/visits/:id/complete
mobileRouter.patch("/visits/:id/complete", h(async (req, res) => {
  const body = asObject(req.body);
  const cashConfirmed = optBool(body.cashConfirmed, "cashConfirmed") ?? false;
  const prisma = tp(req);

  const visit = await prisma.visit.findUnique({
    where: { id: req.params.id },
    include: { property: { include: { customer: true } }, servicePlan: true, payment: true },
  });
  if (!visit) throw new AppError(404, "Visit not found");
  if (visit.status === VisitStatus.COMPLETED) return res.json({ id: visit.id, status: visit.status });
  if (visit.status === VisitStatus.SKIPPED) throw new AppError(409, "Cannot complete a skipped visit");

  const effectiveMethod =
    (visit.paymentMethod ?? visit.servicePlan?.paymentMethod ?? visit.property.customer.paymentMethod) as PaymentMethod | null;

  const updated = await prisma.visit.update({
    where: { id: visit.id },
    data: { status: VisitStatus.COMPLETED, completedAt: new Date() },
  });

  const customerId = visit.property.customer.id;
  const amountPence = Math.round(visit.price.toNumber() * 100);

  if (!visit.payment) {
    if (effectiveMethod === PaymentMethod.GOCARDLESS) {
      const customer = visit.property.customer;
      if (customer.gocardlessMandateId && customer.gocardlessMandateStatus === "active") {
        const bs = await prisma.businessSettings.findFirst({
          select: { gocardlessAccessTokenEncrypted: true, gocardlessEnvironment: true },
        });
        if (bs?.gocardlessAccessTokenEncrypted) {
          const { decrypt } = await import("../lib/crypto.js");
          const { getGcClient } = await import("../integrations/gocardless/client.js");
          const { createGcPayment } = await import("../integrations/gocardless/payment.js");
          const client = getGcClient(decrypt(bs.gocardlessAccessTokenEncrypted), bs.gocardlessEnvironment ?? "sandbox");
          const gcPayment = await createGcPayment(client, {
            mandateId: customer.gocardlessMandateId,
            amountPence,
            description: `Window cleaning — visit ${visit.id}`,
            reference: visit.id.slice(-8).toUpperCase(),
            metadata: { visitId: visit.id, customerId },
          });
          await prisma.payment.create({
            data: { customerId, visitId: visit.id, amount: visit.price, method: PaymentMethod.GOCARDLESS, status: PaymentStatus.PENDING, gocardlessId: gcPayment.id },
          });
        }
      }
    } else if (effectiveMethod === PaymentMethod.CASH) {
      if (!cashConfirmed) throw new AppError(400, "cashConfirmed is required for cash payments");
      await prisma.payment.create({
        data: { customerId, visitId: visit.id, amount: visit.price, method: PaymentMethod.CASH, status: PaymentStatus.PAID, paidAt: new Date() },
      });
    } else if (effectiveMethod === PaymentMethod.BACS || effectiveMethod === PaymentMethod.CHEQUE) {
      await prisma.payment.create({
        data: { customerId, visitId: visit.id, amount: visit.price, method: effectiveMethod, status: PaymentStatus.PENDING },
      });
    }
  }

  return res.json({ id: updated.id, status: updated.status });
}));
