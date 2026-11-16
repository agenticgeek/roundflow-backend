import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";
import { Prisma } from "../../generated/tenant-client";

// Real router, real service, real requireBusinessAccess and real admin idempotency middleware. Faked: authentication,
// the tenant lookup (two in-memory tenants, picked by x-tenant) and the clock (today = 2026-11-16).
vi.mock("../../services/business-time", () => ({ tenantToday: vi.fn(async () => new Date("2026-11-16T00:00:00.000Z")) }));
vi.mock("../../middleware/requireAuth", () => ({
  requireAuth: (req: any, res: any, next: any) => {
    if (!req.headers["x-role"]) return res.status(401).json({ error: "Unauthorized" });
    req.user = { supabaseUserId: "sb", email: "u@example.com" };
    next();
  },
}));
vi.mock("../../middleware/requireTenantAccess", () => ({
  requireTenantAccess: (req: any, _res: any, next: any) => {
    req.profile = { id: String(req.headers["x-profile"] ?? "p-1"), role: req.headers["x-role"], tenantId: req.headers["x-tenant"] ?? "t1" };
    req.tenantPrisma = tenants[String(req.headers["x-tenant"] ?? "t1")];
    next();
  },
}));

import { closuresRouter } from "../closures";
import { AppError } from "../../lib/app-error";

const d = (s: string) => new Date(`${s}T00:00:00.000Z`);

function makeTenant(rounds: string[]) {
  const closures: any[] = [];
  const idem = new Map<string, any>();
  let seq = 0;
  const match = (c: any, where: any) =>
    (!where?.endDate?.gte || c.endDate >= where.endDate.gte) && (!where?.startDate?.lte || c.startDate <= where.startDate.lte);
  return {
    closures,
    businessClosure: {
      findMany: vi.fn(async ({ where }: any) =>
        closures.filter((c) => match(c, where)).sort((a, b) => a.startDate.getTime() - b.startDate.getTime() || a.createdAt.getTime() - b.createdAt.getTime())
      ),
      findUnique: vi.fn(async ({ where }: any) => closures.find((c) => c.id === where.id) ?? null),
      create: vi.fn(async ({ data }: any) => {
        seq++;
        const now = new Date(Date.UTC(2026, 10, 16, 9, 0, seq));
        const row = { id: `c${seq}`, appliedAt: null, createdAt: now, updatedAt: now, ...data };
        closures.push(row);
        return row;
      }),
      update: vi.fn(async ({ where, data }: any) => Object.assign(closures.find((c) => c.id === where.id), data)),
      delete: vi.fn(async ({ where }: any) => closures.splice(closures.findIndex((c) => c.id === where.id), 1)),
    },
    round: { findMany: vi.fn(async ({ where }: any) => rounds.filter((id) => where.id.in.includes(id)).map((id) => ({ id }))) },
    idempotencyRecord: {
      create: vi.fn(async ({ data }: any) => {
        if (idem.has(data.key)) throw new Prisma.PrismaClientKnownRequestError("dup", { code: "P2002", clientVersion: "x" });
        idem.set(data.key, { createdAt: new Date(), responseStatus: null, responseBody: null, technicianId: null, actorId: null, ...data });
      }),
      findUnique: vi.fn(async ({ where }: any) => idem.get(where.key) ?? null),
      update: vi.fn(async ({ where, data }: any) => Object.assign(idem.get(where.key), data)),
      deleteMany: vi.fn(async ({ where }: any) => ({ count: idem.delete(where.key) ? 1 : 0 })),
    },
  };
}

let tenants: Record<string, ReturnType<typeof makeTenant>>;

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use("/closures", closuresRouter);
  app.use((err: any, _req: any, res: any, _next: any) => {
    if (err instanceof AppError) return res.status(err.statusCode).json({ error: err.message, code: err.code });
    res.status(500).json({ error: "Internal error" });
  });
  return app;
}

const as = (role: string, tenant = "t1") => ({ "x-role": role, "x-tenant": tenant });
const body = { label: "Christmas", startDate: "2026-12-24", endDate: "2027-01-03", mode: "MOVE" };

beforeEach(() => {
  tenants = { t1: makeTenant(["r1", "r2"]), t2: makeTenant(["r9"]) };
});

