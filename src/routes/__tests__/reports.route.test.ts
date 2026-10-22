import { it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";

const emptyPage = { rows: [], pagination: { page: 1, pageSize: 50, total: 0, totalPages: 0 } };

const getSummary = vi.fn();
const getRevenue = vi.fn();
const getTechnicians = vi.fn();
const getTechniciansExport = vi.fn();
const getVisits = vi.fn();
const getVisitsExport = vi.fn();
const getActivity = vi.fn();
const logActivity = vi.fn();

vi.mock("../../services/reports.service", () => ({
  createReportsService: vi.fn(() => ({
    getSummary, getRevenue, getTechnicians, getTechniciansExport, getVisits, getVisitsExport, getActivity, logActivity,
  })),
}));

vi.mock("../../middleware/requireAuth", () => ({
  requireAuth: (_req: any, _res: any, next: any) => next(),
}));
vi.mock("../../middleware/requireTenantAccess", () => ({
  requireTenantAccess: (_req: any, _res: any, next: any) => next(),
}));
vi.mock("../../middleware/requireRole", () => ({
  requireRole: () => (_req: any, _res: any, next: any) => next(),
  requireBusinessAccess: () => (_req: any, _res: any, next: any) => next(),
}));

import { reportsRouter } from "../../routes/reports";

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => { req.tenantPrisma = {}; next(); });
  app.use("/reports", reportsRouter);
  app.use((err: any, _req: any, res: any, _next: any) => {
    res.status(err?.statusCode ?? 500).json({ error: err?.message ?? "Internal error" });
  });
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  getSummary.mockResolvedValue({ totalRevenue: 0, completedVisits: 0, completedRounds: 0, undonePayments: 0 });
  getRevenue.mockResolvedValue([]);
  getTechnicians.mockResolvedValue(emptyPage);
  getTechniciansExport.mockResolvedValue([]);
  getVisits.mockResolvedValue(emptyPage);
  getVisitsExport.mockResolvedValue([]);
  getActivity.mockResolvedValue(emptyPage);
  logActivity.mockResolvedValue(undefined);
});

it("reportsRouter is exported from src/routes/reports.ts", () => {
  expect(reportsRouter).toBeDefined();
});

it("GET /reports/summary returns 200", async () => {
  const app = makeApp();
  const res = await request(app).get("/reports/summary?period=last30");
  expect(res.status).toBe(200);
});

it("GET /reports/revenue returns 200", async () => {
  const app = makeApp();
  const res = await request(app).get("/reports/revenue?period=last30&granularity=daily");
  expect(res.status).toBe(200);
});

it("GET /reports/technicians returns 200 and threads period/page/pageSize", async () => {
  const app = makeApp();
  const res = await request(app).get("/reports/technicians?period=last30&page=2&pageSize=10");
  expect(res.status).toBe(200);
  expect(res.body).toEqual(emptyPage);
  expect(getTechnicians).toHaveBeenCalledWith("last30", 2, 10);
});

it("GET /reports/visits returns 200 and threads period/status/page/pageSize", async () => {
  const app = makeApp();
  const res = await request(app).get("/reports/visits?period=last30&status=SKIPPED&page=2&pageSize=10");
  expect(res.status).toBe(200);
  expect(res.body).toEqual(emptyPage);
  expect(getVisits).toHaveBeenCalledWith("last30", "SKIPPED", 2, 10);
});

it("GET /reports/activity returns 200 and threads type/from/to/page/pageSize", async () => {
  const app = makeApp();
  const res = await request(app).get("/reports/activity?type=PROPERTY_ADDED&from=2026-01-01&to=2026-01-31&page=2&pageSize=10");
  expect(res.status).toBe(200);
  expect(res.body).toEqual(emptyPage);
  expect(getActivity).toHaveBeenCalledWith(
    "PROPERTY_ADDED",
    new Date(Date.UTC(2026, 0, 1)),
    new Date(Date.UTC(2026, 0, 31)),
    2,
    10
  );
});

