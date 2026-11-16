import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../business-time", () => ({ tenantToday: vi.fn(async () => new Date("2026-11-16T00:00:00.000Z")) }));

import { createClosureService, toClosureDto } from "../closure.service";
import { AppError } from "../../lib/app-error";

const d = (s: string) => new Date(`${s}T00:00:00.000Z`);

function row(over: Record<string, unknown> = {}) {
  return {
    id: "c1",
    label: "Christmas",
    startDate: d("2026-12-24"),
    endDate: d("2027-01-03"),
    mode: "MOVE",
    notifyCustomers: false,
    roundIds: [] as string[],
    appliedAt: null as Date | null,
    createdAt: new Date("2026-11-16T09:00:00.000Z"),
    updatedAt: new Date("2026-11-16T09:00:00.000Z"),
    ...over,
  };
}

function makeTp() {
  const tp = {
    businessClosure: {
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn().mockResolvedValue(row()),
      create: vi.fn(async ({ data }: any) => row(data)),
      update: vi.fn(async ({ data }: any) => row(data)),
      delete: vi.fn().mockResolvedValue({}),
    },
    round: { findMany: vi.fn().mockResolvedValue([{ id: "r1" }, { id: "r2" }]) },
  };
  return { tp, svc: createClosureService(tp as any) };
}

const valid = { label: "Christmas", startDate: "2026-12-24", endDate: "2027-01-03", mode: "MOVE" };

async function codeOf(p: Promise<unknown>): Promise<{ status: number; code?: string; fields?: unknown }> {
  try {
    await p;
  } catch (e) {
    const err = e as AppError & { fields?: unknown };
    return { status: err.statusCode, code: err.code, fields: err.fields };
  }
  throw new Error("expected a rejection");
}

beforeEach(() => vi.clearAllMocks());

describe("toClosureDto", () => {
  it("maps dates to YYYY-MM-DD and timestamps to ISO, appliedAt null or ISO", () => {
    expect(toClosureDto(row())).toEqual({
      id: "c1", label: "Christmas", startDate: "2026-12-24", endDate: "2027-01-03", mode: "MOVE", notifyCustomers: false,
      roundIds: [], appliedAt: null, createdAt: "2026-11-16T09:00:00.000Z", updatedAt: "2026-11-16T09:00:00.000Z",
    });
    expect(toClosureDto(row({ appliedAt: new Date("2026-11-17T00:00:00.000Z") })).appliedAt).toBe("2026-11-17T00:00:00.000Z");
  });
});

describe("list", () => {
  it("defaults to endDate >= tenant today, sorted by startDate, with DTOs", async () => {
    const { tp, svc } = makeTp();
    tp.businessClosure.findMany.mockResolvedValue([row()]);
    const res = await svc.list();
    expect(res.closures).toHaveLength(1);
    expect(res.closures[0].startDate).toBe("2026-12-24");
    expect(tp.businessClosure.findMany).toHaveBeenCalledWith({
      where: { endDate: { gte: d("2026-11-16") } },
      orderBy: [{ startDate: "asc" }, { createdAt: "asc" }],
    });
  });

  it("from and to select the overlapping closures", async () => {
    const { tp, svc } = makeTp();
    await svc.list({ from: "2026-12-01", to: "2026-12-31" });
    expect(tp.businessClosure.findMany.mock.calls[0][0].where).toEqual({ endDate: { gte: d("2026-12-01") }, startDate: { lte: d("2026-12-31") } });
  });

  it("from alone and to alone", async () => {
    const { tp, svc } = makeTp();
    await svc.list({ from: "2026-12-01" });
    expect(tp.businessClosure.findMany.mock.calls[0][0].where).toEqual({ endDate: { gte: d("2026-12-01") } });
    await svc.list({ to: "2026-12-31" });
    expect(tp.businessClosure.findMany.mock.calls[1][0].where).toEqual({ startDate: { lte: d("2026-12-31") } });
  });

  it.each([
    [{ from: "2026-13-01" }],
    [{ to: "nope" }],
    [{ from: "2026-02-30" }],
    [{ from: ["2026-12-01", "2026-12-02"] }],
    [{ from: "2026-12-31", to: "2026-12-01" }],
  ])("rejects %j with VALIDATION_FAILED", async (q) => {
    const { svc } = makeTp();
    expect(await codeOf(svc.list(q as any))).toMatchObject({ status: 400, code: "VALIDATION_FAILED" });
  });
});

