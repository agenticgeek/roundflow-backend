import { describe, it, expect, vi } from "vitest";
import request from "supertest";
import express from "express";

vi.mock("../../lib/prisma", () => ({ prisma: { profile: { findMany: vi.fn().mockResolvedValue([]) } } }));
vi.mock("../../middleware/requireAuth", () => ({ requireAuth: (_q: any, _s: any, n: any) => n() }));
vi.mock("../../middleware/requireTenantAccess", () => ({ requireTenantAccess: (_q: any, _s: any, n: any) => n() }));
vi.mock("../../middleware/requireRole", () => ({ requireBusinessAccess: () => (_q: any, _s: any, n: any) => n() }));

import { createReportsService, periodRange } from "../reports.service";
import { reportsRouter } from "../../routes/reports";

const NOW = new Date(2026, 9, 30, 15, 0, 0); // 30 Oct 2026 15:00 local

describe("periodRange (handoff 1.2 periods)", () => {
  it("today / last7 / last30 / last90 end now", () => {
    expect(periodRange("today", NOW)).toEqual({ gte: new Date(2026, 9, 30), lte: NOW });
    expect(periodRange("last7", NOW).gte).toEqual(new Date(2026, 9, 23, 15));
    expect(periodRange("last30", NOW).gte).toEqual(new Date(2026, 8, 30, 15));
    expect(periodRange("last90", NOW).gte).toEqual(new Date(2026, 7, 1, 15));
  });

  it("thisMonth / lastMonth / thisYear are calendar ranges", () => {
    expect(periodRange("thisMonth", NOW)).toEqual({ gte: new Date(2026, 9, 1), lte: NOW });
    expect(periodRange("lastMonth", NOW)).toEqual({
      gte: new Date(2026, 8, 1),
      lte: new Date(new Date(2026, 9, 1).getTime() - 1),
    });
    expect(periodRange("thisYear", NOW)).toEqual({ gte: new Date(2026, 0, 1), lte: NOW });
  });

  it("an unknown period falls back to last30; the clock defaults to now", () => {
    expect(periodRange("monthly" as never, NOW)).toEqual(periodRange("last30", NOW));
    expect(periodRange("today").lte.getTime()).toBeLessThanOrEqual(Date.now());
  });
});

describe("A4: CANCELLED visits are excluded from report readers", () => {
  function tp() {
    return {
      visit: {
        count: vi.fn().mockResolvedValue(0),
        findMany: vi.fn().mockResolvedValue([]),
        groupBy: vi.fn().mockResolvedValue([]),
      },
      technician: { findMany: vi.fn() },
    };
  }

  it("getVisits / getVisitsExport default to status != CANCELLED, but honour an explicit status", async () => {
    const p = tp();
    const svc = createReportsService(p as never);
    await svc.getVisits("last7");
    expect(p.visit.count.mock.calls[0][0].where.status).toEqual({ not: "CANCELLED" });
    await svc.getVisitsExport("last7");
    expect(p.visit.findMany.mock.calls[1][0].where.status).toEqual({ not: "CANCELLED" });
    await svc.getVisits("last7", "CANCELLED");
    expect(p.visit.count.mock.calls[1][0].where.status).toBe("CANCELLED");
  });

  it("technician rows ignore CANCELLED visits", async () => {
    const p = tp();
    await createReportsService(p as never).getTechnicians("last7");
    expect(p.visit.groupBy.mock.calls[0][0].where.status).toEqual({ not: "CANCELLED" });
  });
});

describe("GAP-024: GET /reports/revenue?period=monthly&granularity=monthly", () => {
  it("returns 200 (unknown period → last30, granularity ignored) instead of 500", async () => {
    const queryRaw = vi.fn().mockResolvedValue([{ day: new Date("2026-10-01T00:00:00Z"), amount: "12.50" }]);
    const app = express();
    app.use((req: any, _res, next) => { req.tenantPrisma = { $queryRaw: queryRaw }; next(); });
    app.use("/reports", reportsRouter);
    app.use((err: any, _req: any, res: any, _next: any) => res.status(500).json({ error: err.message }));

    const res = await request(app).get("/reports/revenue?period=monthly&granularity=monthly");

    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ date: "2026-10-01", amount: 12.5 }]);
    expect(queryRaw).toHaveBeenCalledTimes(1);
  });
});
