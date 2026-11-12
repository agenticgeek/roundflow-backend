import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import express from "express";

// BUG-005 (AUTH-001g): two simultaneous signups for one user must both succeed with the same profile.
const profileFindUnique = vi.fn();
const txTenantCreate = vi.fn();
const txProfileCreate = vi.fn();
vi.mock("../../lib/prisma", () => ({
  prisma: {
    profile: { findUnique: (...a: unknown[]) => profileFindUnique(...a) },
    $transaction: (fn: (tx: unknown) => unknown) =>
      fn({ tenant: { create: (...a: unknown[]) => txTenantCreate(...a) }, profile: { create: (...a: unknown[]) => txProfileCreate(...a) } }),
  },
}));
vi.mock("../../middleware/requireAuth", () => ({
  requireAuth: (req: any, _res: any, next: any) => { req.user = { supabaseUserId: "sb1", email: "a@b.co" }; next(); },
}));
const provisionTenantSchema = vi.fn();
vi.mock("../../lib/tenant-provisioning", () => ({ provisionTenantSchema: (...a: unknown[]) => provisionTenantSchema(...a) }));
const seedTenantDefaults = vi.fn();
vi.mock("../../lib/tenant-defaults", () => ({ seedTenantDefaults: (...a: unknown[]) => seedTenantDefaults(...a) }));
vi.mock("../../lib/tenant-prisma-manager", () => ({ getTenantPrismaForSchema: () => ({}) }));

import { authRouter } from "../auth";
import { errorHandler } from "../../lib/error-handler";

const app = express();
app.use(express.json());
app.use("/auth", authRouter);
app.use(errorHandler);

const existing = { id: "p1", tenantId: "ten1", tenant: { schemaName: "t_aaaaaaaaaaaaaaaaaaaa" } };

beforeEach(() => {
  vi.clearAllMocks();
  provisionTenantSchema.mockResolvedValue(undefined);
  seedTenantDefaults.mockResolvedValue(undefined);
  txTenantCreate.mockResolvedValue({ id: "ten1" });
});

describe("POST /auth/signup concurrency", () => {
  it("a normal first signup creates the tenant and profile (201) and provisions once", async () => {
    profileFindUnique.mockResolvedValue(null);
    txProfileCreate.mockResolvedValue({ id: "p1", tenant: { schemaName: "t_aaaaaaaaaaaaaaaaaaaa" } });
    const res = await request(app).post("/auth/signup").send({ name: "Ann" });
    expect(res.status).toBe(201);
    expect(provisionTenantSchema).toHaveBeenCalledTimes(1);
  });

  it("the loser of the unique-constraint race returns the winner profile (200)", async () => {
    profileFindUnique.mockResolvedValueOnce(null).mockResolvedValueOnce(existing);
    txProfileCreate.mockRejectedValue(Object.assign(new Error("Unique constraint failed on supabaseUserId"), { code: "P2002" }));
    const res = await request(app).post("/auth/signup").send({ name: "Ann" });
    expect(res.status).toBe(200);
    expect(res.body.profile.id).toBe("p1");
  });

  it("two simultaneous requests provision the tenant schema once at a time (shared in-flight promise)", async () => {
    profileFindUnique.mockResolvedValue(existing);
    let running = 0;
    let peak = 0;
    provisionTenantSchema.mockImplementation(async () => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 20));
      running--;
    });
    const [a, b] = await Promise.all([request(app).post("/auth/signup").send({ name: "Ann" }), request(app).post("/auth/signup").send({ name: "Ann" })]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(peak).toBe(1);
    expect(provisionTenantSchema).toHaveBeenCalledTimes(1);
  });

  it("a failed provisioning is not cached: the next call tries again", async () => {
    profileFindUnique.mockResolvedValue(existing);
    provisionTenantSchema.mockRejectedValueOnce(new Error("migration failed")).mockResolvedValue(undefined);
    expect((await request(app).post("/auth/signup").send({ name: "Ann" })).status).toBe(500);
    expect((await request(app).post("/auth/signup").send({ name: "Ann" })).status).toBe(200);
  });
});
