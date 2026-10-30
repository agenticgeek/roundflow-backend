import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";
import { idempotency, purgeIdempotencyRecords, IDEMPOTENCY_TTL_DAYS } from "../idempotency";

function makeTp() {
  return {
    idempotencyRecord: {
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({}),
      deleteMany: vi.fn(),
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

describe("idempotency middleware", () => {
  it("runs the handler and stores nothing when no key is sent", async () => {
    const res = await request(makeApp()).patch("/mobile/visits/v1/start");
    expect(res.status).toBe(200);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(tp.idempotencyRecord.findUnique).not.toHaveBeenCalled();
    expect(tp.idempotencyRecord.create).not.toHaveBeenCalled();
  });

  it.each(["", " ", "k".repeat(201)])("400 INVALID_IDEMPOTENCY_KEY for %j", async (key) => {
    const res = await request(makeApp()).patch("/mobile/visits/v1/start").set("X-Idempotency-Key", key);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("INVALID_IDEMPOTENCY_KEY");
    expect(handler).not.toHaveBeenCalled();
  });

  it("stores a 2xx response under the key (JSON-normalised) on first use", async () => {
    const res = await request(makeApp()).patch("/mobile/visits/v1/start?x=1").set("X-Idempotency-Key", "k1");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "IN_PROGRESS", at: "2026-10-30T09:00:00.000Z" });
    expect(tp.idempotencyRecord.create).toHaveBeenCalledWith({
      data: {
        key: "k1",
        technicianId: "t1",
        route: "PATCH /mobile/visits/v1/start",
        responseStatus: 200,
        responseBody: { status: "IN_PROGRESS", at: "2026-10-30T09:00:00.000Z" },
      },
    });
  });

  it("still sends the response when storing it fails", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    tp.idempotencyRecord.create.mockRejectedValue(new Error("unique violation"));
    const res = await request(makeApp()).patch("/mobile/visits/v1/start").set("X-Idempotency-Key", "k1");
    expect(res.status).toBe(200);
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  it("does not store non-2xx responses, so a fixed retry can reuse the key", async () => {
    handler.mockImplementation((_req: any, res: any) => res.status(400).json({ error: "bad" }));
    const res = await request(makeApp()).patch("/mobile/visits/v1/start").set("X-Idempotency-Key", "k1");
    expect(res.status).toBe(400);
    expect(tp.idempotencyRecord.create).not.toHaveBeenCalled();
  });

  it("replays the stored status and body without re-running the handler", async () => {
    tp.idempotencyRecord.findUnique.mockResolvedValue({
      key: "k1", technicianId: "t1", route: "PATCH /mobile/visits/v1/start", responseStatus: 201, responseBody: { recorded: true },
    });
    const res = await request(makeApp()).patch("/mobile/visits/v1/start").set("X-Idempotency-Key", "k1");
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ recorded: true });
    expect(res.headers["idempotent-replay"]).toBe("true");
    expect(handler).not.toHaveBeenCalled();
  });

  it("403 IDEMPOTENCY_KEY_CONFLICT when the key belongs to another technician", async () => {
    tp.idempotencyRecord.findUnique.mockResolvedValue({
      key: "k1", technicianId: "t2", route: "PATCH /mobile/visits/v1/start", responseStatus: 200, responseBody: {},
    });
    const res = await request(makeApp()).patch("/mobile/visits/v1/start").set("X-Idempotency-Key", "k1");
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("IDEMPOTENCY_KEY_CONFLICT");
    expect(handler).not.toHaveBeenCalled();
  });

  it("409 IDEMPOTENCY_KEY_REUSED when the same technician reuses a key on another request", async () => {
    tp.idempotencyRecord.findUnique.mockResolvedValue({
      key: "k1", technicianId: "t1", route: "PATCH /mobile/visits/v2/start", responseStatus: 200, responseBody: {},
    });
    const res = await request(makeApp()).patch("/mobile/visits/v1/start").set("X-Idempotency-Key", "k1");
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("IDEMPOTENCY_KEY_REUSED");
  });

  it("forwards lookup errors to the error handler", async () => {
    tp.idempotencyRecord.findUnique.mockRejectedValue(new Error("db down"));
    const res = await request(makeApp()).patch("/mobile/visits/v1/start").set("X-Idempotency-Key", "k1");
    expect(res.status).toBe(500);
    expect(handler).not.toHaveBeenCalled();
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