describe("create", () => {
  it("creates with defaults, trims the label, records createdById", async () => {
    const { tp, svc } = makeTp();
    const out = await svc.create({ ...valid, label: "  Christmas  " }, "p1");
    expect(tp.businessClosure.create).toHaveBeenCalledWith({
      data: { label: "Christmas", startDate: d("2026-12-24"), endDate: d("2027-01-03"), mode: "MOVE", notifyCustomers: false, roundIds: [], createdById: "p1" },
    });
    expect(out.label).toBe("Christmas");
    expect(tp.round.findMany).not.toHaveBeenCalled();
  });

  it("keeps notifyCustomers and checks rounds, collapsing duplicate ids", async () => {
    const { tp, svc } = makeTp();
    await svc.create({ ...valid, notifyCustomers: true, roundIds: ["r1", "r1", "r2"] }, null);
    expect(tp.round.findMany).toHaveBeenCalledWith({ where: { id: { in: ["r1", "r2"] } }, select: { id: true } });
    const data = tp.businessClosure.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ notifyCustomers: true, roundIds: ["r1", "r2"], createdById: null });
  });

  it("label boundaries: 80 ok, 81 refused, empty and whitespace refused, trimmed length counts", async () => {
    const { svc } = makeTp();
    await expect(svc.create({ ...valid, label: "a".repeat(80) }, "p")).resolves.toBeDefined();
    await expect(svc.create({ ...valid, label: ` ${"a".repeat(80)} ` }, "p")).resolves.toBeDefined();
    for (const label of ["a".repeat(81), "", "   "]) {
      expect(await codeOf(svc.create({ ...valid, label }, "p"))).toMatchObject({ status: 400, code: "VALIDATION_FAILED" });
    }
  });

  it("rejects control characters inside the label (outer whitespace is trimmed first)", async () => {
    const { svc } = makeTp();
    for (const label of ["a\u0000b", "a\nb", "a\tb", "a\u007fb", "a\u0085b"]) {
      expect(await codeOf(svc.create({ ...valid, label }, "p"))).toMatchObject({ code: "VALIDATION_FAILED" });
    }
    await expect(svc.create({ ...valid, label: "\nOK\n" }, "p")).resolves.toMatchObject({ label: "OK" });
  });

  it("366 days is allowed, 367 is INVALID_CLOSURE_RANGE", async () => {
    const { svc } = makeTp();
    // 2026-12-01 .. 2027-12-01 inclusive is 366 days; one more day is 367.
    await expect(svc.create({ ...valid, startDate: "2026-12-01", endDate: "2027-12-01" }, "p")).resolves.toBeDefined();
    expect(await codeOf(svc.create({ ...valid, startDate: "2026-12-01", endDate: "2027-12-02" }, "p"))).toMatchObject({ status: 400, code: "INVALID_CLOSURE_RANGE" });
  });

  it("same-day closure is valid; end before start is INVALID_CLOSURE_RANGE", async () => {
    const { svc } = makeTp();
    await expect(svc.create({ ...valid, startDate: "2026-12-24", endDate: "2026-12-24" }, "p")).resolves.toBeDefined();
    expect(await codeOf(svc.create({ ...valid, startDate: "2026-12-24", endDate: "2026-12-23" }, "p"))).toMatchObject({ code: "INVALID_CLOSURE_RANGE" });
  });

  it("ending today is allowed, ending yesterday is INVALID_CLOSURE_RANGE", async () => {
    const { svc } = makeTp();
    await expect(svc.create({ ...valid, startDate: "2026-11-10", endDate: "2026-11-16" }, "p")).resolves.toBeDefined();
    expect(await codeOf(svc.create({ ...valid, startDate: "2026-11-10", endDate: "2026-11-15" }, "p"))).toMatchObject({ status: 400, code: "INVALID_CLOSURE_RANGE" });
  });

  it("unknown round id is UNKNOWN_ROUND and nothing is created", async () => {
    const { tp, svc } = makeTp();
    expect(await codeOf(svc.create({ ...valid, roundIds: ["r1", "nope"] }, "p"))).toMatchObject({ status: 400, code: "UNKNOWN_ROUND" });
    expect(tp.businessClosure.create).not.toHaveBeenCalled();
  });

  it.each([
    ["not an object", "x"],
    ["null", null],
    ["array", []],
    ["missing label", { startDate: "2026-12-24", endDate: "2026-12-25", mode: "MOVE" }],
    ["missing startDate", { label: "x", endDate: "2026-12-25", mode: "MOVE" }],
    ["missing endDate", { label: "x", startDate: "2026-12-24", mode: "MOVE" }],
    ["missing mode", { label: "x", startDate: "2026-12-24", endDate: "2026-12-25" }],
    ["label not string", { ...valid, label: 5 }],
    ["bad startDate format", { ...valid, startDate: "24/12/2026" }],
    ["impossible startDate", { ...valid, startDate: "2026-02-30" }],
    ["startDate not a string", { ...valid, startDate: 20261224 }],
    ["bad endDate", { ...valid, endDate: "2027-13-01" }],
    ["bad mode", { ...valid, mode: "PAUSE" }],
    ["lowercase mode", { ...valid, mode: "move" }],
    ["notifyCustomers string", { ...valid, notifyCustomers: "yes" }],
    ["roundIds not array", { ...valid, roundIds: "r1" }],
    ["roundIds with number", { ...valid, roundIds: [1] }],
    ["roundIds with empty string", { ...valid, roundIds: [""] }],
    ["extra field", { ...valid, colour: "red" }],
  ])("VALIDATION_FAILED: %s", async (_n, body) => {
    const { tp, svc } = makeTp();
    expect(await codeOf(svc.create(body, "p"))).toMatchObject({ status: 400, code: "VALIDATION_FAILED" });
    expect(tp.businessClosure.create).not.toHaveBeenCalled();
  });

  it("extra fields are listed in fields[]", async () => {
    const { svc } = makeTp();
    const r = await codeOf(svc.create({ ...valid, a: 1, b: 2 }, "p"));
    expect(r.fields).toEqual([
      { path: "a", code: "VALIDATION_FAILED", message: expect.any(String) },
      { path: "b", code: "VALIDATION_FAILED", message: expect.any(String) },
    ]);
  });
});

