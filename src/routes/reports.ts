import { Router } from "express";
import { requireAuth } from "../middleware/requireAuth";
import { requireTenantAccess } from "../middleware/requireTenantAccess";
import { requireBusinessAccess } from "../middleware/requireRole";
import { createReportsService } from "../services/reports.service";
import { toCsv } from "../lib/csv";
import { parsePageParams } from "../lib/http";
import { parseOptionalDateOnly } from "../lib/validation";

export const reportsRouter = Router();

reportsRouter.use(requireAuth, requireTenantAccess, requireBusinessAccess());

// GET /reports/activity?type=&from=YYYY-MM-DD&to=YYYY-MM-DD&page=&pageSize=
reportsRouter.get("/activity", async (req, res, next) => {
  try {
    const { type } = req.query as { type?: string };
    const from = parseOptionalDateOnly(req.query.from, "from");
    const to = parseOptionalDateOnly(req.query.to, "to");
    const { page, pageSize } = parsePageParams(req.query as Record<string, unknown>);
    const svc = createReportsService(req.tenantPrisma!);
    const data = await svc.getActivity(type, from, to, page, pageSize);
    res.json(data);
  } catch (err) { next(err); }
});

// GET /reports/visits?period=&status=&page=&pageSize=
reportsRouter.get("/visits", async (req, res, next) => {
  try {
    const { period = "last30", status } = req.query as { period?: string; status?: string };
    const { page, pageSize } = parsePageParams(req.query as Record<string, unknown>);
    const svc = createReportsService(req.tenantPrisma!);
    const data = await svc.getVisits(period, status, page, pageSize);
    res.json(data);
  } catch (err) { next(err); }
});

// GET /reports/technicians?period=&page=&pageSize=
reportsRouter.get("/technicians", async (req, res, next) => {
  try {
    const { period = "last30" } = req.query as { period?: string };
    const { page, pageSize } = parsePageParams(req.query as Record<string, unknown>);
    const svc = createReportsService(req.tenantPrisma!);
    const data = await svc.getTechnicians(period, page, pageSize);
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
// Always exports the full (unpaginated) result set for the period, regardless
// of the page/pageSize the UI happens to be viewing.
reportsRouter.get("/export", async (req, res, next) => {
  try {
    const { type = "visits", period = "last30", status } = req.query as {
      type?: string; period?: string; status?: string;
    };
    const svc = createReportsService(req.tenantPrisma!);
    const csv =
      type === "technicians" ? toCsv(await svc.getTechniciansExport(period)) :
      type === "revenue"     ? toCsv(await svc.getRevenue(period)) :
                               toCsv(await svc.getVisitsExport(period, status));
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${type}-${period}.csv"`);
    res.send(csv);
  } catch (err) { next(err); }
});
