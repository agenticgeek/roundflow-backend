import { it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";

const list = vi.fn();
const replaceAll = vi.fn();
vi.mock("../../services/kpi-threshold.service", async (orig) => ({
  ...(await orig<typeof import("../../services/kpi-threshold.service")>()),
  createKpiThresholdService: vi.fn(() => ({ list, replaceAll })),
}));
vi.mock("../../middleware/requireAuth", () => ({ requireAuth: (_q: any, _s: any, n: any) => n() }));
vi.mock("../../middleware/requireTenantAccess", () => ({ requireTenantAccess: (_q: any, _s: any, n: any) => n() }));
vi.mock("../../middleware/requireRole", () => ({ requireBusinessAccess: () => (_q: any, _s: any, n: any) => n() }));

import { kpiThresholdsRouter } from "../kpi-thresholds";
import { AppError } from "../../lib/app-error";

function makeApp(withTenant = true) {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    if (withTenant) req.tenantPrisma = {};
    next();
  });
  app.use("/settings/kpi-thresholds", kpiThresholdsRouter);
  app.use((err: any, _req: any, res: any, _next: any) => {
    if (err instanceof AppError) return res.status(err.statusCode).json({ error: err.message });
    res.status(500).json({ error: "Internal error" });
  });
  return app;
}

beforeEach(() => vi.clearAllMocks());

it("500s without a tenant client", async () => {
  expect((await request(makeApp(false)).get("/settings/kpi-thresholds")).status).toBe(500);
});

it("GET lists thresholds", async () => {
  list.mockResolvedValue([{ id: "k1", metric: "strikes", operator: "GT", value: 3 }]);
  const res = await request(makeApp()).get("/settings/kpi-thresholds");
  expect(res.status).toBe(200);
  expect(res.body).toEqual([{ id: "k1", metric: "strikes", operator: "GT", value: 3 }]);
});

it("PUT replaces all from a raw array or { thresholds }", async () => {
  replaceAll.mockResolvedValue([]);
  const items = [
    { metric: "strikes", operator: "GT", value: 3 },
    { metric: "revenuePerHour", operator: "LT", value: 30.5 },
  ];
  expect((await request(makeApp()).put("/settings/kpi-thresholds").send(items)).status).toBe(200);
  expect(replaceAll).toHaveBeenCalledWith(items);
  expect((await request(makeApp()).put("/settings/kpi-thresholds").send({ thresholds: [] })).status).toBe(200);
  expect(replaceAll).toHaveBeenLastCalledWith([]);
});

it.each([
  [{ thresholds: "nope" }, /Expected an array/],
  [["x"], /thresholds\[0\] must be an object/],
  [[null], /thresholds\[0\] must be an object/],
  [[[1]], /thresholds\[0\] must be an object/],
  [[{ metric: "speed", operator: "GT", value: 1 }], /metric must be one of/],
  [[{ metric: "strikes", operator: "EQ", value: 1 }], /operator must be one of/],
  [[{ metric: "strikes", operator: "GT", value: "1" }], /value must be a number/],
  [[{ metric: "strikes", operator: "GT", value: -1 }], /value must be a number/],
  [[{ metric: "strikes", operator: "GT", value: 1e12 }], /value must be a number/],
])("PUT 400s for %j", async (body, msg) => {
  const res = await request(makeApp()).put("/settings/kpi-thresholds").send(body as object);
  expect(res.status).toBe(400);
  expect(res.body.error).toMatch(msg);
  expect(replaceAll).not.toHaveBeenCalled();
});