describe("role matrix", () => {
  it.each(["ADMIN", "MANAGER"])("%s can read and write", async (role) => {
    const app = makeApp();
    const created = await request(app).post("/closures").set(as(role)).send(body);
    expect(created.status).toBe(201);
    expect((await request(app).get("/closures").set(as(role))).status).toBe(200);
    expect((await request(app).patch(`/closures/${created.body.id}`).set(as(role)).send({ label: "X" })).status).toBe(200);
    expect((await request(app).delete(`/closures/${created.body.id}`).set(as(role))).status).toBe(204);
  });

  it("TECHNICIAN is refused on every endpoint (403) and nothing is written", async () => {
    const app = makeApp();
    const t = as("TECHNICIAN");
    expect((await request(app).get("/closures").set(t)).status).toBe(403);
    expect((await request(app).post("/closures").set(t).send(body)).status).toBe(403);
    expect((await request(app).patch("/closures/c1").set(t).send({ label: "x" })).status).toBe(403);
    expect((await request(app).delete("/closures/c1").set(t)).status).toBe(403);
    expect(tenants.t1.closures).toHaveLength(0);
  });

  it("anonymous is refused on every endpoint (401)", async () => {
    const app = makeApp();
    expect((await request(app).get("/closures")).status).toBe(401);
    expect((await request(app).post("/closures").send(body)).status).toBe(401);
    expect((await request(app).patch("/closures/c1").send({})).status).toBe(401);
    expect((await request(app).delete("/closures/c1")).status).toBe(401);
  });
});

describe("POST /closures", () => {
  it("201 with the Closure shape; createdById is the authenticated profile", async () => {
    const res = await request(makeApp()).post("/closures").set({ ...as("ADMIN"), "x-profile": "profile-42" }).send({ ...body, label: "  Christmas ", roundIds: ["r1"], notifyCustomers: true });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      id: "c1", label: "Christmas", startDate: "2026-12-24", endDate: "2027-01-03", mode: "MOVE", notifyCustomers: true,
      roundIds: ["r1"], appliedAt: null, createdAt: "2026-11-16T09:00:01.000Z", updatedAt: "2026-11-16T09:00:01.000Z",
    });
    expect(tenants.t1.closures[0].createdById).toBe("profile-42");
  });

  it.each([
    ["label 81 chars", { ...body, label: "a".repeat(81) }, "VALIDATION_FAILED"],
    ["control character", { ...body, label: "a\u0007b" }, "VALIDATION_FAILED"],
    ["bad date", { ...body, startDate: "2026-02-30" }, "VALIDATION_FAILED"],
    ["extra field", { ...body, foo: 1 }, "VALIDATION_FAILED"],
    ["bad mode", { ...body, mode: "X" }, "VALIDATION_FAILED"],
    ["end before start", { ...body, endDate: "2026-12-23" }, "INVALID_CLOSURE_RANGE"],
    ["367 days", { ...body, startDate: "2026-12-01", endDate: "2027-12-02" }, "INVALID_CLOSURE_RANGE"],
    ["ends in the past", { ...body, startDate: "2026-11-01", endDate: "2026-11-15" }, "INVALID_CLOSURE_RANGE"],
    ["unknown round", { ...body, roundIds: ["r1", "nope"] }, "UNKNOWN_ROUND"],
  ])("400 %s", async (_n, payload, code) => {
    const res = await request(makeApp()).post("/closures").set(as("ADMIN")).send(payload);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe(code);
    expect(tenants.t1.closures).toHaveLength(0);
  });

  it("accepts label 80, 366 days, empty roundIds, duplicate round ids (collapsed)", async () => {
    const app = makeApp();
    expect((await request(app).post("/closures").set(as("ADMIN")).send({ ...body, label: "a".repeat(80) })).status).toBe(201);
    expect((await request(app).post("/closures").set(as("ADMIN")).send({ ...body, startDate: "2026-12-01", endDate: "2027-12-01", roundIds: [] })).status).toBe(201);
    const dup = await request(app).post("/closures").set(as("ADMIN")).send({ ...body, roundIds: ["r1", "r1"] });
    expect(dup.body.roundIds).toEqual(["r1"]);
  });

  it("a non-JSON-object body is 400 VALIDATION_FAILED", async () => {
    const res = await request(makeApp()).post("/closures").set(as("ADMIN")).send([1]);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION_FAILED");
  });
});

