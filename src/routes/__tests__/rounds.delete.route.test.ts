import { it, expect, vi, describe, beforeEach } from "vitest";
import request from "supertest";
import express from "express";

const preview = vi.fn();
const deleteRound = vi.fn();
const logActivity = vi.fn();
vi.mock("../../services/round-delete.service", () => ({
  createRoundDeleteService: vi.fn(() => ({ preview, deleteRound })),
}));
vi.mock("../../services/round.service", () => ({ createRoundService: vi.fn(() => ({})), AllocationError: class extends Error {} }));
vi.mock("../../services/reports.service", () => ({ createReportsService: vi.fn(() => ({ logActivity })) }));
vi.mock("../../middleware/requireAuth", () => ({ requireAuth: (_q: any, _s: any, n: any) => n() }));
vi.mock("../../middleware/requireTenantAccess", () => ({ requireTenantAccess: (_q: any, _s: any, n: any) => n() }));
vi.mock("../../middleware/requireRole", () => ({ requireBusinessAccess: () => (_q: any, _s: any, n: any) => n() }));

import { roundsRouter } from "../rounds";
import { errorHandler } from "../../lib/error-handler";
import { AppError } from "../../lib/app-error";

function makeApp(tenantPrisma: unknown = {}, profile: unknown = { id: "u1", role: "ADMIN" }) {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.tenantPrisma = tenantPrisma;
    req.profile = profile;
    next();
  });
  app.use("/rounds", roundsRouter);
  app.use(errorHandler);
  return app;
}

beforeEach(() => vi.clearAllMocks());

describe("GET /rounds/:id/delete-preview", () => {
  it("returns the service's preview", async () => {
    const body = { propertyCount: 4, upcomingVisitCount: 3, detachedVisitCount: 9, emergencyCount: 0, attachedVisitCount: 0, canDelete: true };
    preview.mockResolvedValue(body);
    const res = await request(makeApp()).get("/rounds/r1/delete-preview");
    expect(res.status).toBe(200);
    expect(res.body).toEqual(body);
    expect(preview).toHaveBeenCalledWith("r1");
  });

  it("404s for a missing round", async () => {
    preview.mockRejectedValue(new AppError(404, "Round not found"));
    const res = await request(makeApp()).get("/rounds/nope/delete-preview");
    expect(res.status).toBe(404);
  });

  it("500s without a tenant client", async () => {
    const res = await request(makeApp(null)).get("/rounds/r1/delete-preview");
    expect(res.status).toBe(500);
    expect(preview).not.toHaveBeenCalled();
  });
});

describe("DELETE /rounds/:id", () => {
  it("deletes, answers with the counts only and logs ROUND_DELETED with the round name and actor", async () => {
    deleteRound.mockResolvedValue({ roundName: "Monday North", deleted: true, unassignedProperties: 4, deletedVisits: 3, detachedVisits: 9 });
    const res = await request(makeApp()).delete("/rounds/r1");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ deleted: true, unassignedProperties: 4, deletedVisits: 3, detachedVisits: 9 });
    expect(deleteRound).toHaveBeenCalledWith("r1");
    expect(logActivity).toHaveBeenCalledTimes(1);
    const [type, message, actorId, actorRole] = logActivity.mock.calls[0];
    expect(type).toBe("ROUND_DELETED");
    expect(message).toContain('"Monday North"');
    expect(message).toMatch(/4 propert/);
    expect(message).toMatch(/3 upcoming visit/);
    expect(actorId).toBe("u1");
    expect(actorRole).toBe("ADMIN");
  });

  it("uses singular wording for one property and one visit", async () => {
    deleteRound.mockResolvedValue({ roundName: "Tiny", deleted: true, unassignedProperties: 1, deletedVisits: 1, detachedVisits: 0 });
    await request(makeApp()).delete("/rounds/r1");
    expect(logActivity.mock.calls[0][1]).toBe('Round deleted: "Tiny" (1 property unassigned, 1 upcoming visit removed)');
  });

  it("logs without an actor when the profile has no role", async () => {
    deleteRound.mockResolvedValue({ roundName: "Tiny", deleted: true, unassignedProperties: 0, deletedVisits: 0, detachedVisits: 0 });
    await request(makeApp({}, { id: "u2", role: null })).delete("/rounds/r1");
    expect(logActivity).toHaveBeenCalledWith("ROUND_DELETED", expect.any(String), "u2", undefined);
  });

  it.each([
    [404, undefined, "Round not found"],
    [409, "ROUND_HAS_EMERGENCIES", "This round has 2 emergency records"],
    [409, "ROUND_HAS_ATTACHED_VISITS", "1 upcoming visit has records attached"],
  ])("passes a %s %s through and logs nothing", async (status, code, msg) => {
    deleteRound.mockRejectedValue(new AppError(status, msg, code));
    const res = await request(makeApp()).delete("/rounds/r1");
    expect(res.status).toBe(status);
    expect(res.body.error).toBe(msg);
    if (code) expect(res.body.code).toBe(code);
    expect(logActivity).not.toHaveBeenCalled();
  });
});