it("GET /reports/activity defaults from/to to undefined when omitted", async () => {
  const app = makeApp();
  const res = await request(app).get("/reports/activity");
  expect(res.status).toBe(200);
  expect(getActivity).toHaveBeenCalledWith(undefined, undefined, undefined, 1, 50);
});

it("GET /reports/activity 400s for an invalid 'from' date", async () => {
  const app = makeApp();
  const res = await request(app).get("/reports/activity?from=not-a-date");
  expect(res.status).toBe(400);
});

// ---------------------------------------------------------------------------
// GET /reports/export
// ---------------------------------------------------------------------------

it("GET /reports/export defaults to type=visits and streams CSV via getVisitsExport", async () => {
  getVisitsExport.mockResolvedValue([{ visitId: "v1", amount: 35 }]);
  const app = makeApp();
  const res = await request(app).get("/reports/export?period=last30");
  expect(res.status).toBe(200);
  expect(res.headers["content-type"]).toMatch(/text\/csv/);
  expect(res.headers["content-disposition"]).toContain("visits-last30.csv");
  expect(res.text).toContain("v1");
  expect(getVisitsExport).toHaveBeenCalledWith("last30", undefined);
  expect(getVisits).not.toHaveBeenCalled();
});

it("GET /reports/export?type=technicians streams CSV via getTechniciansExport", async () => {
  getTechniciansExport.mockResolvedValue([{ technicianId: "t1", name: "James" }]);
  const app = makeApp();
  const res = await request(app).get("/reports/export?type=technicians&period=last30");
  expect(res.status).toBe(200);
  expect(res.headers["content-disposition"]).toContain("technicians-last30.csv");
  expect(res.text).toContain("James");
  expect(getTechnicians).not.toHaveBeenCalled();
});

it("GET /reports/export?type=revenue streams CSV via getRevenue", async () => {
  getRevenue.mockResolvedValue([{ date: "2026-01-01", amount: 50 }]);
  const app = makeApp();
  const res = await request(app).get("/reports/export?type=revenue&period=last30");
  expect(res.status).toBe(200);
  expect(res.headers["content-disposition"]).toContain("revenue-last30.csv");
  expect(res.text).toContain("50");
});

it("GET /reports/export passes the status filter through for a visits export", async () => {
  getVisitsExport.mockResolvedValue([]);
  const app = makeApp();
  await request(app).get("/reports/export?period=last30&status=SKIPPED");
  expect(getVisitsExport).toHaveBeenCalledWith("last30", "SKIPPED");
});

// ---------------------------------------------------------------------------
// Service-rejection -> next(err) wiring, per route
// ---------------------------------------------------------------------------

it("GET /reports/visits forwards a service rejection to the error handler", async () => {
  getVisits.mockRejectedValue(new Error("boom"));
  const res = await request(makeApp()).get("/reports/visits");
  expect(res.status).toBe(500);
});

it("GET /reports/technicians forwards a service rejection to the error handler", async () => {
  getTechnicians.mockRejectedValue(new Error("boom"));
  const res = await request(makeApp()).get("/reports/technicians");
  expect(res.status).toBe(500);
});

it("GET /reports/revenue forwards a service rejection to the error handler", async () => {
  getRevenue.mockRejectedValue(new Error("boom"));
  const res = await request(makeApp()).get("/reports/revenue");
  expect(res.status).toBe(500);
});

it("GET /reports/summary forwards a service rejection to the error handler", async () => {
  getSummary.mockRejectedValue(new Error("boom"));
  const res = await request(makeApp()).get("/reports/summary");
  expect(res.status).toBe(500);
});

it("GET /reports/export forwards a service rejection to the error handler", async () => {
  getVisitsExport.mockRejectedValue(new Error("boom"));
  const res = await request(makeApp()).get("/reports/export");
  expect(res.status).toBe(500);
});
