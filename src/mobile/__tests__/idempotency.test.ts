import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";
import { idempotency, purgeIdempotencyRecords, IDEMPOTENCY_TTL_DAYS, IDEMPOTENCY_HEADER } from "../idempotency";

// The state machine itself is tested in src/lib/__tests__/idempotency.test.ts; this covers the mobile wiring.
function makeTp() {
  return {
    idempotencyRecord: {
      create: vi.fn().mockResolvedValue({}),
      findUnique: vi.fn(),
      update: vi.fn().mockResolvedValue({}),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
  };
}

let tp: ReturnType<typeof makeTp>;
const handler = vi.fn();

function makeApp(technicianId = "t1") {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.tenantPrisma = tp;
    req.technician = { id: technicianId };
    next();
  });
  app.patch("/mobile/visits/:id/start", idempotency(), (req, res) => handler(req, res));
  app.use((err: any, _req: any, res: any, _next: any) => res.status(500).json({ error: err.message }));
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  tp = makeTp();
  handler.mockImplementation((_req: any, res: any) => res.json({ status: "IN_PROGRESS", at: new Date("2026-10-30T09:00:00Z") }));
});

describe("mobile idempotency wiring", () => {
  it("uses X-Idempotency-Key and owns the key as the technician (claim first, then store the response)", async () => {
    expect(IDEMPOTENCY_HEADER).toBe("x-idempotency-key");
    const res = await request(makeApp()).patch("/mobile/visits/v1/start?x=1").set("X-Idempotency-Key", "k1");
    expect(res.status).toBe(200);
    expect(tp.idempotencyRecord.create).toHaveBeenCalledWith({
      data: { key: "k1", technicianId: "t1", actorId: undefined, route: "PATCH /mobile/visits/v1/start", state: "IN_PROGRESS" },
    });
    expect(tp.idempotencyRecord.update).toHaveBeenCalledWith({
      where: { key: "k1" },
      data: { state: "DONE", responseStatus: 200, responseBody: { status: "IN_PROGRESS", at: "2026-10-30T09:00:00.000Z" } },
    });
  });

  it("runs the handler untouched when no key is sent", async () => {
    await request(makeApp()).patch("/mobile/visits/v1/start");
    expect(handler).toHaveBeenCalledTimes(1);
    expect(tp.idempotencyRecord.create).not.toHaveBeenCalled();
  });
});

describe("purgeIdempotencyRecords", () => {
  it("deletes records older than the cut-off and returns the count", async () => {
    tp.idempotencyRecord.deleteMany.mockResolvedValue({ count: 3 });
    const cutoff = new Date(Date.now() - IDEMPOTENCY_TTL_DAYS * 86_400_000);
    expect(await purgeIdempotencyRecords(tp as any, cutoff)).toBe(3);
    expect(tp.idempotencyRecord.deleteMany).toHaveBeenCalledWith({ where: { createdAt: { lt: cutoff } } });
  });
});
