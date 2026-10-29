import { it, expect, vi, beforeEach, describe } from "vitest";
import request from "supertest";
import express from "express";

const inviteFindFirst = vi.fn();
const inviteFindMany = vi.fn();
const inviteFindUnique = vi.fn();
const inviteCreate = vi.fn();
const inviteDelete = vi.fn();
const inviteDeleteMany = vi.fn();
const inviteUpdate = vi.fn();
const profileFindUnique = vi.fn();
const tenantFindUnique = vi.fn();
const txProfileCreate = vi.fn();
const txInviteUpdate = vi.fn();

vi.mock("../../lib/prisma", () => ({
  prisma: {
    tenantInvite: {
      findFirst: (...a: unknown[]) => inviteFindFirst(...a),
      findMany: (...a: unknown[]) => inviteFindMany(...a),
      findUnique: (...a: unknown[]) => inviteFindUnique(...a),
      create: (...a: unknown[]) => inviteCreate(...a),
      delete: (...a: unknown[]) => inviteDelete(...a),
      deleteMany: (...a: unknown[]) => inviteDeleteMany(...a),
      update: (...a: unknown[]) => inviteUpdate(...a),
    },
    profile: { findUnique: (...a: unknown[]) => profileFindUnique(...a) },
    tenant: { findUnique: (...a: unknown[]) => tenantFindUnique(...a) },
    $transaction: (fn: (tx: unknown) => unknown) =>
      fn({
        profile: { create: (...a: unknown[]) => txProfileCreate(...a) },
        tenantInvite: { update: (...a: unknown[]) => txInviteUpdate(...a) },
      }),
  },
}));

const schemaTechFindUnique = vi.fn();
const schemaTechUpdate = vi.fn();
vi.mock("../../lib/tenant-prisma-manager", () => ({
  getTenantPrismaForSchema: () => ({
    technician: {
      findUnique: (...a: unknown[]) => schemaTechFindUnique(...a),
      update: (...a: unknown[]) => schemaTechUpdate(...a),
    },
  }),
}));

const sendInviteEmail = vi.fn();
vi.mock("../../lib/email", () => ({
  INVITE_TTL_DAYS: 7,
  sendInviteEmail: (...a: unknown[]) => sendInviteEmail(...a),
}));

// The signed-in user's email comes from an x-email header so tests can
// simulate a mismatch.
vi.mock("../../middleware/requireAuth", () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.user = { supabaseUserId: "sb1", email: req.headers["x-email"] ?? "jess@example.com" };
    next();
  },
}));
const reqTechFindUnique = vi.fn();
vi.mock("../../middleware/requireTenantAccess", () => ({
  requireTenantAccess: (req: any, _res: any, next: any) => {
    req.profile = { tenantId: "t1" };
    req.tenantPrisma = { technician: { findUnique: (...a: unknown[]) => reqTechFindUnique(...a) } };
    next();
  },
}));
vi.mock("../../middleware/requireRole", () => ({
  requireBusinessAccess: () => (_req: any, _res: any, next: any) => next(),
}));

import { invitesRouter } from "../../routes/invites";
import { AppError } from "../../lib/app-error";

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use("/invites", invitesRouter);
  app.use((err: any, _req: any, res: any, _next: any) => {
    if (err instanceof AppError) {
      return res.status(err.statusCode).json(err.code ? { error: err.message, code: err.code } : { error: err.message });
    }
    res.status(500).json({ error: "Internal error" });
  });
  return app;
}

const future = () => new Date(Date.now() + 86_400_000);
const past = () => new Date(Date.now() - 86_400_000);
const pendingInvite = (over: Record<string, unknown> = {}) => ({
  id: "inv1",
  tenantId: "t1",
  email: "jess@example.com",
  role: "TECHNICIAN",
  token: "tok1",
  expiresAt: future(),
  acceptedAt: null,
  technicianId: null,
  ...over,
});

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  process.env.INVITE_BASE_URL = "https://app.example";
  inviteFindFirst.mockResolvedValue(null);
  inviteDeleteMany.mockResolvedValue({ count: 0 });
  sendInviteEmail.mockResolvedValue(undefined);
});

// ---------------------------------------------------------------------------
// POST /invites
// ---------------------------------------------------------------------------

