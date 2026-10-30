import { Request, Router } from "express";
import { requireAuth } from "../middleware/requireAuth";
import { requireTenantAccess } from "../middleware/requireTenantAccess";
import { requireBusinessAccess } from "../middleware/requireRole";
import { h, optString, parsePageParams } from "../lib/http";
import { optIsoDate } from "../lib/validation";
import { createDebtService } from "../services/debt.service";
import { optOutboundChannel } from "../services/message.service";
import { queueGhlEvent } from "../integrations/ghl/sync";

export const debtRouter = Router();
debtRouter.use(requireAuth);
debtRouter.use(requireTenantAccess);
debtRouter.use(requireBusinessAccess());

const svc = (req: Request) => createDebtService(req.tenantPrisma!);

// Optional free-text override of the template body ("" = use the template).
function optMessage(v: unknown): string | undefined {
  const message = optString(v, "message");
  return message?.trim() ? message : undefined;
}

// GET /debt/kpis
debtRouter.get("/kpis", h(async (req, res) => {
  const kpis = await svc(req).getKpis();
  return res.json(kpis);
}));

// GET /debt/board?bucket=&roundId=&paymentMethod=&search=&page=&pageSize=
debtRouter.get("/board", h(async (req, res) => {
  const { bucket, roundId, paymentMethod, search } = req.query as Record<string, string | undefined>;
  if (!bucket) return res.status(400).json({ error: "bucket query param is required" });
  const { page, pageSize } = parsePageParams(req.query as Record<string, unknown>, {
    defaultPageSize: 50,
    maxPageSize: 100,
  });
  const result = await svc(req).getBoard(bucket, roundId, paymentMethod, page, pageSize, search);
  return res.json(result);
}));

// GET /debt/board/counts?roundId=&paymentMethod=&search=
// All 7 bucket-tab counts in a single call, replacing the frontend's
// previous pattern of one `GET /debt/board?pageSize=1` request per tab.
debtRouter.get("/board/counts", h(async (req, res) => {
  const { roundId, paymentMethod, search } = req.query as Record<string, string | undefined>;
  const result = await svc(req).getBucketCounts(roundId, paymentMethod, search);
  return res.json(result);
}));

// GET /debt/:id — invoice detail (phone/email/round/next visit/mandate/
// recent visits) the board row doesn't carry.
debtRouter.get("/:id", h(async (req, res) => {
  const result = await svc(req).getInvoiceDetail(req.params.id);
  return res.json(result);
}));

// POST /debt/:id/remind { channel?, message? }
// 400 NO_CONTACT_FOR_CHANNEL · 409 GHL_NOT_CONNECTED · 502 GHL_SEND_FAILED
debtRouter.post("/:id/remind", h(async (req, res) => {
  const body = req.body ?? {};
  const { customerId, ...result } = await svc(req).sendReminder(req.params.id, {
    channel: optOutboundChannel(body.channel),
    message: optMessage(body.message),
  });
  queueGhlEvent(req.tenantPrisma!, "debt.overdue", customerId).catch(console.error);
  return res.json(result);
}));

// POST /debt/:id/payment-link { channel?, message? } → { url, messageId, channel, ... }
// 409 STRIPE_NOT_CONNECTED · 409 GHL_NOT_CONNECTED · 409 INVOICE_NOT_PAYABLE
// 400 NO_CONTACT_FOR_CHANNEL · 502 GHL_SEND_FAILED
debtRouter.post("/:id/payment-link", h(async (req, res) => {
  const body = req.body ?? {};
  const result = await svc(req).sendPaymentLink(req.params.id, {
    tenantId: req.profile!.tenantId,
    channel: optOutboundChannel(body.channel),
    message: optMessage(body.message),
  });
  return res.json(result);
}));

// PATCH /debt/:id/bad-debt
debtRouter.patch("/:id/bad-debt", h(async (req, res) => {
  const { flag } = req.body ?? {};
  if (typeof flag !== "boolean") return res.status(400).json({ error: "flag (boolean) is required" });
  const result = await svc(req).flagBadDebt(req.params.id, flag);
  return res.json(result);
}));

// PATCH /debt/:id/hold {flag, reason?, date?, notify?, message?}
debtRouter.patch("/:id/hold", h(async (req, res) => {
  const { flag, reason, date, notify, message } = req.body ?? {};
  if (typeof flag !== "boolean") return res.status(400).json({ error: "flag (boolean) is required" });
  if (reason !== undefined && typeof reason !== "string") {
    return res.status(400).json({ error: "reason must be a string" });
  }
  if (notify !== undefined && typeof notify !== "boolean") {
    return res.status(400).json({ error: "notify must be a boolean" });
  }
  const parsedDate = optIsoDate(date, "date");
  const result = await svc(req).flagHold(req.params.id, flag, {
    reason,
    date: parsedDate ?? undefined,
    notify,
    message,
  });
  return res.json(result);
}));
