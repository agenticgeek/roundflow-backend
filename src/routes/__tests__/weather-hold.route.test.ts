import { it, expect, vi, describe, beforeEach } from "vitest";
import request from "supertest";
import express from "express";

const preview = vi.fn();
const apply = vi.fn();
vi.mock("../../services/weather-hold.service", async (orig) => ({
  ...(await orig<typeof import("../../services/weather-hold.service")>()),
  createWeatherHoldService: vi.fn(() => ({ preview, apply })),
}));
vi.mock("../../services/round.service", () => ({ createRoundService: vi.fn(() => ({})), AllocationError: class extends Error {} }));
vi.mock("../../services/reports.service", () => ({ createReportsService: vi.fn(() => ({})) }));
vi.mock("../../middleware/requireAuth", () => ({ requireAuth: (_q: any, _s: any, n: any) => n() }));
vi.mock("../../middleware/requireTenantAccess", () => ({ requireTenantAccess: (_q: any, _s: any, n: any) => n() }));
vi.mock("../../middleware/requireRole", () => ({ requireBusinessAccess: () => (_q: any, _s: any, n: any) => n() }));

import { roundsRouter } from "../rounds";
import { errorHandler } from "../../lib/error-handler";

function makeApp(tenantPrisma: unknown = {}) {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => { req.tenantPrisma = tenantPrisma; req.profile = { id: "u1", role: "ADMIN" }; next(); });
  app.use("/rounds", roundsRouter);
  app.use(errorHandler);
  return app;
}

const body = { date: "2026-11-05", condition: "heavy-rain", rescheduling: "next-available" };
beforeEach(() => vi.clearAllMocks());

describe("GET /rounds/:id/weather-hold/preview", () => {
  it("returns the preview for the parsed query", async () => {
    preview.mockResolvedValue({ affectedVisits: 3 });
    const res = await request(makeApp()).get("/rounds/r1/weather-hold/preview?date=2026-11-05&condition=snow-ice&rescheduling=manual");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ affectedVisits: 3 });
    expect(preview).toHaveBeenCalledWith("r1", { date: new Date("2026-11-05T00:00:00.000Z"), condition: "snow-ice", rescheduling: "manual" });
  });

  it.each([
    ["date=&condition=heavy-rain&rescheduling=manual", /YYYY-MM-DD|date/],
    ["condition=heavy-rain&rescheduling=manual", /"date" is required/],
    ["date=2026-11-05&condition=fog&rescheduling=manual", /"condition" must be one of/],
    ["date=2026-11-05&condition=constructor&rescheduling=manual", /"condition" must be one of/],
    ["date=2026-11-05&condition=heavy-rain&rescheduling=whenever", /"rescheduling" must be one of/],
    ["date=2026-11-05&condition=heavy-rain", /rescheduling/],
  ])("400s for %s", async (qs, msg) => {
    const res = await request(makeApp()).get(`/rounds/r1/weather-hold/preview?${qs}`);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(msg);
    expect(preview).not.toHaveBeenCalled();
  });
});

describe("POST /rounds/:id/weather-hold", () => {
  it("applies the hold with the actor and defaults notifyCustomers to false", async () => {
    apply.mockResolvedValue({ held: 4 });
    const res = await request(makeApp()).post("/rounds/r1/weather-hold").send(body);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ held: 4 });
    expect(apply).toHaveBeenCalledWith("r1", {
      date: new Date("2026-11-05T00:00:00.000Z"), condition: "heavy-rain", rescheduling: "next-available",
      notifyCustomers: false, actor: { id: "u1", role: "ADMIN" },
    });
    await request(makeApp()).post("/rounds/r1/weather-hold").send({ ...body, notifyCustomers: true });
    expect(apply).toHaveBeenLastCalledWith("r1", expect.objectContaining({ notifyCustomers: true }));
  });

  it("400s on a bad body and never applies", async () => {
    expect((await request(makeApp()).post("/rounds/r1/weather-hold").send({ ...body, condition: "fog" })).status).toBe(400);
    expect((await request(makeApp()).post("/rounds/r1/weather-hold").send({ ...body, notifyCustomers: "yes" })).status).toBe(400);
    expect(apply).not.toHaveBeenCalled();
  });

  it("500s when the tenant client is missing", async () => {
    const res = await request(makeApp(null)).post("/rounds/r1/weather-hold").send(body);
    expect(res.status).toBe(500);
  });
});