describe("GET /closures", () => {
  it("defaults to closures ending today or later, sorted by startDate", async () => {
    const t = tenants.t1;
    const mk = (id: string, s: string, e: string) => t.closures.push({ id, label: id, startDate: d(s), endDate: d(e), mode: "SKIP", notifyCustomers: false, roundIds: [], appliedAt: null, createdAt: new Date(), updatedAt: new Date() });
    mk("late", "2027-03-01", "2027-03-02");
    mk("past", "2026-10-01", "2026-11-15");
    mk("today", "2026-11-10", "2026-11-16");
    mk("mid", "2026-12-24", "2026-12-26");
    const res = await request(makeApp()).get("/closures").set(as("MANAGER"));
    expect(res.status).toBe(200);
    expect(res.body.closures.map((c: any) => c.id)).toEqual(["today", "mid", "late"]);
  });

  it("from/to return the overlapping closures, past ones included", async () => {
    const t = tenants.t1;
    const mk = (id: string, s: string, e: string) => t.closures.push({ id, label: id, startDate: d(s), endDate: d(e), mode: "MOVE", notifyCustomers: false, roundIds: [], appliedAt: null, createdAt: new Date(), updatedAt: new Date() });
    mk("before", "2026-01-01", "2026-01-31");
    mk("overlap", "2026-02-15", "2026-03-15");
    mk("inside", "2026-02-10", "2026-02-12");
    mk("after", "2026-06-01", "2026-06-02");
    const res = await request(makeApp()).get("/closures?from=2026-02-01&to=2026-02-28").set(as("ADMIN"));
    expect(res.body.closures.map((c: any) => c.id)).toEqual(["inside", "overlap"]);
  });

  it("400 VALIDATION_FAILED for a bad date", async () => {
    const res = await request(makeApp()).get("/closures?from=yesterday").set(as("ADMIN"));
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION_FAILED");
  });
});

describe("PATCH /closures/:id", () => {
  it("updates a subset and leaves the rest", async () => {
    const app = makeApp();
    const { body: made } = await request(app).post("/closures").set(as("ADMIN")).send(body);
    const res = await request(app).patch(`/closures/${made.id}`).set(as("ADMIN")).send({ mode: "SKIP", label: " Xmas " });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: made.id, label: "Xmas", mode: "SKIP", startDate: "2026-12-24", endDate: "2027-01-03" });
  });

  it("endDate in the past is refused only when dates are supplied", async () => {
    const app = makeApp();
    // An existing closure that has since ended (seeded directly).
    tenants.t1.closures.push({ id: "old", label: "Old", startDate: d("2026-01-01"), endDate: d("2026-01-05"), mode: "MOVE", notifyCustomers: false, roundIds: [], appliedAt: null, createdAt: new Date(), updatedAt: new Date() });
    expect((await request(app).patch("/closures/old").set(as("ADMIN")).send({ label: "Renamed" })).status).toBe(200);
    const bad = await request(app).patch("/closures/old").set(as("ADMIN")).send({ endDate: "2026-01-06" });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe("INVALID_CLOSURE_RANGE");
    expect((await request(app).patch("/closures/old").set(as("ADMIN")).send({ startDate: "2026-01-02" })).body.code).toBe("INVALID_CLOSURE_RANGE");
    expect((await request(app).patch("/closures/old").set(as("ADMIN")).send({ endDate: "2026-12-31" })).status).toBe(200);
  });

  it("400s: bad round, extra field, bad range", async () => {
    const app = makeApp();
    const { body: made } = await request(app).post("/closures").set(as("ADMIN")).send(body);
    expect((await request(app).patch(`/closures/${made.id}`).set(as("ADMIN")).send({ roundIds: ["nope"] })).body.code).toBe("UNKNOWN_ROUND");
    expect((await request(app).patch(`/closures/${made.id}`).set(as("ADMIN")).send({ nope: 1 })).body.code).toBe("VALIDATION_FAILED");
    expect((await request(app).patch(`/closures/${made.id}`).set(as("ADMIN")).send({ endDate: "2026-12-01" })).body.code).toBe("INVALID_CLOSURE_RANGE");
  });

  it("404 CLOSURE_NOT_FOUND", async () => {
    const res = await request(makeApp()).patch("/closures/missing").set(as("ADMIN")).send({ label: "x" });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("CLOSURE_NOT_FOUND");
  });
});

