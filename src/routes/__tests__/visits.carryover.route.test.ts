import { it, expect, vi, describe, beforeEach } from "vitest";
import request from "supertest";
import express from "express";

const options = vi.fn();
const carryover = vi.fn();
vi.mock("../../services/carryover.service", () => ({ createCarryoverService: vi.fn(() => ({ options, carryover })) }));
vi.mock("../../services/visit-reschedule", () => ({ createVisitRescheduleService: vi.fn(() => ({})) }));
vi.mock("../../services/visit.service", () => ({ createVisitService: vi.fn(() => ({})) }));
vi.mock("../../services/reports.service", () => ({ createReportsService: vi.fn(() => ({})) }));
vi.mock("../../services/visit-completion", () => ({ createVisitCompletionService: vi.fn(() => ({})), parseCompletionPayment: vi.fn() }));
vi.mock("../../services/visit-photos.service", () => ({ createVisitPhotosService: vi.fn(() => ({})) }));
vi.mock("../../middleware/requireAuth", () => ({ requireAuth: (_q: any, _s: any, n: any) => n() }));
vi.mock("../../middleware/requireTenantAccess", () => ({ requireTenantAccess: (_q: any, _s: any, n: any) => n() }));
vi.mock("../../middleware/requireRole", () => ({ requireBusinessAccess: () => (_q: any, _s: any, n: any) => n() }));

import { visitsRouter } from "../visits";
import { errorHandler } from "../../lib/error-handler";

function makeApp(tenantPrisma: unknown = {}) {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => { req.tenantPrisma = tenantPrisma; req.profile = { id: "u1", role: "MANAGER" }; next(); });
  app.use("/visits", visitsRouter);
  app.use(errorHandler);
  return app;
}

beforeEach(() => vi.clearAllMocks());

describe("GET /visits/carryover/options", () => {
  it("returns the options for the date", async () => {
    options.mockResolvedValue({ date: "2026-11-06", options: [] });
    const res = await request(makeApp()).get("/visits/carryover/options?date=2026-11-06");
    expect(res.status).toBe(200);
    expect(options).toHaveBeenCalledWith(new Date("2026-11-06T00:00:00.000Z"));
  });
  it("400s without a valid date and 500s without a tenant client", async () => {
    expect((await request(makeApp()).get("/visits/carryover/options")).status).toBe(400);
    expect((await request(makeApp()).get("/visits/carryover/options?date=nope")).status).toBe(400);
    expect((await request(makeApp(null)).get("/visits/carryover/options?date=2026-11-06")).status).toBe(500);
  });
});

describe("POST /visits/carryover", () => {
  it("passes the parsed body and the actor to the service", async () => {
    carryover.mockResolvedValue({ moved: 1 });
    const res = await request(makeApp()).post("/visits/carryover").send({
      date: "2026-11-06", target: "MONDAY", visitIds: ["v1"], notifyCustomers: true, dryRun: false,
    });
    expect(res.status).toBe(200);
    expect(carryover).toHaveBeenCalledWith({
      date: new Date("2026-11-06T00:00:00.000Z"), target: "MONDAY", visitIds: ["v1"], notifyCustomers: true, dryRun: false,
      actor: { id: "u1", role: "MANAGER" },
    });
  });
  it("passes an undefined role when the profile has none", async () => {
    carryover.mockResolvedValue({});
    const app = express();
    app.use(express.json());
    app.use((req: any, _res, next) => { req.tenantPrisma = {}; req.profile = { id: "u2", role: null }; next(); });
    app.use("/visits", visitsRouter);
    await request(app).post("/visits/carryover").send({ date: "2026-11-06", target: "MONDAY" });
    expect(carryover).toHaveBeenCalledWith(expect.objectContaining({ actor: { id: "u2", role: undefined } }));
  });
  it("defaults optional fields", async () => {
    carryover.mockResolvedValue({});
    await request(makeApp()).post("/visits/carryover").send({ date: "2026-11-06", target: "SATURDAY" });
    expect(carryover).toHaveBeenCalledWith(expect.objectContaining({ visitIds: undefined, notifyCustomers: undefined, dryRun: undefined }));
  });
  it("validates the body", async () => {
    const app = makeApp();
    expect((await request(app).post("/visits/carryover").send({ target: "MONDAY" })).status).toBe(400);
    expect((await request(app).post("/visits/carryover").send({ date: "2026-11-06" })).status).toBe(400);
    expect((await request(app).post("/visits/carryover").send({ date: "2026-11-06", target: "MONDAY", visitIds: [] })).status).toBe(400);
    expect((await request(app).post("/visits/carryover").send({ date: "2026-11-06", target: "MONDAY", visitIds: Array(501).fill("x") })).status).toBe(400);
    expect((await request(app).post("/visits/carryover").send({ date: "2026-11-06", target: "MONDAY", dryRun: "yes" })).status).toBe(400);
    expect((await request(makeApp(null)).post("/visits/carryover").send({ date: "2026-11-06", target: "MONDAY" })).status).toBe(500);
    expect(carryover).not.toHaveBeenCalled();
  });
});