describe("update", () => {
  it("partial update writes only the supplied fields and skips the today check when no date is supplied", async () => {
    const { tp, svc } = makeTp();
    // Existing closure already ended (in the past): editing the label alone must still work.
    tp.businessClosure.findUnique.mockResolvedValue(row({ startDate: d("2026-01-01"), endDate: d("2026-01-05") }));
    const out = await svc.update("c1", { label: "  New  ", notifyCustomers: true });
    expect(tp.businessClosure.update).toHaveBeenCalledWith({ where: { id: "c1" }, data: { label: "New", notifyCustomers: true } });
    expect(out.label).toBe("New");
  });

  it("an empty body is a no-op update", async () => {
    const { tp, svc } = makeTp();
    await svc.update("c1", {});
    expect(tp.businessClosure.update).toHaveBeenCalledWith({ where: { id: "c1" }, data: {} });
  });

  it("supplying endDate in the past is INVALID_CLOSURE_RANGE", async () => {
    const { svc } = makeTp();
    expect(await codeOf(svc.update("c1", { startDate: "2026-12-01", endDate: "2026-11-15" }))).toMatchObject({ code: "INVALID_CLOSURE_RANGE" });
  });

  it("supplying only startDate re-checks the (existing) endDate against today", async () => {
    const { tp, svc } = makeTp();
    tp.businessClosure.findUnique.mockResolvedValue(row({ startDate: d("2026-01-01"), endDate: d("2026-01-05") }));
    expect(await codeOf(svc.update("c1", { startDate: "2026-01-02" }))).toMatchObject({ code: "INVALID_CLOSURE_RANGE" });
  });

  it("supplying only endDate in the future works and is merged with the existing start", async () => {
    const { tp, svc } = makeTp();
    await svc.update("c1", { endDate: "2027-01-10" });
    expect(tp.businessClosure.update).toHaveBeenCalledWith({ where: { id: "c1" }, data: { endDate: d("2027-01-10") } });
  });

  it("merged range is validated: a new endDate before the existing start, a merged length over 366 days", async () => {
    const { svc } = makeTp();
    expect(await codeOf(svc.update("c1", { endDate: "2026-12-23" }))).toMatchObject({ code: "INVALID_CLOSURE_RANGE" });
    expect(await codeOf(svc.update("c1", { endDate: "2027-12-25" }))).toMatchObject({ code: "INVALID_CLOSURE_RANGE" });
  });

  it("checks roundIds only when supplied", async () => {
    const { tp, svc } = makeTp();
    await svc.update("c1", { roundIds: ["r1"] });
    expect(tp.round.findMany).toHaveBeenCalledTimes(1);
    expect(await codeOf(svc.update("c1", { roundIds: ["zzz"] }))).toMatchObject({ code: "UNKNOWN_ROUND" });
    await svc.update("c1", { roundIds: [] });
    expect(tp.round.findMany).toHaveBeenCalledTimes(2);
  });

  it("404 CLOSURE_NOT_FOUND; validation errors win before the lookup", async () => {
    const { tp, svc } = makeTp();
    tp.businessClosure.findUnique.mockResolvedValue(null);
    expect(await codeOf(svc.update("nope", { label: "x" }))).toMatchObject({ status: 404, code: "CLOSURE_NOT_FOUND" });
    tp.businessClosure.findUnique.mockClear();
    expect(await codeOf(svc.update("nope", { label: "" }))).toMatchObject({ status: 400, code: "VALIDATION_FAILED" });
    expect(tp.businessClosure.findUnique).not.toHaveBeenCalled();
  });

  it("rejects extra fields (including createdById and id)", async () => {
    const { svc } = makeTp();
    expect(await codeOf(svc.update("c1", { id: "x" }))).toMatchObject({ code: "VALIDATION_FAILED" });
    expect(await codeOf(svc.update("c1", { createdById: "x" }))).toMatchObject({ code: "VALIDATION_FAILED" });
  });
});

describe("remove", () => {
  it("deletes an existing closure", async () => {
    const { tp, svc } = makeTp();
    await expect(svc.remove("c1")).resolves.toBeUndefined();
    expect(tp.businessClosure.delete).toHaveBeenCalledWith({ where: { id: "c1" } });
  });

  it("404 CLOSURE_NOT_FOUND", async () => {
    const { tp, svc } = makeTp();
    tp.businessClosure.findUnique.mockResolvedValue(null);
    expect(await codeOf(svc.remove("nope"))).toMatchObject({ status: 404, code: "CLOSURE_NOT_FOUND" });
    expect(tp.businessClosure.delete).not.toHaveBeenCalled();
  });
});
