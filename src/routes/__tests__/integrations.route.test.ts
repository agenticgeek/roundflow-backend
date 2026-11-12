import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import express from "express";

vi.mock("../../middleware/requireAuth", () => ({ requireAuth: (_q: any, _s: any, n: any) => n() }));
vi.mock("../../middleware/requireTenantAccess", () => ({
  requireTenantAccess: (req: any, _res: any, next: any) => {
    req.profile = { id: "p1", role: req.headers["x-role"] ?? "ADMIN", tenantId: "t1" };
    req.tenantPrisma = (globalThis as any).__tp;
    next();
  },
}));

import { integrationsRouter } from "../integrations";
import { errorHandler } from "../../lib/error-handler";

const app = express();
app.use(express.json());
app.use("/integrations", integrationsRouter);
app.use(errorHandler);

let tp: any;
beforeEach(() => {
  tp = {
    integrationOutbox: {
      count: vi.fn().mockResolvedValue(3),
      findMany: vi.fn().mockResolvedValue([
        { id: "o1", eventType: "message.send", status: "dead", attempts: 6, lastError: "boom", payload: { customerId: "c1", body: "secret text" }, batchId: null, createdAt: new Date("2026-11-01"), processedAt: new Date("2026-11-02") },
        { id: "o2", eventType: "x", status: "dead", attempts: 6, lastError: null, payload: null, batchId: "b1", createdAt: new Date("2026-11-01"), processedAt: null },
      ]),
      findUnique: vi.fn(),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    activityLog: { create: vi.fn().mockResolvedValue({}) },
  };
  (globalThis as any).__tp = tp;
});

describe("GET /integrations/outbox (BE-12)", () => {
  it("lists dead rows by default, newest first, without the payload body", async () => {
    const res = await request(app).get("/integrations/outbox");
    expect(res.status).toBe(200);
    expect(tp.integrationOutbox.findMany).toHaveBeenCalledWith({ where: { status: "dead" }, orderBy: { createdAt: "desc" }, take: 50, skip: 0 });
    expect(res.body.rows[0]).toEqual({
      id: "o1", eventType: "message.send", status: "dead", attempts: 6, lastError: "boom", customerId: "c1", batchId: null,
      createdAt: "2026-11-01T00:00:00.000Z", processedAt: "2026-11-02T00:00:00.000Z",
    });
    expect(JSON.stringify(res.body)).not.toContain("secret text");
    expect(res.body.rows[1].customerId).toBeNull();
    expect(res.body.pagination).toEqual({ page: 1, pageSize: 50, total: 3, totalPages: 1 });
  });

  it("filters by status=failed and pages", async () => {
    await request(app).get("/integrations/outbox?status=failed&page=2&pageSize=10");
    expect(tp.integrationOutbox.findMany).toHaveBeenCalledWith({ where: { status: "failed" }, orderBy: { createdAt: "desc" }, take: 10, skip: 10 });
  });

  it("400s on any other status", async () => {
    const res = await request(app).get("/integrations/outbox?status=pending");
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("INVALID_STATUS");
  });

  it("is ADMIN only: a MANAGER gets 403 ADMIN_ONLY", async () => {
    const res = await request(app).get("/integrations/outbox").set("x-role", "MANAGER");
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("ADMIN_ONLY");
  });
});

describe("POST /integrations/outbox/:id/replay (BE-12)", () => {
  it("resets a dead row to pending with a fresh attempt budget and records who did it", async () => {
    tp.integrationOutbox.findUnique.mockResolvedValue({ id: "o1", eventType: "message.send", status: "dead" });
    const res = await request(app).post("/integrations/outbox/o1/replay");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: "o1", status: "pending" });
    expect(tp.integrationOutbox.updateMany).toHaveBeenCalledWith({
      where: { id: "o1", status: { in: ["dead", "failed"] } },
      data: { status: "pending", attempts: 0, lastError: null, processedAt: null, runAfter: null },
    });
    expect(tp.activityLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ type: "OUTBOX_REPLAYED", actorId: "p1", actorRole: "ADMIN", entityId: "o1" }),
    });
  });

  it("404 OUTBOX_NOT_FOUND for an unknown row", async () => {
    tp.integrationOutbox.findUnique.mockResolvedValue(null);
    const res = await request(app).post("/integrations/outbox/nope/replay");
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("OUTBOX_NOT_FOUND");
  });

  it("409 OUTBOX_NOT_REPLAYABLE for a row that is not dead/failed (or lost the race)", async () => {
    tp.integrationOutbox.findUnique.mockResolvedValue({ id: "o1", eventType: "x", status: "sent" });
    tp.integrationOutbox.updateMany.mockResolvedValue({ count: 0 });
    const res = await request(app).post("/integrations/outbox/o1/replay");
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("OUTBOX_NOT_REPLAYABLE");
    expect(tp.activityLog.create).not.toHaveBeenCalled();
  });

  it("a MANAGER cannot replay", async () => {
    const res = await request(app).post("/integrations/outbox/o1/replay").set("x-role", "MANAGER");
    expect(res.status).toBe(403);
    expect(tp.integrationOutbox.updateMany).not.toHaveBeenCalled();
  });
});
