import { Router } from "express";
import { requireAuth } from "../middleware/requireAuth";
import { requireTenantAccess } from "../middleware/requireTenantAccess";
import { requireRole } from "../middleware/requireRole";
import { createReportsService } from "../services/reports.service";

export const reportsRouter = Router();

reportsRouter.use(requireAuth, requireTenantAccess, requireRole("ADMIN", "MANAGER"));

reportsRouter.get("/activity", async (req, res, next) => {
  try {
    const { type } = req.query as { type?: string };
    const svc = createReportsService((req as any).tenantPrisma);
    const data = await svc.getActivity(type);
    res.json(data);
  } catch (err) { next(err); }
});

reportsRouter.get("/visits", async (req, res, next) => {
  try {
    const { period = "last30", status } = req.query as { period?: string; status?: string };
    const svc = createReportsService((req as any).tenantPrisma);
    const data = await svc.getVisits(period, status);
    res.json(data);
  } catch (err) { next(err); }
});

reportsRouter.get("/technicians", async (req, res, next) => {
  try {
    const { period = "last30" } = req.query as { period?: string };
    const svc = createReportsService((req as any).tenantPrisma);
    const data = await svc.getTechnicians(period);
    res.json(data);
  } catch (err) { next(err); }
});

reportsRouter.get("/revenue", async (req, res, next) => {
  try {
    const { period = "last30", granularity = "daily" } = req.query as { period?: string; granularity?: string };
    const svc = createReportsService((req as any).tenantPrisma);
    const data = await svc.getRevenue(period, granularity);
    res.json(data);
  } catch (err) { next(err); }
});

reportsRouter.get("/summary", async (req, res, next) => {
  try {
    const { period = "last30" } = req.query as { period?: string };
    const svc = createReportsService((req as any).tenantPrisma);
    const data = await svc.getSummary(period);
    res.json(data);
  } catch (err) { next(err); }
});
