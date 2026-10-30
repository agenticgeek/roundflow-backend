import { describe, it, expect, vi } from "vitest";
import { requireTechnician, requireVisitOwner, assertVisitOwner, assertRoundMember } from "../ownership";

function makeTp() {
  return {
    technician: { findUnique: vi.fn() },
    visit: { findUnique: vi.fn(), findFirst: vi.fn() },
    roundTechnician: { findFirst: vi.fn() },
  };
}

function makeRes() {
  const res: any = {};
  res.status = vi.fn(() => res);
  res.json = vi.fn(() => res);
  return res;
}

describe("requireTechnician", () => {
  it("403 TECHNICIAN_ONLY when the profile is not a technician", async () => {
    const tp = makeTp();
    const req: any = { profile: { id: "p1", role: "ADMIN" }, tenantPrisma: tp };
    const res = makeRes();
    const next = vi.fn();
    await requireTechnician(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: "TECHNICIAN_ONLY" }));
    expect(next).not.toHaveBeenCalled();
    expect(tp.technician.findUnique).not.toHaveBeenCalled();
  });

  it("403 TECHNICIAN_ONLY when there is no profile at all", async () => {
    const res = makeRes();
    await requireTechnician({} as any, res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it("403 NO_TECHNICIAN when no Technician row is linked to the profile", async () => {
    const tp = makeTp();
    tp.technician.findUnique.mockResolvedValue(null);
    const res = makeRes();
    const next = vi.fn();
    await requireTechnician({ profile: { id: "p1", role: "TECHNICIAN" }, tenantPrisma: tp } as any, res, next);
    expect(tp.technician.findUnique).toHaveBeenCalledWith({ where: { profileId: "p1" }, select: { id: true } });
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: "NO_TECHNICIAN" }));
    expect(next).not.toHaveBeenCalled();
  });

  it("sets req.technician and continues for a linked technician", async () => {
    const tp = makeTp();
    tp.technician.findUnique.mockResolvedValue({ id: "t1" });
    const req: any = { profile: { id: "p1", role: "TECHNICIAN" }, tenantPrisma: tp };
    const next = vi.fn();
    await requireTechnician(req, makeRes(), next);
    expect(req.technician).toEqual({ id: "t1" });
    expect(next).toHaveBeenCalledWith();
  });

  it("forwards lookup errors to next", async () => {
    const tp = makeTp();
    const boom = new Error("db down");
    tp.technician.findUnique.mockRejectedValue(boom);
    const next = vi.fn();
    await requireTechnician({ profile: { id: "p1", role: "TECHNICIAN" }, tenantPrisma: tp } as any, makeRes(), next);
    expect(next).toHaveBeenCalledWith(boom);
  });
});

describe("assertVisitOwner / requireVisitOwner", () => {
  it("404 when the visit does not exist", async () => {
    const tp = makeTp();
    tp.visit.findUnique.mockResolvedValue(null);
    await expect(assertVisitOwner(tp as any, "v1", "t1")).rejects.toMatchObject({ statusCode: 404 });
  });

  it("403 NOT_YOUR_VISIT when assigned to someone else", async () => {
    const tp = makeTp();
    tp.visit.findUnique.mockResolvedValue({ technicianId: "t2" });
    await expect(assertVisitOwner(tp as any, "v1", "t1")).rejects.toMatchObject({ statusCode: 403, code: "NOT_YOUR_VISIT" });
  });

  it("resolves for the owner", async () => {
    const tp = makeTp();
    tp.visit.findUnique.mockResolvedValue({ technicianId: "t1" });
    await expect(assertVisitOwner(tp as any, "v1", "t1")).resolves.toBeUndefined();
  });

  it("middleware calls next() for the owner and next(err) otherwise", async () => {
    const tp = makeTp();
    tp.visit.findUnique.mockResolvedValueOnce({ technicianId: "t1" }).mockResolvedValueOnce({ technicianId: null });
    const req: any = { tenantPrisma: tp, params: { id: "v1" }, technician: { id: "t1" } };

    const ok = await new Promise<unknown[]>((resolve) => requireVisitOwner(req, {} as any, (...a: unknown[]) => resolve(a)));
    expect(ok).toEqual([]);
    const bad = await new Promise<unknown[]>((resolve) => requireVisitOwner(req, {} as any, (...a: unknown[]) => resolve(a)));
    expect(bad[0]).toMatchObject({ code: "NOT_YOUR_VISIT" });
  });
});

describe("assertRoundMember", () => {
  it("passes when the technician is assigned to the round", async () => {
    const tp = makeTp();
    tp.roundTechnician.findFirst.mockResolvedValue({ roundId: "r1" });
    await expect(assertRoundMember(tp as any, "r1", "t1")).resolves.toBeUndefined();
    expect(tp.visit.findFirst).not.toHaveBeenCalled();
  });

  it("passes when the technician holds a visit on the round", async () => {
    const tp = makeTp();
    tp.roundTechnician.findFirst.mockResolvedValue(null);
    tp.visit.findFirst.mockResolvedValue({ id: "v1" });
    await expect(assertRoundMember(tp as any, "r1", "t1")).resolves.toBeUndefined();
  });

  it("403 NOT_YOUR_ROUND otherwise", async () => {
    const tp = makeTp();
    tp.roundTechnician.findFirst.mockResolvedValue(null);
    tp.visit.findFirst.mockResolvedValue(null);
    await expect(assertRoundMember(tp as any, "r1", "t1")).rejects.toMatchObject({ statusCode: 403, code: "NOT_YOUR_ROUND" });
  });
});
