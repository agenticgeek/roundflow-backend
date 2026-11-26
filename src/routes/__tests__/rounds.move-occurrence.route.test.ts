import { it, expect, vi, describe, beforeEach } from "vitest";
import request from "supertest";
import express from "express";

const preview = vi.fn();
const move = vi.fn();
vi.mock("../../services/round-move.service", async (orig) => ({
  ...(await orig<typeof import("../../services/round-move.service")>()),
  createRoundMoveService: vi.fn(() => ({ preview, move })),
}));
vi.mock("../../services/round.service", () => ({ createRoundService: vi.fn(() => ({})), AllocationError: class extends Error {} }));
vi.mock("../../services/reports.service", () => ({ createReportsService: vi.fn(() => ({})) }));
vi.mock("../../middleware/requireAuth", () => ({ requireAuth: (_q: any, _s: any, n: any) => n() }));
vi.mock("../../middleware/requireTenantAccess", () => ({ requireTenantAccess: (_q: any, _s: any, n: any) => n() }));
vi.mock("../../middleware/requireRole", () => ({ requireBusinessAccess: () => (_q: any, _s: any, n: any) => n() }));

import { roundsRouter } from "../rounds";
import { errorHandler } from "../../lib/error-handler";
import { AppError } from "../../lib/app-error";

function makeApp(tenantPrisma: unknown = {}) {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => { req.tenantPrisma = tenantPrisma; req.profile = { id: "u1", role: "ADMIN" }; next(); });
  app.use("/rounds", roundsRouter);
  app.use(errorHandler);
  return app;
}

const d = (s: string) => new Date(`${s}T00:00:00.000Z`);
beforeEach(() => vi.clearAllMocks());

describe("GET /rounds/:id/move-occurrence/preview", () => {
  it("passes fromDate and the optional toDate", async () => {
    preview.mockResolvedValue({ kind: "REAL" });
    const res = await request(makeApp()).get("/rounds/r1/move-occurrence/preview?fromDate=2026-11-30");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ kind: "REAL" });
    expect(preview).toHaveBeenCalledWith("r1", d("2026-11-30"), undefined);
    await request(makeApp()).get("/rounds/r1/move-occurrence/preview?fromDate=2026-11-30&toDate=2026-12-02");
    expect(preview).toHaveBeenLastCalledWith("r1", d("2026-11-30"), d("2026-12-02"));
  });

  it.each(["", "?fromDate=30-11-2026", "?fromDate=2026-02-30", "?fromDate=2026-11-30&toDate=x"])("400s for %s", async (qs) => {
    const res = await request(makeApp()).get(`/rounds/r1/move-occurrence/preview${qs}`);
    expect(res.status).toBe(400);
    expect(preview).not.toHaveBeenCalled();
  });
});

describe("POST /rounds/:id/move-occurrence", () => {
  it("moves with notifyCustomers on by default and the actor", async () => {
    move.mockResolvedValue({ movedVisits: 4 });
    const res = await request(makeApp()).post("/rounds/r1/move-occurrence").send({ fromDate: "2026-11-30", toDate: "2026-12-02" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ movedVisits: 4 });
    expect(move).toHaveBeenCalledWith("r1", {
      fromDate: d("2026-11-30"), toDate: d("2026-12-02"), notifyCustomers: true, message: undefined, actor: { id: "u1", role: "ADMIN" },
    });
  });

  it("passes notifyCustomers=false and the message", async () => {
    move.mockResolvedValue({});
    await request(makeApp()).post("/rounds/r1/move-occurrence").send({ fromDate: "2026-11-30", toDate: "2026-12-02", notifyCustomers: false, message: "Hi" });
    expect(move).toHaveBeenCalledWith("r1", expect.objectContaining({ notifyCustomers: false, message: "Hi" }));
  });

  it.each([
    {},
    { fromDate: "2026-11-30" },
    { fromDate: "2026-11-30", toDate: "2026-12-32" },
    { fromDate: "2026-11-30T00:00:00Z", toDate: "2026-12-02" },
    { fromDate: "2026-11-30", toDate: "2026-12-02", notifyCustomers: "yes" },
    { fromDate: "2026-11-30", toDate: "2026-12-02", message: 5 },
  ])("400s on a bad body %#", async (body) => {
    const res = await request(makeApp()).post("/rounds/r1/move-occurrence").send(body);
    expect(res.status).toBe(400);
    expect(move).not.toHaveBeenCalled();
  });

  it("forwards the service's error code", async () => {
    move.mockRejectedValue(new AppError(409, "2 properties would get two cleans too close together", "PROPERTY_CLEAN_CLASH"));
    const res = await request(makeApp()).post("/rounds/r1/move-occurrence").send({ fromDate: "2026-11-30", toDate: "2026-12-02" });
    expect(res.status).toBe(409);
    expect(res.body).toEqual(expect.objectContaining({ code: "PROPERTY_CLEAN_CLASH", error: "2 properties would get two cleans too close together" }));
  });

  it("500s when the tenant client is missing", async () => {
    const res = await request(makeApp(null)).post("/rounds/r1/move-occurrence").send({ fromDate: "2026-11-30", toDate: "2026-12-02" });
    expect(res.status).toBe(500);
  });
});
