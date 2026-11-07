import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { Prisma } from "../../generated/tenant-client";
import { adminIdempotency, createIdempotency, IDEMPOTENCY_STALE_MS } from "../idempotency";

// An in-memory IdempotencyRecord table with the real unique-key behaviour.
function makeStore() {
  const rows = new Map<string, any>();
  const store = {
    rows,
    create: vi.fn(async ({ data }: { data: any }) => {
      if (rows.has(data.key)) throw new Prisma.PrismaClientKnownRequestError("dup", { code: "P2002", clientVersion: "x" });
      const row = { createdAt: new Date(), responseStatus: null, responseBody: null, technicianId: null, actorId: null, state: "DONE", ...data };
      rows.set(data.key, row);
      return row;
    }),
    findUnique: vi.fn(async ({ where }: { where: { key: string } }) => rows.get(where.key) ?? null),
    update: vi.fn(async ({ where, data }: { where: { key: string }; data: any }) => Object.assign(rows.get(where.key), data)),
    deleteMany: vi.fn(async ({ where }: { where: any }) => {
      const row = rows.get(where.key);
      if (!row) return { count: 0 };
      if (where.state && row.state !== where.state) return { count: 0 };
      if (where.createdAt && !(row.createdAt < where.createdAt.lt)) return { count: 0 };
      rows.delete(where.key);
      return { count: 1 };
    }),
  };
  return store;
}

let store: ReturnType<typeof makeStore>;
let calls: number;

function appFor(mw: express.RequestHandler, opts: { delayMs?: number; status?: number; actor?: string } = {}) {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.tenantPrisma = { idempotencyRecord: store };
    req.profile = { id: opts.actor ?? "profile-1" };
    req.technician = { id: opts.actor ?? "tech-1" };
    next();
  });
  app.post("/things", mw, async (_req, res) => {
    calls++;
    if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
    res.status(opts.status ?? 201).json({ created: calls });
  });
  app.post("/noisy", mw, (_req, res) => {
    calls++;
    res.status(204).end(); // not via res.json
  });
  app.post("/crash", mw, (_req, _res, next) => next(new Error("boom")));
  app.post("/twice", mw, (_req, res) => {
    calls++;
    res.status(201).json({ first: true });
    res.json({ second: true }); // a buggy handler: ignored, must not store or release twice
  });
  app.use((err: any, _req: any, res: any, _next: any) => res.status(500).json({ error: err.message }));
  return app;
}

