import { Router } from "express";
import { requireAuth } from "../middleware/requireAuth";
import { requireTenantAccess } from "../middleware/requireTenantAccess";
import { requireBusinessAccess } from "../middleware/requireRole";
import { createReportsService } from "../services/reports.service";
import { toCsv } from "../lib/csv";

export const reportsRouter = Router();

reportsRouter.use(requireAuth, requireTenantAccess, requireBusinessAccess());

reportsRouter.get("/activity", async (req, res, next) => {
  try {
    const { type } = req.query as { type?: string };
    const svc = createReportsService(req.tenantPrisma!);
    const data = await svc.getActivity(type);
    res.json(data);
  } catch (err) { next(err); }
});

reportsRouter.get("/visits", async (req, res, next) => {
  try {
    const { period = "last30", status } = req.query as { period?: string; status?: string };
    const svc = createReportsService(req.tenantPrisma!);
    const data = await svc.getVisits(period, status);
    res.json(data);
  } catch (err) { next(err); }
});

reportsRouter.get("/technicians", async (req, res, next) => {
  try {
    const { period = "last30" } = req.query as { period?: string };
    const svc = createReportsService(req.tenantPrisma!);
    const data = await svc.getTechnicians(period);
    res.json(data);
  } catch (err) { next(err); }
});

reportsRouter.get("/revenue", async (req, res, next) => {
  try {
    const { period = "last30" } = req.query as { period?: string };
    const svc = createReportsService(req.tenantPrisma!);
    const data = await svc.getRevenue(period);
    res.json(data);
  } catch (err) { next(err); }
});

reportsRouter.get("/summary", async (req, res, next) => {
  try {
    const { period = "last30" } = req.query as { period?: string };
    const svc = createReportsService(req.tenantPrisma!);
    const data = await svc.getSummary(period);
    res.json(data);
  } catch (err) { next(err); }
});

// GET /reports/export?type=visits|technicians|revenue&period=&status= -> text/csv
reportsRouter.get("/export", async (req, res, next) => {
  try {
    const { type = "visits", period = "last30", status } = req.query as {
      type?: string; period?: string; status?: string;
    };
    const svc = createReportsService(req.tenantPrisma!);
    const rows =
      type === "technicians" ? await svc.getTechnicians(period) :
      type === "revenue"     ? await svc.getRevenue(period) :
                               await svc.getVisits(period, status);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${type}-${period}.csv"`);
    res.send(toCsv(rows));
  } catch (err) { next(err); }
});
