import { it, expect, vi } from "vitest";
import request from "supertest";
import express from "express";

vi.mock("../../services/reports.service", () => ({
  createReportsService: vi.fn(() => ({
    getSummary: vi.fn().mockResolvedValue({ totalRevenue: 0, completedVisits: 0, completedRounds: 0, undonePayments: 0 }),
    getRevenue: vi.fn().mockResolvedValue([]),
    getTechnicians: vi.fn().mockResolvedValue([]),
    getVisits: vi.fn().mockResolvedValue([]),
    getActivity: vi.fn().mockResolvedValue([]),
    logActivity: vi.fn().mockResolvedValue(undefined),
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
}));

import { reportsRouter } from "../../routes/reports";

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => { req.tenantPrisma = {}; next(); });
  app.use("/reports", reportsRouter);
  return app;
}

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

it("GET /reports/technicians returns 200", async () => {
  const app = makeApp();
  const res = await request(app).get("/reports/technicians?period=last30");
  expect(res.status).toBe(200);
});

it("GET /reports/visits returns 200", async () => {
  const app = makeApp();
  const res = await request(app).get("/reports/visits?period=last30");
  expect(res.status).toBe(200);
});

it("GET /reports/activity returns 200", async () => {
  const app = makeApp();
  const res = await request(app).get("/reports/activity");
  expect(res.status).toBe(200);
});