describe("POST /invites", () => {
  it("creates a TECHNICIAN invite by default and emails the accept link", async () => {
    inviteCreate.mockResolvedValue(pendingInvite());
    const res = await request(makeApp()).post("/invites").send({ email: " Jess@Example.com " });

    expect(res.status).toBe(201);
    expect(inviteCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ tenantId: "t1", email: "jess@example.com", role: "TECHNICIAN", technicianId: null }),
    });
    expect(sendInviteEmail).toHaveBeenCalledWith({
      to: "jess@example.com",
      inviteUrl: "https://app.example/accept-invite?token=tok1",
    });
  });

  it("accepts an explicit role and a technicianId whose technician has no login yet", async () => {
    reqTechFindUnique.mockResolvedValue({ id: "tech1", profileId: null });
    inviteCreate.mockResolvedValue(pendingInvite({ role: "MANAGER", technicianId: "tech1" }));
    const res = await request(makeApp())
      .post("/invites")
      .send({ email: "jess@example.com", role: "MANAGER", technicianId: "tech1" });

    expect(res.status).toBe(201);
    expect(inviteCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ role: "MANAGER", technicianId: "tech1" }),
    });
  });

  it("400s on an invalid email", async () => {
    const res = await request(makeApp()).post("/invites").send({ email: "nope" });
    expect(res.status).toBe(400);
  });

  it("400s on an unknown role", async () => {
    const res = await request(makeApp()).post("/invites").send({ email: "jess@example.com", role: "OWNER" });
    expect(res.status).toBe(400);
  });

  it("404s when technicianId does not exist", async () => {
    reqTechFindUnique.mockResolvedValue(null);
    const res = await request(makeApp()).post("/invites").send({ email: "jess@example.com", technicianId: "x" });
    expect(res.status).toBe(404);
  });

  it("409s when the technician already has a login", async () => {
    reqTechFindUnique.mockResolvedValue({ id: "tech1", profileId: "p1" });
    const res = await request(makeApp()).post("/invites").send({ email: "jess@example.com", technicianId: "tech1" });
    expect(res.status).toBe(409);
  });

  it("409s when an unexpired pending invite exists", async () => {
    inviteFindFirst.mockResolvedValue(pendingInvite());
    const res = await request(makeApp()).post("/invites").send({ email: "jess@example.com" });
    expect(res.status).toBe(409);
    expect(inviteCreate).not.toHaveBeenCalled();
  });

  it("rolls back the invite and 503s when the email fails", async () => {
    inviteCreate.mockResolvedValue(pendingInvite());
    sendInviteEmail.mockRejectedValue(new Error("smtp"));
    inviteDelete.mockResolvedValue({});
    const res = await request(makeApp()).post("/invites").send({ email: "jess@example.com" });

    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/try again/);
    expect(inviteDelete).toHaveBeenCalledWith({ where: { id: "inv1" } });
  });

  it("503s with a support message when the rollback also fails", async () => {
    inviteCreate.mockResolvedValue(pendingInvite());
    sendInviteEmail.mockRejectedValue(new Error("smtp"));
    inviteDelete.mockRejectedValue(new Error("db"));
    const res = await request(makeApp()).post("/invites").send({ email: "jess@example.com" });

    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/Contact support/);
  });
});

// ---------------------------------------------------------------------------
// GET /invites
// ---------------------------------------------------------------------------

it("GET /invites lists the tenant's unaccepted invites with an expired flag", async () => {
  const fresh = { id: "a", email: "a@x.com", expiresAt: future() };
  const stale = { id: "b", email: "b@x.com", expiresAt: past() };
  inviteFindMany.mockResolvedValue([fresh, stale]);

  const res = await request(makeApp()).get("/invites");

  expect(res.status).toBe(200);
  expect(res.body.map((i: any) => [i.id, i.expired])).toEqual([["a", false], ["b", true]]);
  expect(inviteFindMany).toHaveBeenCalledWith(
    expect.objectContaining({ where: { tenantId: "t1", acceptedAt: null }, orderBy: { createdAt: "desc" } })
  );
  expect(inviteFindMany.mock.calls[0][0].select.token).toBeUndefined();
});

// ---------------------------------------------------------------------------
// DELETE /invites/:id
// ---------------------------------------------------------------------------

