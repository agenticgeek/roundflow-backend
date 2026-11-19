import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import express from "express";

// Route wiring for stops (docs/PROPERTY_STOPS_PLAN_2026-11-19.md §7.3–7.4). Services are mocked.

let tp: ReturnType<typeof makeTp>;
vi.mock("../../lib/prisma", () => ({ prisma: { profile: { findUnique: vi.fn(), update: vi.fn() } } }));
vi.mock("../../middleware/requireAuth", () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.user = { supabaseUserId: "sb-1" };
    next();
  },
}));
vi.mock("../../middleware/requireTenantAccess", () => ({
  requireTenantAccess: (req: any, _res: any, next: any) => {
    req.profile = { id: "profile-1", tenantId: "tenant-1", name: "Sam", role: "TECHNICIAN" };
    req.tenantPrisma = tp;
    next();
  },
}));
const tracker = { skipVisit: vi.fn() };
vi.mock("../services/job-tracker.service", () => ({ createJobTrackerService: () => tracker }));
const completeVisit = vi.fn();
vi.mock("../../services/visit-completion", async (orig) => {
  const actual = await orig<typeof import("../../services/visit-completion")>();
  return { ...actual, createVisitCompletionService: () => ({ completeVisit: (...a: unknown[]) => completeVisit(...a) }) };
});

import { mobileRouter } from "../routes";
import { AppError } from "../../lib/app-error";

function makeTp() {
  return {
    technician: { findUnique: vi.fn().mockResolvedValue({ id: "tech-1", active: true }) },
    visit: { findUnique: vi.fn().mockResolvedValue({ technicianId: "tech-1" }) },
    idempotencyRecord: {
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({}),
      update: vi.fn().mockResolvedValue({}),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
  };
}

function app() {
  const a = express();
  a.use(express.json());
  a.use("/mobile", mobileRouter);
  a.use((err: unknown, _req: any, res: any, _next: any) => {
    if (err instanceof AppError) return res.status(err.statusCode).json({ error: err.message, code: err.code });
    res.status(500).json({ error: String(err) });
  });
  return a;
}

beforeEach(() => {
  vi.clearAllMocks();
  tp = makeTp();
  completeVisit.mockResolvedValue({ id: "v1", status: "COMPLETED", payment: null, invoice: null, services: [], ignored: [] });
});

describe("PATCH /mobile/visits/:id/complete with services", () => {
  it("passes the parsed services through", async () => {
    const res = await request(app())
      .patch("/mobile/visits/v1/complete")
      .send({ payment: { method: "CASH" }, services: [{ visitId: "v1", done: true }, { visitId: "v2", done: false, skipReason: " Blocked " }] });
    expect(res.status).toBe(200);
    expect(completeVisit.mock.calls[0][1].services).toEqual([
      { visitId: "v1", done: true },
      { visitId: "v2", done: false, skipReason: "Blocked" },
    ]);
  });

  it("400 INVALID_SERVICES before touching any visit", async () => {
    const res = await request(app()).patch("/mobile/visits/v1/complete").send({ payment: { method: "CASH" }, services: [] });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("INVALID_SERVICES");
    expect(completeVisit).not.toHaveBeenCalled();
  });
});

describe("PATCH /mobile/visits/:id/skip", () => {
  it("passes stop: true for a whole-stop skip", async () => {
    await request(app()).patch("/mobile/visits/v1/skip").send({ reason: "NO_ACCESS", description: "Gate", stop: true });
    expect(tracker.skipVisit).toHaveBeenCalledWith("v1", "NO_ACCESS", "Gate", { stop: true });
  });

  it("defaults to a single-service skip", async () => {
    await request(app()).patch("/mobile/visits/v1/skip").send({ reason: "NO_ACCESS" });
    expect(tracker.skipVisit).toHaveBeenCalledWith("v1", "NO_ACCESS", undefined, { stop: false });
  });

  it("400 for a non-boolean stop", async () => {
    const res = await request(app()).patch("/mobile/visits/v1/skip").send({ reason: "NO_ACCESS", stop: "yes" });
    expect(res.status).toBe(400);
  });
});
