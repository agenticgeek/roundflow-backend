import { Router } from "express";
import { UserRole } from "@prisma/client";
import { requireAuth } from "../middleware/requireAuth";
import { requireTenantAccess } from "../middleware/requireTenantAccess";
import { requireRole } from "../middleware/requireRole";
import { h } from "../lib/http";
import { createDashboardService } from "../services/dashboard.service";

export const dashboardRouter = Router();
dashboardRouter.use(requireAuth);
dashboardRouter.use(requireTenantAccess);
dashboardRouter.use(requireRole(UserRole.ADMIN, UserRole.MANAGER));

const svc = (req: any) => createDashboardService(req.tenantPrisma!);

// GET /dashboard/kpis — 4 top metric cards
dashboardRouter.get("/kpis", h(async (req, res) => {
  res.json(await svc(req).getKpis());
}));

// GET /dashboard/alerts — 3 expandable alert cards
dashboardRouter.get("/alerts", h(async (req, res) => {
  res.json(await svc(req).getAlerts());
}));

// GET /dashboard/rounds — today's rounds table
dashboardRouter.get("/rounds", h(async (req, res) => {
  res.json(await svc(req).getTodaysRounds());
}));

// GET /dashboard/technician-kpis?period=monthly|yearly
dashboardRouter.get("/technician-kpis", h(async (req, res) => {
  const period = req.query.period === "yearly" ? "yearly" : "monthly";
  res.json(await svc(req).getTechnicianKpis(period));
}));

// GET /dashboard/charts?range=6m|12m
dashboardRouter.get("/charts", h(async (req, res) => {
  const range = req.query.range === "12m" ? "12m" : "6m";
  res.json(await svc(req).getChartData(range));
}));