describe("DELETE /closures/:id", () => {
  it("204 then the closure is gone from the list and a second delete is 404", async () => {
    const app = makeApp();
    const { body: made } = await request(app).post("/closures").set(as("ADMIN")).send(body);
    const del = await request(app).delete(`/closures/${made.id}`).set(as("ADMIN"));
    expect(del.status).toBe(204);
    expect(del.text).toBe("");
    expect((await request(app).get("/closures").set(as("ADMIN"))).body.closures).toEqual([]);
    const again = await request(app).delete(`/closures/${made.id}`).set(as("ADMIN"));
    expect(again.status).toBe(404);
    expect(again.body.code).toBe("CLOSURE_NOT_FOUND");
  });
});

describe("tenant isolation", () => {
  it("a closure in tenant 1 is invisible and untouchable from tenant 2; round ids are per tenant", async () => {
    const app = makeApp();
    const { body: made } = await request(app).post("/closures").set(as("ADMIN", "t1")).send(body);
    expect((await request(app).get("/closures").set(as("ADMIN", "t2"))).body.closures).toEqual([]);
    expect((await request(app).patch(`/closures/${made.id}`).set(as("ADMIN", "t2")).send({ label: "x" })).status).toBe(404);
    expect((await request(app).delete(`/closures/${made.id}`).set(as("ADMIN", "t2"))).status).toBe(404);
    expect((await request(app).post("/closures").set(as("ADMIN", "t2")).send({ ...body, roundIds: ["r1"] })).body.code).toBe("UNKNOWN_ROUND");
    expect((await request(app).post("/closures").set(as("ADMIN", "t2")).send({ ...body, roundIds: ["r9"] })).status).toBe(201);
    expect(tenants.t1.closures).toHaveLength(1);
  });
});

describe("Idempotency-Key", () => {
  it("replays a POST without creating a second closure", async () => {
    const app = makeApp();
    const h = { ...as("ADMIN"), "Idempotency-Key": "k-1" };
    const first = await request(app).post("/closures").set(h).send(body);
    const second = await request(app).post("/closures").set(h).send(body);
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.headers["idempotent-replay"]).toBe("true");
    expect(second.body).toEqual(first.body);
    expect(tenants.t1.closures).toHaveLength(1);
  });

  it("without a key, two identical POSTs create two closures", async () => {
    const app = makeApp();
    await request(app).post("/closures").set(as("ADMIN")).send(body);
    await request(app).post("/closures").set(as("ADMIN")).send(body);
    expect(tenants.t1.closures).toHaveLength(2);
  });

  it("replays a PATCH and the same key on another route is 409 IDEMPOTENCY_KEY_REUSED", async () => {
    const app = makeApp();
    const { body: made } = await request(app).post("/closures").set(as("ADMIN")).send(body);
    const h = { ...as("ADMIN"), "Idempotency-Key": "k-2" };
    const first = await request(app).patch(`/closures/${made.id}`).set(h).send({ label: "One" });
    const replay = await request(app).patch(`/closures/${made.id}`).set(h).send({ label: "One" });
    expect(replay.headers["idempotent-replay"]).toBe("true");
    expect(replay.body).toEqual(first.body);
    expect(tenants.t1.businessClosure.update).toHaveBeenCalledTimes(1);
    const reused = await request(app).delete(`/closures/${made.id}`).set(h);
    expect(reused.status).toBe(409);
    expect(reused.body.code).toBe("IDEMPOTENCY_KEY_REUSED");
  });

  it("a DELETE with a key works and releases the key (204 is not stored)", async () => {
    const app = makeApp();
    const { body: made } = await request(app).post("/closures").set(as("ADMIN")).send(body);
    const res = await request(app).delete(`/closures/${made.id}`).set({ ...as("ADMIN"), "Idempotency-Key": "k-3" });
    expect(res.status).toBe(204);
  });

  it("a failed (400) request is not stored: the same key can be reused with a corrected body", async () => {
    const app = makeApp();
    const h = { ...as("ADMIN"), "Idempotency-Key": "k-4" };
    expect((await request(app).post("/closures").set(h).send({ ...body, mode: "X" })).status).toBe(400);
    expect((await request(app).post("/closures").set(h).send(body)).status).toBe(201);
  });
});