beforeEach(() => {
  store = makeStore();
  calls = 0;
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("createIdempotency (BE-17)", () => {
  const mobile = () => createIdempotency({ headers: ["x-idempotency-key"], owner: (req) => ({ technicianId: req.technician!.id }) });

  it("no header: the request just runs", async () => {
    const res = await request(appFor(mobile())).post("/things").send({});
    expect(res.status).toBe(201);
    expect(store.create).not.toHaveBeenCalled();
  });

  it("rejects an empty or oversized key with 400 INVALID_IDEMPOTENCY_KEY", async () => {
    for (const key of ["  ", "k".repeat(201)]) {
      const res = await request(appFor(mobile())).post("/things").set("x-idempotency-key", key).send({});
      expect(res.status).toBe(400);
      expect(res.body.code).toBe("INVALID_IDEMPOTENCY_KEY");
    }
  });

  it("inserts the key row FIRST, stores the 2xx response and replays it without re-executing", async () => {
    const app = appFor(mobile());
    const first = await request(app).post("/things").set("x-idempotency-key", "k1").send({});
    expect(first.status).toBe(201);
    expect(store.create).toHaveBeenCalledWith({ data: expect.objectContaining({ key: "k1", technicianId: "tech-1", route: "POST /things", state: "IN_PROGRESS" }) });
    expect(store.rows.get("k1")).toMatchObject({ state: "DONE", responseStatus: 201, responseBody: { created: 1 } });

    const replay = await request(app).post("/things").set("x-idempotency-key", "k1").send({});
    expect(replay.status).toBe(201);
    expect(replay.body).toEqual({ created: 1 });
    expect(replay.headers["idempotent-replay"]).toBe("true");
    expect(calls).toBe(1);
  });

  it("concurrent requests with the same key execute exactly once; the loser gets 409 IDEMPOTENCY_IN_PROGRESS with Retry-After", async () => {
    const app = appFor(mobile(), { delayMs: 60 });
    const [a, b] = await Promise.all([
      request(app).post("/things").set("x-idempotency-key", "same").send({}),
      request(app).post("/things").set("x-idempotency-key", "same").send({}),
    ]);
    expect(calls).toBe(1);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([201, 409]);
    const loser = a.status === 409 ? a : b;
    expect(loser.body.code).toBe("IDEMPOTENCY_IN_PROGRESS");
    expect(loser.headers["retry-after"]).toBe("1");

    const after = await request(app).post("/things").set("x-idempotency-key", "same").send({});
    expect(after.status).toBe(201);
    expect(after.headers["idempotent-replay"]).toBe("true");
    expect(calls).toBe(1);
  });

  it("a non-2xx response releases the key so the request can be retried with it", async () => {
    const failing = appFor(mobile(), { status: 422 });
    expect((await request(failing).post("/things").set("x-idempotency-key", "k2").send({})).status).toBe(422);
    expect(store.rows.has("k2")).toBe(false);
    expect((await request(appFor(mobile())).post("/things").set("x-idempotency-key", "k2").send({})).status).toBe(201);
    expect(calls).toBe(2);
  });

  it("an error thrown by the handler, or a response not sent through res.json, also releases the key", async () => {
    const app = appFor(mobile());
    expect((await request(app).post("/crash").set("x-idempotency-key", "k3").send({})).status).toBe(500);
    expect(store.rows.has("k3")).toBe(false);
    expect((await request(app).post("/noisy").set("x-idempotency-key", "k4").send({})).status).toBe(204);
    await vi.waitFor(() => expect(store.rows.has("k4")).toBe(false));
  });

  it("a handler that calls res.json twice stores the first response only", async () => {
    const res = await request(appFor(mobile())).post("/twice").set("x-idempotency-key", "k12").send({});
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ first: true });
    await vi.waitFor(() => expect(store.rows.get("k12")).toMatchObject({ state: "DONE", responseBody: { first: true } }));
    expect(store.update).toHaveBeenCalledTimes(1);
  });

  it("403 IDEMPOTENCY_KEY_CONFLICT when the key belongs to another user, 409 IDEMPOTENCY_KEY_REUSED for another route", async () => {
    await request(appFor(mobile(), { actor: "tech-A" })).post("/things").set("x-idempotency-key", "k5").send({});
    const other = await request(appFor(mobile(), { actor: "tech-B" })).post("/things").set("x-idempotency-key", "k5").send({});
    expect(other.status).toBe(403);
    expect(other.body.code).toBe("IDEMPOTENCY_KEY_CONFLICT");
    const reused = await request(appFor(mobile(), { actor: "tech-A" })).post("/noisy").set("x-idempotency-key", "k5").send({});
    expect(reused.status).toBe(409);
    expect(reused.body.code).toBe("IDEMPOTENCY_KEY_REUSED");
  });

  it("takes over a stale IN_PROGRESS row (the first request died) and runs the request", async () => {
    store.rows.set("k6", {
      key: "k6", technicianId: "tech-1", actorId: null, route: "POST /things", state: "IN_PROGRESS",
      createdAt: new Date(Date.now() - IDEMPOTENCY_STALE_MS - 1000),
    });
    const res = await request(appFor(mobile())).post("/things").set("x-idempotency-key", "k6").send({});
    expect(res.status).toBe(201);
    expect(calls).toBe(1);
  });

  it("a claim that vanishes between the failed insert and the read is retried; persistent failure surfaces as 500", async () => {
    store.create.mockRejectedValueOnce(new Prisma.PrismaClientKnownRequestError("dup", { code: "P2002", clientVersion: "x" }));
    const res = await request(appFor(mobile())).post("/things").set("x-idempotency-key", "k7").send({});
    expect(res.status).toBe(201);
    expect(calls).toBe(1);

    store.create.mockRejectedValue(new Prisma.PrismaClientKnownRequestError("dup", { code: "P2002", clientVersion: "x" }));
    const bad = await request(appFor(mobile())).post("/things").set("x-idempotency-key", "k8").send({});
    expect(bad.status).toBe(500);
  });

  it("any other database error while claiming is passed to the error handler", async () => {
    store.create.mockRejectedValue(new Error("db down"));
    const res = await request(appFor(mobile())).post("/things").set("x-idempotency-key", "k9").send({});
    expect(res.status).toBe(500);
    expect(calls).toBe(0);
  });

  it("storing the response failing does not lose the response (logged)", async () => {
    store.update.mockRejectedValueOnce(new Error("db"));
    const res = await request(appFor(mobile())).post("/things").set("x-idempotency-key", "k10").send({});
    expect(res.status).toBe(201);
    expect(console.error).toHaveBeenCalledWith("[idempotency] failed to store response:", expect.any(Error));
  });

  it("releasing a failed request's key failing is logged, not thrown", async () => {
    store.deleteMany.mockRejectedValueOnce(new Error("db"));
    const res = await request(appFor(mobile(), { status: 400 })).post("/things").set("x-idempotency-key", "k11").send({});
    expect(res.status).toBe(400);
    expect(console.error).toHaveBeenCalledWith("[idempotency] failed to release key:", expect.any(Error));
  });
});

describe("adminIdempotency (BE-17)", () => {
  it("accepts Idempotency-Key, namespaces the stored key by profile, and dedupes admin writes", async () => {
    const app = appFor(adminIdempotency());
    const first = await request(app).post("/things").set("Idempotency-Key", "abc").send({});
    expect(first.status).toBe(201);
    expect([...store.rows.keys()]).toEqual(["admin:profile-1:abc"]);
    expect(store.rows.get("admin:profile-1:abc")).toMatchObject({ actorId: "profile-1", technicianId: undefined, state: "DONE" });

    const replay = await request(app).post("/things").set("Idempotency-Key", "abc").send({});
    expect(replay.headers["idempotent-replay"]).toBe("true");
    expect(calls).toBe(1);
  });

  it("the same key from another admin is a different key (no cross-user collision)", async () => {
    await request(appFor(adminIdempotency(), { actor: "p-A" })).post("/things").set("Idempotency-Key", "abc").send({});
    const b = await request(appFor(adminIdempotency(), { actor: "p-B" })).post("/things").set("Idempotency-Key", "abc").send({});
    expect(b.status).toBe(201);
    expect(calls).toBe(2);
  });

  it("without the header the write is unchanged (optional)", async () => {
    const res = await request(appFor(adminIdempotency())).post("/things").send({});
    expect(res.status).toBe(201);
    expect(store.create).not.toHaveBeenCalled();
  });

  it("also honours X-Idempotency-Key", async () => {
    const res = await request(appFor(adminIdempotency())).post("/things").set("X-Idempotency-Key", "xyz").send({});
    expect(res.status).toBe(201);
    expect(store.rows.has("admin:profile-1:xyz")).toBe(true);
  });
});
