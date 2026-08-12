import { Router } from "express";
import { UserRole } from "@prisma/client";
import { requireAuth } from "../middleware/requireAuth";
import { requireTenantAccess } from "../middleware/requireTenantAccess";
import { requireRole } from "../middleware/requireRole";
import { h } from "../lib/http";
import { createDebtService } from "../services/debt.service";

export const debtRouter = Router();
debtRouter.use(requireAuth);
debtRouter.use(requireTenantAccess);
debtRouter.use(requireRole(UserRole.ADMIN, UserRole.MANAGER));

const svc = (req: any) => createDebtService(req.tenantPrisma!);

// GET /debt/kpis
debtRouter.get("/kpis", h(async (req, res) => {
  const kpis = await svc(req).getKpis();
  return res.json(kpis);
}));

// GET /debt/board?bucket=&roundId=&paymentMethod=
debtRouter.get("/board", h(async (req, res) => {
  const { bucket, roundId, paymentMethod } = req.query as Record<string, string | undefined>;
  if (!bucket) return res.status(400).json({ error: "bucket query param is required" });
  const items = await svc(req).getBoard(bucket as any, roundId, paymentMethod);
  return res.json(items);
}));

// POST /debt/:id/remind
debtRouter.post("/:id/remind", h(async (req, res) => {
  const { channel, message } = req.body ?? {};
  if (!channel || !message) return res.status(400).json({ error: "channel and message are required" });
  const result = await svc(req).sendReminder(req.params.id, channel, message);
  return res.json(result);
}));

// POST /debt/:id/payment-link
debtRouter.post("/:id/payment-link", h(async (req, res) => {
  const { message } = req.body ?? {};
  if (!message) return res.status(400).json({ error: "message is required" });
  const result = await svc(req).sendPaymentLink(req.params.id, message);
  return res.json(result);
}));

// PATCH /debt/:id/bad-debt
debtRouter.patch("/:id/bad-debt", h(async (req, res) => {
  const { flag } = req.body ?? {};
  if (typeof flag !== "boolean") return res.status(400).json({ error: "flag (boolean) is required" });
  const result = await svc(req).flagBadDebt(req.params.id, flag);
  return res.json(result);
}));

// PATCH /debt/:id/hold
debtRouter.patch("/:id/hold", h(async (req, res) => {
  const { flag } = req.body ?? {};
  if (typeof flag !== "boolean") return res.status(400).json({ error: "flag (boolean) is required" });
  const result = await svc(req).flagHold(req.params.id, flag);
  return res.json(result);
}));
