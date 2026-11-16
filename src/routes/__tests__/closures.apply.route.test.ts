import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";
import { Prisma } from "../../generated/tenant-client";

// Real router, real requireBusinessAccess and real admin idempotency middleware. Faked: authentication, the tenant,
// and the apply service (its behaviour is covered by services/__tests__/closure-apply.service.test.ts).
const preview = vi.fn();
const apply = vi.fn();
vi.mock("../../services/closure-apply.service", () => ({
  createClosureApplyService: vi.fn(() => ({ preview, apply })),
}));
vi.mock("../../services/closure.service", () => ({ createClosureService: vi.fn(() => ({})) }));
vi.mock("../../middleware/requireAuth", () => ({
  requireAuth: (req: any, res: any, next: any) => {
    if (!req.headers["x-role"]) return res.status(401).json({ error: "Unauthorized" });
    req.user = { supabaseUserId: "sb", email: "u@example.com" };
    next();
  },
}));
vi.mock("../../middleware/requireTenantAccess", () => ({
  requireTenantAccess: (req: any, _res: any, next: any) => {
    req.profile = { id: "p-7", role: req.headers["x-role"], tenantId: "t1" };
    req.tenantPrisma = tenant;
    next();
  },
}));

import { closuresRouter } from "../closures";
import { AppError } from "../../lib/app-error";

const idem = new Map<string, any>();
const tenant = {
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

function makeApp(json = true) {
  const app = express();
  if (json) app.use(express.json());
  app.use("/closures", closuresRouter);
  app.use((err: any, _req: any, res: any, _next: any) => {
    if (err instanceof AppError) return res.status(err.statusCode).json({ error: err.message, code: err.code });
    res.status(500).json({ error: "Internal error" });
  });
  return app;
}

const as = (role: string) => ({ "x-role": role });
const RESULT = { closureId: "k1", mode: "MOVE", moved: 3, skipped: 0, conflicts: [], notifiedTechnicians: 1, notifiedCustomers: 0, appliedAt: "2026-11-16T09:00:00.000Z" };

beforeEach(() => {
  vi.clearAllMocks();
  idem.clear();
  preview.mockResolvedValue({ closureId: "k1", mode: "MOVE" });
  apply.mockResolvedValue(RESULT);
});

describe("role matrix", () => {
  it.each(["ADMIN", "MANAGER"])("%s can preview and apply", async (role) => {
    expect((await request(makeApp()).post("/closures/k1/apply/preview").set(as(role))).status).toBe(200);
    expect((await request(makeApp()).post("/closures/k1/apply").set(as(role)).send({})).status).toBe(200);
  });

  it("TECHNICIAN is refused (403) and anonymous is 401; nothing runs", async () => {
    const app = makeApp();
    expect((await request(app).post("/closures/k1/apply/preview").set(as("TECHNICIAN"))).status).toBe(403);
    expect((await request(app).post("/closures/k1/apply").set(as("TECHNICIAN")).send({})).status).toBe(403);
    expect((await request(app).post("/closures/k1/apply/preview")).status).toBe(401);
    expect((await request(app).post("/closures/k1/apply").send({})).status).toBe(401);
    expect(preview).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
  });
});

describe("POST /closures/:id/apply/preview", () => {
  it("returns the service preview for the id", async () => {
    const res = await request(makeApp()).post("/closures/k9/apply/preview").set(as("ADMIN"));
    expect(res.body).toEqual({ closureId: "k1", mode: "MOVE" });
    expect(preview).toHaveBeenCalledWith("k9");
  });

  it("maps service errors (404, 409)", async () => {
    preview.mockRejectedValueOnce(new AppError(404, "Closure not found", "CLOSURE_NOT_FOUND"));
    const nf = await request(makeApp()).post("/closures/k1/apply/preview").set(as("ADMIN"));
    expect([nf.status, nf.body.code]).toEqual([404, "CLOSURE_NOT_FOUND"]);
    preview.mockRejectedValueOnce(new AppError(409, "ended", "CLOSURE_ENDED"));
    const ended = await request(makeApp()).post("/closures/k1/apply/preview").set(as("ADMIN"));
    expect([ended.status, ended.body.code]).toEqual([409, "CLOSURE_ENDED"]);
  });
});

describe("POST /closures/:id/apply", () => {
  it("passes the id, the actor and the body flag to the service", async () => {
    const res = await request(makeApp()).post("/closures/k9/apply").set(as("MANAGER")).send({ notifyCustomers: true });
    expect(res.status).toBe(200);
    expect(res.body).toEqual(RESULT);
    expect(apply).toHaveBeenCalledWith("k9", { notifyCustomers: true, actor: { id: "p-7", role: "MANAGER" } });
  });

  it("an empty body, an absent body and notifyCustomers:false are valid", async () => {
    await request(makeApp()).post("/closures/k1/apply").set(as("ADMIN")).send({});
    expect(apply).toHaveBeenLastCalledWith("k1", { actor: { id: "p-7", role: "ADMIN" } });
    await request(makeApp(false)).post("/closures/k1/apply").set(as("ADMIN"));
    expect(apply).toHaveBeenLastCalledWith("k1", { actor: { id: "p-7", role: "ADMIN" } });
    await request(makeApp()).post("/closures/k1/apply").set(as("ADMIN")).send({ notifyCustomers: false });
    expect(apply).toHaveBeenLastCalledWith("k1", { notifyCustomers: false, actor: { id: "p-7", role: "ADMIN" } });
  });

  it.each([
    ["wrong type", { notifyCustomers: "yes" }, "notifyCustomers"],
    ["unknown field", { notifyCustomers: true, extra: 1 }, "extra"],
    ["array body", [1], "body"],
  ])("400 VALIDATION_FAILED: %s", async (_n, payload, path) => {
    const res = await request(makeApp()).post("/closures/k1/apply").set(as("ADMIN")).send(payload as object);
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain(path);
    expect(apply).not.toHaveBeenCalled();
  });

  it("maps service errors (404, 409)", async () => {
    apply.mockRejectedValueOnce(new AppError(404, "Closure not found", "CLOSURE_NOT_FOUND"));
    expect((await request(makeApp()).post("/closures/x/apply").set(as("ADMIN")).send({})).body.code).toBe("CLOSURE_NOT_FOUND");
    apply.mockRejectedValueOnce(new AppError(409, "ended", "CLOSURE_ENDED"));
    const ended = await request(makeApp()).post("/closures/x/apply").set(as("ADMIN")).send({});
    expect([ended.status, ended.body.code]).toEqual([409, "CLOSURE_ENDED"]);
  });

  it("an Idempotency-Key replay returns the stored result without applying twice; another route is 409", async () => {
    const app = makeApp();
    const h = { ...as("ADMIN"), "Idempotency-Key": "ap-1" };
    const first = await request(app).post("/closures/k1/apply").set(h).send({});
    const second = await request(app).post("/closures/k1/apply").set(h).send({});
    expect(second.headers["idempotent-replay"]).toBe("true");
    expect(second.body).toEqual(first.body);
    expect(apply).toHaveBeenCalledTimes(1);
    const reused = await request(app).post("/closures/k2/apply").set(h).send({});
    expect([reused.status, reused.body.code]).toEqual([409, "IDEMPOTENCY_KEY_REUSED"]);
  });
});