describe("DELETE /invites/:id", () => {
  it("deletes a pending invite in the caller's tenant", async () => {
    inviteFindFirst.mockResolvedValue(pendingInvite());
    const res = await request(makeApp()).delete("/invites/inv1");

    expect(res.status).toBe(204);
    expect(inviteFindFirst).toHaveBeenCalledWith({ where: { id: "inv1", tenantId: "t1" } });
    expect(inviteDelete).toHaveBeenCalledWith({ where: { id: "inv1" } });
  });

  it("404s for an unknown (or other-tenant) invite", async () => {
    const res = await request(makeApp()).delete("/invites/nope");
    expect(res.status).toBe(404);
  });

  it("409s with INVITE_ACCEPTED when the invite was already accepted", async () => {
    inviteFindFirst.mockResolvedValue(pendingInvite({ acceptedAt: new Date() }));
    const res = await request(makeApp()).delete("/invites/inv1");
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("INVITE_ACCEPTED");
    expect(inviteDelete).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// POST /invites/:id/resend
// ---------------------------------------------------------------------------

describe("POST /invites/:id/resend", () => {
  it("re-sends the same link and resets the expiry", async () => {
    inviteFindFirst.mockResolvedValue(pendingInvite({ expiresAt: past() }));
    inviteUpdate.mockResolvedValue(pendingInvite());
    const res = await request(makeApp()).post("/invites/inv1/resend");

    expect(res.status).toBe(200);
    expect(sendInviteEmail).toHaveBeenCalledWith({
      to: "jess@example.com",
      inviteUrl: "https://app.example/accept-invite?token=tok1",
    });
    const { expiresAt } = inviteUpdate.mock.calls[0][0].data;
    expect(expiresAt.getTime()).toBeGreaterThan(Date.now() + 6 * 86_400_000);
  });

  it("503s and leaves the invite untouched when the email fails", async () => {
    inviteFindFirst.mockResolvedValue(pendingInvite());
    sendInviteEmail.mockRejectedValue(new Error("smtp"));
    const res = await request(makeApp()).post("/invites/inv1/resend");

    expect(res.status).toBe(503);
    expect(inviteUpdate).not.toHaveBeenCalled();
  });

  it("404s for an unknown invite", async () => {
    const res = await request(makeApp()).post("/invites/nope/resend");
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// GET /invites/:token
// ---------------------------------------------------------------------------

describe("GET /invites/:token", () => {
  it("returns the invite details", async () => {
    inviteFindUnique.mockResolvedValue(pendingInvite());
    const res = await request(makeApp()).get("/invites/tok1");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ email: "jess@example.com", role: "TECHNICIAN", tenantId: "t1" });
  });

  it("404s on an unknown token", async () => {
    const res = await request(makeApp()).get("/invites/nope");
    expect(res.status).toBe(404);
  });

  it("410s with INVITE_ACCEPTED", async () => {
    inviteFindUnique.mockResolvedValue(pendingInvite({ acceptedAt: new Date() }));
    const res = await request(makeApp()).get("/invites/tok1");
    expect(res.status).toBe(410);
    expect(res.body).toEqual({ error: "Invite has already been accepted", code: "INVITE_ACCEPTED" });
  });

  it("410s with INVITE_EXPIRED", async () => {
    inviteFindUnique.mockResolvedValue(pendingInvite({ expiresAt: past() }));
    const res = await request(makeApp()).get("/invites/tok1");
    expect(res.status).toBe(410);
    expect(res.body).toEqual({ error: "Invite has expired", code: "INVITE_EXPIRED" });
  });
});

// ---------------------------------------------------------------------------
// POST /invites/:token/accept
// ---------------------------------------------------------------------------

describe("POST /invites/:token/accept — existing profile (idempotent path)", () => {
  const existing = { id: "p1", tenantId: "t1" };

  it("404s on an unknown token", async () => {
    const res = await request(makeApp()).post("/invites/nope/accept").send({ name: "Jess" });
    expect(res.status).toBe(404);
  });

  it("403s when the profile belongs to another tenant", async () => {
    inviteFindUnique.mockResolvedValue(pendingInvite());
    profileFindUnique.mockResolvedValue({ ...existing, tenantId: "t2" });
    const res = await request(makeApp()).post("/invites/tok1/accept").send({});
    expect(res.status).toBe(403);
  });

  it("403s when the signed-in email differs from the invite", async () => {
    inviteFindUnique.mockResolvedValue(pendingInvite());
    profileFindUnique.mockResolvedValue(existing);
    const res = await request(makeApp()).post("/invites/tok1/accept").set("x-email", "other@x.com").send({});
    expect(res.status).toBe(403);
  });

  it("returns 200 with the existing profile when there is no technician to link", async () => {
    inviteFindUnique.mockResolvedValue(pendingInvite({ acceptedAt: new Date() }));
    profileFindUnique.mockResolvedValue(existing);
    const res = await request(makeApp()).post("/invites/tok1/accept").send({});
    expect(res.status).toBe(200);
    expect(res.body.profile).toEqual(existing);
    expect(tenantFindUnique).not.toHaveBeenCalled();
  });

  it("completes a missed technician link", async () => {
    inviteFindUnique.mockResolvedValue(pendingInvite({ technicianId: "tech1" }));
    profileFindUnique.mockResolvedValue(existing);
    tenantFindUnique.mockResolvedValue({ schemaName: "tenant_t1" });
    schemaTechFindUnique.mockResolvedValue({ id: "tech1", profileId: null });
    const res = await request(makeApp()).post("/invites/tok1/accept").send({});
    expect(res.status).toBe(200);
    expect(schemaTechUpdate).toHaveBeenCalledWith({ where: { id: "tech1" }, data: { profileId: "p1" } });
  });

  it("skips the link when the technician is already linked or missing", async () => {
    inviteFindUnique.mockResolvedValue(pendingInvite({ technicianId: "tech1" }));
    profileFindUnique.mockResolvedValue(existing);
    tenantFindUnique.mockResolvedValue({ schemaName: "tenant_t1" });
    schemaTechFindUnique.mockResolvedValueOnce({ id: "tech1", profileId: "p1" }).mockResolvedValueOnce(null);

    expect((await request(makeApp()).post("/invites/tok1/accept").send({})).status).toBe(200);
    expect((await request(makeApp()).post("/invites/tok1/accept").send({})).status).toBe(200);
    expect(schemaTechUpdate).not.toHaveBeenCalled();
  });

  it("skips the link when the tenant row is gone", async () => {
    inviteFindUnique.mockResolvedValue(pendingInvite({ technicianId: "tech1" }));
    profileFindUnique.mockResolvedValue(existing);
    tenantFindUnique.mockResolvedValue(null);
    const res = await request(makeApp()).post("/invites/tok1/accept").send({});
    expect(res.status).toBe(200);
    expect(schemaTechFindUnique).not.toHaveBeenCalled();
  });
});

describe("POST /invites/:token/accept — first accept", () => {
  beforeEach(() => {
    profileFindUnique.mockResolvedValue(null);
    txProfileCreate.mockResolvedValue({ id: "p1", tenantId: "t1", role: "TECHNICIAN", name: "Jess" });
  });

  it("410s when the invite has expired", async () => {
    inviteFindUnique.mockResolvedValue(pendingInvite({ expiresAt: past() }));
    const res = await request(makeApp()).post("/invites/tok1/accept").send({ name: "Jess" });
    expect(res.status).toBe(410);
    expect(res.body.code).toBe("INVITE_EXPIRED");
  });

  it("403s when the signed-in email differs from the invite", async () => {
    inviteFindUnique.mockResolvedValue(pendingInvite());
    const res = await request(makeApp())
      .post("/invites/tok1/accept")
      .set("x-email", "other@x.com")
      .send({ name: "Jess" });
    expect(res.status).toBe(403);
  });

  it("400s on a blank name", async () => {
    inviteFindUnique.mockResolvedValue(pendingInvite());
    const res = await request(makeApp()).post("/invites/tok1/accept").send({ name: "   " });
    expect(res.status).toBe(400);
  });

  it("creates the profile and marks the invite accepted", async () => {
    inviteFindUnique.mockResolvedValue(pendingInvite());
    const res = await request(makeApp()).post("/invites/tok1/accept").send({ name: " Jess " });

    expect(res.status).toBe(201);
    expect(txProfileCreate).toHaveBeenCalledWith({
      data: { supabaseUserId: "sb1", tenantId: "t1", role: "TECHNICIAN", name: "Jess" },
    });
    expect(txInviteUpdate).toHaveBeenCalledWith({ where: { id: "inv1" }, data: { acceptedAt: expect.any(Date) } });
  });

  it("links the technician", async () => {
    inviteFindUnique.mockResolvedValue(pendingInvite({ technicianId: "tech1" }));
    tenantFindUnique.mockResolvedValue({ schemaName: "tenant_t1" });
    const res = await request(makeApp()).post("/invites/tok1/accept").send({ name: "Jess" });
    expect(res.status).toBe(201);
    expect(schemaTechUpdate).toHaveBeenCalledWith({ where: { id: "tech1" }, data: { profileId: "p1" } });
  });

  it("still 201s when the tenant row is gone", async () => {
    inviteFindUnique.mockResolvedValue(pendingInvite({ technicianId: "tech1" }));
    tenantFindUnique.mockResolvedValue(null);
    const res = await request(makeApp()).post("/invites/tok1/accept").send({ name: "Jess" });
    expect(res.status).toBe(201);
    expect(schemaTechUpdate).not.toHaveBeenCalled();
  });

  it("500s with a retry message when the technician link fails", async () => {
    inviteFindUnique.mockResolvedValue(pendingInvite({ technicianId: "tech1" }));
    tenantFindUnique.mockResolvedValue({ schemaName: "tenant_t1" });
    schemaTechUpdate.mockRejectedValue(new Error("db"));
    const res = await request(makeApp()).post("/invites/tok1/accept").send({ name: "Jess" });
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/sign in again/);
  });
});
