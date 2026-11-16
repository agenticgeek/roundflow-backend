import { describe, it, expect, vi, beforeEach } from "vitest";

const tenantToday = vi.fn();
const tenantWorkingDays = vi.fn();
vi.mock("../business-time", () => ({
  tenantToday: (...a: unknown[]) => tenantToday(...a),
  tenantWorkingDays: (...a: unknown[]) => tenantWorkingDays(...a),
}));
const getCachedBusinessSettings = vi.fn();
vi.mock("../settings.service", () => ({ getCachedBusinessSettings: (...a: unknown[]) => getCachedBusinessSettings(...a) }));
vi.mock("../notify", async () => (await import("../../test/notify-mock.js")).notifyMockModule());
const broadcast = vi.fn();
vi.mock("../message.service", () => ({ createMessageService: vi.fn(() => ({ broadcast })) }));

import {
  createClosureApplyService,
  CLOSURE_MOVE_CUSTOMER_BODY,
  CLOSURE_SKIP_CUSTOMER_BODY,
  ACTIVITY_VISITS_SKIPPED_BY_CLOSURE,
} from "../closure-apply.service";
import { notifyVisitTechnicians } from "../notify";

const d = (s: string) => new Date(`${s}T00:00:00.000Z`);
const iso = (x: Date) => x.toISOString().slice(0, 10);
const TODAY = d("2026-11-16");

type Row = Record<string, any>;

const cust = (id: string, over: Record<string, unknown> = {}) => ({
  id, name: `Jane ${id}`, phone: "07", email: null, ghlContactId: null, messagesOptOut: false, ...over,
});

const ROUNDS = {
  RM: { name: "Monday round", defaultDay: "MON" },
  RT: { name: "Thursday round", defaultDay: "THU" },
  RN: { name: "Open round", defaultDay: null },
  RX: { name: "Other round", defaultDay: "MON" },
} as const;

function visit(id: string, round: keyof typeof ROUNDS | null, date: string, over: Row = {}): Row {
  return {
    id,
    date: d(date),
    status: "SCHEDULED",
    isOneOff: false,
    roundId: round,
    round: round ? ROUNDS[round] : null,
    technicianId: "t1",
    technician: { active: true },
    propertyId: `p-${id}`,
    property: { addressLine: `${id} High St`, customer: cust(`c-${id}`) },
    skipReason: null,
    carryoverCount: 0,
    carriedOverFromDate: null,
    reminderSentAt: new Date("2026-11-01T00:00:00Z"),
    reminderSentTypes: ["x"],
    ...over,
  };
}

const XMAS = { id: "k1", label: "Christmas", startDate: d("2026-12-24"), endDate: d("2027-01-03"), mode: "MOVE", notifyCustomers: false, roundIds: [] as string[], appliedAt: null as Date | null };

function makeDb(visits: Row[], closures: Row[] = [{ ...XMAS }], unavailable: string[] = []) {
  const state = { visits, closures };
  const inRange = (v: Date, w: any) =>
    (!w.gte || v >= w.gte) && (!w.lte || v <= w.lte) && (!w.lt || v < w.lt);
  const matches = (v: Row, w: any) =>
    (!w.id || w.id.in.includes(v.id)) &&
    (w.status === undefined || (typeof w.status === "string" ? v.status === w.status : w.status.in.includes(v.status))) &&
    (w.isOneOff === undefined || v.isOneOff === w.isOneOff) &&
    (!w.date || inRange(v.date, w.date)) &&
    (!w.roundId || ("in" in w.roundId ? w.roundId.in.includes(v.roundId) : v.roundId !== null));
  const db: any = {
    state,
    visit: {
      findMany: vi.fn(async ({ where, orderBy }: any) => {
        const hit = state.visits.filter((v) => matches(v, where));
        return Array.isArray(orderBy) ? hit.sort((a, b) => a.date.getTime() - b.date.getTime() || a.id.localeCompare(b.id)) : hit;
      }),
      updateMany: vi.fn(async ({ where, data }: any) => {
        const hit = state.visits.filter((v) => matches(v, where));
        for (const v of hit) {
          for (const [k, val] of Object.entries(data)) {
            v[k] = val && typeof val === "object" && "increment" in (val as object) ? v[k] + (val as any).increment : val;
          }
        }
        return { count: hit.length };
      }),
    },
    businessClosure: {
      findUnique: vi.fn(async ({ where }: any) => state.closures.find((c) => c.id === where.id) ?? null),
      findMany: vi.fn(async ({ where }: any) => state.closures.filter((c) => c.endDate >= where.endDate.gte)),
      update: vi.fn(async ({ where, data }: any) => Object.assign(state.closures.find((c) => c.id === where.id)!, data)),
    },
    technicianAvailability: { findMany: vi.fn(async () => unavailable.map((technicianId) => ({ technicianId }))) },
    integrationOutbox: { updateMany: vi.fn(async () => ({ count: 2 })) },
    activityLog: { create: vi.fn(async () => ({})) },
    servicePlan: { update: vi.fn(), updateMany: vi.fn() },
    $queryRaw: vi.fn(async () => []),
    $transaction: vi.fn(async (cb: (t: unknown) => unknown) => {
      const snap = structuredClone({ visits: state.visits, closures: state.closures });
      try {
        return await cb(db);
      } catch (err) {
        state.visits = snap.visits;
        state.closures = snap.closures;
        throw err;
      }
    }),
  };
  return db;
}

const svc = (db: unknown) => createClosureApplyService(db as never);
const find = (db: any, id: string): Row => db.state.visits.find((v: Row) => v.id === id);
const ymd = (db: any, id: string) => iso(find(db, id).date);

/** The Ap1 world: Monday round 12-28, Thursday round 12-31, no-day round 12-29, plus two bystanders. */
function ap1(extra: Row[] = []) {
  return makeDb([
    visit("vm", "RM", "2026-12-28"),
    visit("vt", "RT", "2026-12-31"),
    visit("vn", "RN", "2026-12-29"),
    visit("before", "RM", "2026-12-23"),
    visit("after", "RM", "2027-01-04"),
    ...extra,
  ]);
}

beforeEach(() => {
  vi.clearAllMocks();
  tenantToday.mockResolvedValue(TODAY);
  tenantWorkingDays.mockResolvedValue([]);
  getCachedBusinessSettings.mockResolvedValue({ lastClosedDate: null, businessName: "Shine" });
  broadcast.mockResolvedValue({ sent: 1, scheduled: 1 });
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("errors", () => {
  it("404 CLOSURE_NOT_FOUND for preview and apply", async () => {
    const db = ap1();
    await expect(svc(db).preview("nope")).rejects.toMatchObject({ statusCode: 404, code: "CLOSURE_NOT_FOUND" });
    await expect(svc(db).apply("nope")).rejects.toMatchObject({ statusCode: 404, code: "CLOSURE_NOT_FOUND" });
  });

  it("409 CLOSURE_ENDED when the window ended before today; the last day is still allowed", async () => {
    const db = makeDb([visit("v", "RM", "2026-11-16")], [{ ...XMAS, startDate: d("2026-11-10"), endDate: d("2026-11-15") }]);
    await expect(svc(db).apply("k1")).rejects.toMatchObject({ statusCode: 409, code: "CLOSURE_ENDED" });
    await expect(svc(db).preview("k1")).rejects.toMatchObject({ statusCode: 409, code: "CLOSURE_ENDED" });
    expect(db.$transaction).not.toHaveBeenCalled();

    const ok = makeDb([visit("v", "RM", "2026-11-16")], [{ ...XMAS, startDate: d("2026-11-10"), endDate: d("2026-11-16") }]);
    const res = await svc(ok).apply("k1");
    expect(res.moved).toBe(1);
    expect(ymd(ok, "v")).toBe("2026-11-23");
  });

  it("refuses a target on an already closed day (carryover's code) and writes nothing", async () => {
    getCachedBusinessSettings.mockResolvedValue({ lastClosedDate: "2027-01-07", businessName: "Shine" });
    const db = ap1();
    await expect(svc(db).apply("k1")).rejects.toMatchObject({ statusCode: 409, code: "CARRYOVER_TARGET_CLOSED" });
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(ymd(db, "vm")).toBe("2026-12-28");
  });

  it("refuses the whole run when any target is in the past (midnight rollover), for apply and preview", async () => {
    const db = ap1();
    tenantToday.mockResolvedValueOnce(TODAY).mockResolvedValueOnce(d("2027-01-05"));
    await expect(svc(db).apply("k1")).rejects.toMatchObject({ statusCode: 400, code: "CARRYOVER_TARGET_IN_PAST" });
    expect(db.$transaction).not.toHaveBeenCalled();
    tenantToday.mockResolvedValueOnce(TODAY).mockResolvedValueOnce(d("2027-01-05"));
    await expect(svc(db).preview("k1")).rejects.toMatchObject({ code: "CARRYOVER_TARGET_IN_PAST" });
  });

  it("preview reports a closed target day as the same error", async () => {
    getCachedBusinessSettings.mockResolvedValue({ lastClosedDate: "2027-01-07", businessName: "Shine" });
    await expect(svc(ap1()).preview("k1")).rejects.toMatchObject({ statusCode: 409, code: "CARRYOVER_TARGET_CLOSED" });
  });

  it("works when business settings do not exist", async () => {
    getCachedBusinessSettings.mockResolvedValue(null);
    const db = ap1();
    expect((await svc(db).apply("k1")).moved).toBe(3);
  });
});

describe("selection", () => {
  it("touches only SCHEDULED, non-one-off visits with a round, inside the window and from today on (Ap3)", async () => {
    const db = makeDb([
      visit("ok", "RM", "2026-12-28"),
      visit("inprog", "RM", "2026-12-24", { status: "IN_PROGRESS" }),
      visit("done", "RM", "2026-12-27", { status: "COMPLETED" }),
      visit("skipped", "RM", "2026-12-28", { status: "SKIPPED" }),
      visit("cancelled", "RM", "2026-12-28", { status: "CANCELLED" }),
      visit("oneoff", "RM", "2026-12-28", { isOneOff: true }),
      visit("reclean", "RM", "2026-12-30", { isOneOff: true }),
      visit("noround", null, "2026-12-28"),
      visit("early", "RM", "2026-12-23"),
      visit("late", "RM", "2027-01-04"),
    ]);
    const before = structuredClone(db.state.visits.filter((v: Row) => v.id !== "ok"));
    const res = await svc(db).apply("k1");
    expect(res.moved).toBe(1);
    expect(db.state.visits.filter((v: Row) => v.id !== "ok")).toEqual(before);
    expect(ymd(db, "ok")).toBe("2027-01-04");
  });

  it("only visits from today on: a window that already started leaves earlier days alone", async () => {
    const db = makeDb(
      [visit("past", "RM", "2026-11-12"), visit("today", "RM", "2026-11-16"), visit("later", "RM", "2026-11-17")],
      [{ ...XMAS, startDate: d("2026-11-10"), endDate: d("2026-11-20") }]
    );
    await svc(db).apply("k1");
    expect(ymd(db, "past")).toBe("2026-11-12");
    expect(ymd(db, "today")).toBe("2026-11-23");
    expect(ymd(db, "later")).toBe("2026-11-23");
  });

  it("a round-scoped closure leaves other rounds' visits alone", async () => {
    const db = makeDb([visit("a", "RM", "2026-12-28"), visit("b", "RX", "2026-12-28")], [{ ...XMAS, roundIds: ["RM"] }]);
    const res = await svc(db).apply("k1");
    expect(res.moved).toBe(1);
    expect(ymd(db, "a")).toBe("2027-01-04");
    expect(ymd(db, "b")).toBe("2026-12-28");
  });

  it("a visit the resolver keeps (the closure was deleted between the two reads) is untouched", async () => {
    const db = ap1();
    db.businessClosure.findMany.mockResolvedValue([]);
    const res = await svc(db).apply("k1");
    expect(res).toMatchObject({ moved: 0, skipped: 0, notifiedTechnicians: 0 });
    expect(ymd(db, "vm")).toBe("2026-12-28");
  });
});

describe("MOVE (Ap1)", () => {
  it("moves Monday 12-28 to 01-04, Thursday 12-31 to 01-07, no-day 12-29 to 01-04; bystanders and plans untouched", async () => {
    const db = ap1();
    const res = await svc(db).apply("k1", { actor: { id: "u1", role: "MANAGER" } });

    expect(ymd(db, "vm")).toBe("2027-01-04");
    expect(ymd(db, "vt")).toBe("2027-01-07");
    expect(ymd(db, "vn")).toBe("2027-01-04");
    expect(ymd(db, "before")).toBe("2026-12-23");
    expect(ymd(db, "after")).toBe("2027-01-04");
    expect(db.servicePlan.update).not.toHaveBeenCalled();
    expect(db.servicePlan.updateMany).not.toHaveBeenCalled();

    expect(res).toMatchObject({ closureId: "k1", mode: "MOVE", moved: 3, skipped: 0, conflicts: [], notifiedCustomers: 0 });
    expect(find(db, "vm")).toMatchObject({ status: "SCHEDULED", carryoverCount: 1, reminderSentAt: null, reminderSentTypes: [] });
    expect(iso(find(db, "vm").carriedOverFromDate)).toBe("2026-12-28");
  });

  it("calls the carryover core once per (from, to) group inside ONE transaction, via closure", async () => {
    const db = ap1();
    await svc(db).apply("k1", { actor: { id: "u1", role: "ADMIN" } });
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    const logs = db.activityLog.create.mock.calls.map((c: any) => c[0].data);
    expect(logs).toHaveLength(3);
    expect(logs.every((l: any) => l.details.via === "closure" && l.actorId === "u1" && l.actorRole === "ADMIN")).toBe(true);
    expect(logs.map((l: any) => `${l.details.from}>${l.details.to}`)).toEqual(["2026-12-28>2027-01-04", "2026-12-29>2027-01-04", "2026-12-31>2027-01-07"]);
    expect(db.integrationOutbox.updateMany.mock.calls[0][0].data).toMatchObject({ status: "cancelled", lastError: "Carried over" });
  });

  it("groups visits with the same (from, to) into one call", async () => {
    const db = makeDb(Array.from({ length: 5 }, (_, i) => visit(`m${i}`, "RM", "2026-12-28")));
    await svc(db).apply("k1");
    expect(db.activityLog.create).toHaveBeenCalledTimes(1);
    expect(db.activityLog.create.mock.calls[0][0].data.details.visitIds).toHaveLength(5);
  });

  it("increments carryoverCount on a second move (Ap6: window extended, applied again)", async () => {
    const db = ap1();
    await svc(db).apply("k1");
    db.state.closures[0].endDate = d("2027-01-10");
    const res = await svc(db).apply("k1");
    // 01-04 (vm, vn, and the untouched 'after') and 01-07 (vt) are now inside; 12-23 is not.
    expect(res.moved).toBe(4);
    expect(ymd(db, "vm")).toBe("2027-01-11");
    expect(ymd(db, "vn")).toBe("2027-01-11");
    expect(ymd(db, "vt")).toBe("2027-01-14");
    expect(ymd(db, "after")).toBe("2027-01-11");
    expect(ymd(db, "before")).toBe("2026-12-23");
    expect(find(db, "vm").carryoverCount).toBe(2);
    expect(iso(find(db, "vm").carriedOverFromDate)).toBe("2027-01-04");
  });

  it("is idempotent (Ap5): the second run changes nothing", async () => {
    const db = ap1();
    await svc(db).apply("k1");
    const after = structuredClone(db.state.visits);
    db.activityLog.create.mockClear();
    vi.mocked(notifyVisitTechnicians).mockClear();
    const res = await svc(db).apply("k1");
    expect(res).toMatchObject({ moved: 0, skipped: 0, notifiedTechnicians: 0, notifiedCustomers: 0 });
    expect(db.state.visits).toEqual(after);
    expect(db.activityLog.create).not.toHaveBeenCalled();
    expect(notifyVisitTechnicians).not.toHaveBeenCalled();
  });

  it("sets appliedAt (also when nothing was selected) and returns it", async () => {
    const empty = makeDb([]);
    const res = await svc(empty).apply("k1");
    expect(res.moved).toBe(0);
    expect(empty.state.closures[0].appliedAt).toBeInstanceOf(Date);
    expect(res.appliedAt).toBe(empty.state.closures[0].appliedAt.toISOString());
  });

  it("locks the closure row (FOR UPDATE) inside the transaction before moving any visit, so concurrent applies cannot double-move", async () => {
    const db = makeDb([visit("a", "RM", "2026-12-28")], [{ ...XMAS }]);
    await svc(db).apply("k1");
    expect(db.$queryRaw).toHaveBeenCalledTimes(1);
    const [strings, id] = db.$queryRaw.mock.calls[0] as unknown as [TemplateStringsArray, string];
    expect(strings.join("?")).toMatch(/FROM "BusinessClosure" WHERE "id" = \? FOR UPDATE/);
    expect(id).toBe("k1");
    expect(db.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(db.visit.updateMany.mock.invocationCallOrder[0]);
  });

  it("writes updatedAt as the same instant as appliedAt, so a fresh apply never looks 'edited after apply'", async () => {
    const empty = makeDb([]);
    await svc(empty).apply("k1");
    const [call] = empty.businessClosure.update.mock.calls.at(-1)!;
    expect(call.data.updatedAt).toEqual(call.data.appliedAt);
    expect(empty.state.closures[0].updatedAt).toEqual(empty.state.closures[0].appliedAt);
  });

  it("reports technician conflicts from the carryover core", async () => {
    const db = makeDb(
      [
        visit("a", "RM", "2026-12-28", { technicianId: "t1", technician: { active: false } }),
        visit("b", "RM", "2026-12-28", { technicianId: "t2" }),
        visit("c", "RM", "2026-12-28", { technicianId: "t3" }),
        visit("d", "RM", "2026-12-28", { technicianId: null, technician: null }),
      ],
      [{ ...XMAS }],
      ["t2"]
    );
    const res = await svc(db).apply("k1");
    expect(res.conflicts).toEqual([
      { visitId: "a", technicianId: "t1", reason: "TECHNICIAN_INACTIVE" },
      { visitId: "b", technicianId: "t2", reason: "TECHNICIAN_UNAVAILABLE" },
    ]);
  });

  it("rolls everything back when a later group fails", async () => {
    const db = ap1();
    db.activityLog.create.mockResolvedValueOnce({}).mockRejectedValueOnce(new Error("boom"));
    await expect(svc(db).apply("k1")).rejects.toThrow("boom");
    expect(ymd(db, "vm")).toBe("2026-12-28");
    expect(ymd(db, "vt")).toBe("2026-12-31");
    expect(find(db, "vm").carryoverCount).toBe(0);
    expect(db.state.closures[0].appliedAt).toBeNull();
    expect(notifyVisitTechnicians).not.toHaveBeenCalled();
    expect(broadcast).not.toHaveBeenCalled();
  });
});

describe("SKIP (Ap2)", () => {
  const skipClosure = { ...XMAS, mode: "SKIP" };

  it("marks the visits SKIPPED with the closure label, cancels queued messages, logs once", async () => {
    const db = makeDb(
      [visit("vm", "RM", "2026-12-28"), visit("vt", "RT", "2026-12-31"), visit("vn", "RN", "2026-12-29"), visit("before", "RM", "2026-12-23")],
      [{ ...skipClosure }]
    );
    const res = await svc(db).apply("k1", { actor: { id: "u9", role: "MANAGER" } });
    expect(res).toMatchObject({ mode: "SKIP", moved: 0, skipped: 3 });
    for (const id of ["vm", "vt", "vn"]) expect(find(db, id)).toMatchObject({ status: "SKIPPED", skipReason: "Christmas" });
    expect(find(db, "before").status).toBe("SCHEDULED");
    expect(ymd(db, "vm")).toBe("2026-12-28");
    expect(db.integrationOutbox.updateMany.mock.calls[0][0]).toMatchObject({ data: { status: "cancelled", lastError: "Closure: Christmas" } });
    expect(db.activityLog.create).toHaveBeenCalledTimes(1);
    expect(db.activityLog.create.mock.calls[0][0].data).toMatchObject({
      type: ACTIVITY_VISITS_SKIPPED_BY_CLOSURE,
      message: '3 visits skipped for closure "Christmas"',
      actorId: "u9",
      actorRole: "MANAGER",
      entityId: "k1",
      details: { closureId: "k1", label: "Christmas", visitIds: ["vm", "vn", "vt"], cancelledReminders: 2 },
    });
    expect(db.servicePlan.update).not.toHaveBeenCalled();
  });

  it("logs a null actor when none is given and does not check closed days (no targets)", async () => {
    getCachedBusinessSettings.mockResolvedValue({ lastClosedDate: "2027-01-04", businessName: "" });
    const db = makeDb([visit("v", "RM", "2026-12-28")], [{ ...skipClosure }]);
    await svc(db).apply("k1");
    expect(db.activityLog.create.mock.calls[0][0].data).toMatchObject({ actorId: null, actorRole: null });
  });

  it("a different closure overrides: SKIP wins on the landing day (Ap/B11)", async () => {
    const landing = { id: "k2", label: "Training day", startDate: d("2027-01-04"), endDate: d("2027-01-04"), mode: "SKIP", notifyCustomers: false, roundIds: [], appliedAt: null };
    const db = makeDb(
      [visit("vm", "RM", "2026-12-28"), visit("vt", "RT", "2026-12-31"), visit("vn", "RN", "2026-12-29")],
      [{ ...XMAS }, landing]
    );
    const res = await svc(db).apply("k1");
    expect(res).toMatchObject({ moved: 1, skipped: 2 });
    expect(find(db, "vm")).toMatchObject({ status: "SKIPPED", skipReason: "Christmas" });
    expect(find(db, "vn").status).toBe("SKIPPED");
    expect(ymd(db, "vt")).toBe("2027-01-07");
  });

  it("a SKIP closure in a MOVE-mode run also reports skipped visits in preview (to: null)", async () => {
    const landing = { id: "k2", label: "Training day", startDate: d("2027-01-04"), endDate: d("2027-01-04"), mode: "SKIP", notifyCustomers: false, roundIds: [], appliedAt: null };
    const db = makeDb([visit("vm", "RM", "2026-12-28"), visit("vt", "RT", "2026-12-31")], [{ ...XMAS }, landing]);
    const prev = await svc(db).preview("k1");
    expect(prev.rounds).toEqual([
      { roundId: "RM", roundName: "Monday round", visitCount: 1, groups: [{ from: "2026-12-28", to: null, count: 1 }] },
      { roundId: "RT", roundName: "Thursday round", visitCount: 1, groups: [{ from: "2026-12-31", to: "2027-01-07", count: 1 }] },
    ]);
  });
});

describe("preview", () => {
  it("groups per round, never one row per visit (Ap4: 20 visits, one group)", async () => {
    const db = makeDb(Array.from({ length: 20 }, (_, i) => visit(`m${i}`, "RM", "2026-12-28")));
    const prev = await svc(db).preview("k1");
    expect(prev.rounds).toEqual([{ roundId: "RM", roundName: "Monday round", visitCount: 20, groups: [{ from: "2026-12-28", to: "2027-01-04", count: 20 }] }]);
    expect(prev.totals).toEqual({ visits: 20, rounds: 1, customers: 20, technicianConflicts: 0 });
  });

  it("a 500-visit round returns groups, not rows", async () => {
    const rows = Array.from({ length: 500 }, (_, i) => visit(`m${i}`, "RM", i % 2 ? "2026-12-28" : "2027-01-01"));
    const prev = await svc(makeDb(rows)).preview("k1");
    expect(prev.totals.visits).toBe(500);
    expect(prev.rounds[0].groups).toEqual([
      { from: "2026-12-28", to: "2027-01-04", count: 250 },
      { from: "2027-01-01", to: "2027-01-04", count: 250 },
    ]);
  });

  it("covers Monday, Thursday and no-day rounds, counts distinct customers and conflicts, sorts rounds by name", async () => {
    const shared = cust("shared");
    const db = makeDb(
      [
        visit("vt", "RT", "2026-12-31", { technicianId: "t2" }),
        visit("vm", "RM", "2026-12-28", { property: { addressLine: "a", customer: shared } }),
        visit("vm2", "RM", "2026-12-28", { property: { addressLine: "b", customer: shared }, technician: { active: false } }),
        visit("vn", "RN", "2026-12-29", { technicianId: null, technician: null }),
        visit("vx", "RN", "2026-12-30", { technicianId: "t9", technician: null }),
      ],
      [{ ...XMAS }],
      ["t2"]
    );
    const prev = await svc(db).preview("k1");
    expect(prev.closureId).toBe("k1");
    expect(prev.mode).toBe("MOVE");
    expect(prev.rounds.map((r) => r.roundName)).toEqual(["Monday round", "Open round", "Thursday round"]);
    expect(prev.rounds[1].groups).toEqual([
      { from: "2026-12-29", to: "2027-01-04", count: 1 },
      { from: "2026-12-30", to: "2027-01-04", count: 1 },
    ]);
    expect(prev.conflicts).toEqual([
      { visitId: "vm2", technicianId: "t1", reason: "TECHNICIAN_INACTIVE" },
      { visitId: "vt", technicianId: "t2", reason: "TECHNICIAN_UNAVAILABLE" },
    ]);
    expect(prev.totals).toEqual({ visits: 5, rounds: 3, customers: 4, technicianConflicts: 2 });
    expect(prev.customerMessage).toBe(CLOSURE_MOVE_CUSTOMER_BODY);
  });

  it("an empty selection previews as empty; SKIP mode carries the skip message", async () => {
    const db = makeDb([], [{ ...XMAS, mode: "SKIP" }]);
    expect(await svc(db).preview("k1")).toEqual({
      closureId: "k1", mode: "SKIP", totals: { visits: 0, rounds: 0, customers: 0, technicianConflicts: 0 }, rounds: [], conflicts: [],
      customerMessage: CLOSURE_SKIP_CUSTOMER_BODY,
    });
    expect(db.technicianAvailability.findMany).not.toHaveBeenCalled();
  });

  it("orders groups of one round by from then to; two closures can send one day to two places", async () => {
    // Round-scoped extra closure pushes only RM visits further; RN visits share the date.
    const extra = { id: "k2", label: "Extra", startDate: d("2027-01-04"), endDate: d("2027-01-10"), mode: "MOVE", notifyCustomers: false, roundIds: ["RM"], appliedAt: null };
    const db = makeDb(
      [visit("a", "RM", "2026-12-29"), visit("b", "RM", "2026-12-28"), visit("c", "RM", "2026-12-28")],
      [{ ...XMAS }, extra]
    );
    const prev = await svc(db).preview("k1");
    expect(prev.rounds[0].groups).toEqual([
      { from: "2026-12-28", to: "2027-01-11", count: 2 },
      { from: "2026-12-29", to: "2027-01-11", count: 1 },
    ]);
  });

  it("orders carryover calls by from then target when two rounds share a source day", async () => {
    const db = makeDb([visit("t", "RT", "2026-12-28"), visit("m", "RM", "2026-12-28")]);
    await svc(db).apply("k1");
    const logs = db.activityLog.create.mock.calls.map((c: any) => `${c[0].data.details.from}>${c[0].data.details.to}`);
    expect(logs).toEqual(["2026-12-28>2027-01-04", "2026-12-28>2027-01-07"]);
  });

  it("two rounds with the same name sort by id", async () => {
    const same = { name: "Same", defaultDay: "MON" };
    const db = makeDb([visit("b", "RM", "2026-12-28", { roundId: "R2", round: same }), visit("a", "RM", "2026-12-28", { roundId: "R1", round: same })]);
    expect((await svc(db).preview("k1")).rounds.map((r) => r.roundId)).toEqual(["R1", "R2"]);
  });

  it("writes nothing and equals what apply then does", async () => {
    const db = ap1();
    const before = structuredClone(db.state);
    const prev = await svc(db).preview("k1");
    expect(db.state).toEqual(before);
    expect(db.visit.updateMany).not.toHaveBeenCalled();
    expect(db.activityLog.create).not.toHaveBeenCalled();
    expect(db.businessClosure.update).not.toHaveBeenCalled();
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(notifyVisitTechnicians).not.toHaveBeenCalled();

    const res = await svc(db).apply("k1");
    expect(prev.totals.visits).toBe(res.moved + res.skipped);
    const actual = new Map<string, number>();
    for (const g of prev.rounds.flatMap((r) => r.groups)) actual.set(`${g.from}>${g.to}`, g.count);
    expect(actual).toEqual(new Map([["2026-12-28>2027-01-04", 1], ["2026-12-29>2027-01-04", 1], ["2026-12-31>2027-01-07", 1]]));
  });
});

describe("notifications", () => {
  it("tells each technician once, with the new date (MOVE)", async () => {
    const db = makeDb([
      visit("a", "RM", "2026-12-28", { technicianId: "t1" }),
      visit("b", "RT", "2026-12-31", { technicianId: "t1" }),
      visit("c", "RN", "2026-12-29", { technicianId: "t2" }),
      visit("d", "RN", "2026-12-29", { technicianId: null, technician: null }),
    ]);
    const res = await svc(db).apply("k1");
    expect(res.notifiedTechnicians).toBe(2);
    expect(notifyVisitTechnicians).toHaveBeenCalledTimes(1);
    const [, refs, msg] = vi.mocked(notifyVisitTechnicians).mock.calls[0];
    expect(refs.map((r: any) => [r.id, iso(r.date)])).toEqual([["a", "2027-01-04"], ["c", "2027-01-04"], ["d", "2027-01-04"], ["b", "2027-01-07"]]);
    expect(msg({ count: 1, first: "x" })).toEqual({ type: "SCHEDULE", title: "1 visit moved for Christmas", body: "We're closed from 2026-12-24 to 2027-01-03." });
  });

  it("tells technicians of skipped visits with the original date (SKIP)", async () => {
    const db = makeDb([visit("a", "RM", "2026-12-28"), visit("b", "RM", "2026-12-28")], [{ ...XMAS, mode: "SKIP" }]);
    const res = await svc(db).apply("k1");
    expect(res.notifiedTechnicians).toBe(1);
    const [, refs, msg] = vi.mocked(notifyVisitTechnicians).mock.calls[0];
    expect(refs.map((r: any) => iso(r.date))).toEqual(["2026-12-28", "2026-12-28"]);
    expect(msg({ count: 2, first: "x" }).title).toBe("2 visits skipped for Christmas");
  });

  it("a failing technician notification never fails the apply", async () => {
    vi.mocked(notifyVisitTechnicians).mockRejectedValueOnce(new Error("push down"));
    const res = await svc(ap1()).apply("k1");
    expect(res.moved).toBe(3);
    expect(console.error).toHaveBeenCalled();
  });

  it("does not message customers unless ticked", async () => {
    await svc(ap1()).apply("k1");
    expect(broadcast).not.toHaveBeenCalled();
    await svc(ap1()).apply("k1", { notifyCustomers: false });
    expect(broadcast).not.toHaveBeenCalled();
  });

  it("messages once per customer with the MOVE body and per-visit new dates when the closure is ticked", async () => {
    const shared = cust("shared", { messagesOptOut: true });
    const db = makeDb(
      [
        visit("a", "RM", "2026-12-28", { property: { addressLine: "1 High St", customer: shared } }),
        visit("b", "RT", "2026-12-31", { property: { addressLine: "2 High St", customer: shared } }),
        visit("c", "RN", "2026-12-29", { property: { addressLine: "3 Low St", customer: cust("c3", { phone: null }) } }),
      ],
      [{ ...XMAS, notifyCustomers: true }]
    );
    const res = await svc(db).apply("k1");
    expect(res.notifiedCustomers).toBe(2);
    expect(broadcast).toHaveBeenCalledTimes(1);
    const [targets, opts] = broadcast.mock.calls[0];
    expect(opts).toMatchObject({ body: CLOSURE_MOVE_CUSTOMER_BODY, reason: "BUSINESS_CLOSURE", extraPayload: { closureId: "k1" } });
    expect(targets).toHaveLength(2);
    expect(targets[0].customer.messagesOptOut).toBe(true);
    expect(targets[0].vars).toEqual({
      customerName: "Jane shared", firstName: "Jane", address: "1 High St", date: "Monday 28 December", newDate: "Monday 4 January",
      startDate: "Thursday 24 December", endDate: "Sunday 3 January", businessName: "Shine",
    });
    expect(targets[1].vars.address).toBe("3 Low St");
  });

  it("the body argument overrides the closure's flag in both directions", async () => {
    await svc(makeDb([visit("a", "RM", "2026-12-28")], [{ ...XMAS, notifyCustomers: true }])).apply("k1", { notifyCustomers: false });
    expect(broadcast).not.toHaveBeenCalled();
    await svc(makeDb([visit("a", "RM", "2026-12-28")])).apply("k1", { notifyCustomers: true });
    expect(broadcast).toHaveBeenCalledTimes(1);
  });

  it("uses the SKIP body and the closure dates in SKIP mode", async () => {
    const db = makeDb([visit("a", "RM", "2026-12-28")], [{ ...XMAS, mode: "SKIP" }]);
    getCachedBusinessSettings.mockResolvedValue(null);
    const res = await svc(db).apply("k1", { notifyCustomers: true });
    expect(res.notifiedCustomers).toBe(2);
    expect(broadcast.mock.calls[0][1].body).toBe(CLOSURE_SKIP_CUSTOMER_BODY);
    expect(broadcast.mock.calls[0][0][0].vars).toMatchObject({ newDate: "", businessName: "" });
  });

  it("sends the MOVE and SKIP bodies separately when another closure skips some visits, one message per customer", async () => {
    const landing = { id: "k2", label: "Training day", startDate: d("2027-01-04"), endDate: d("2027-01-04"), mode: "SKIP", notifyCustomers: false, roundIds: [], appliedAt: null };
    const both = cust("both");
    const db = makeDb(
      [
        visit("moved", "RT", "2026-12-31", { property: { addressLine: "m", customer: cust("cm") } }),
        visit("skipA", "RM", "2026-12-28", { property: { addressLine: "s", customer: cust("cs") } }),
        visit("skipB", "RM", "2026-12-28", { property: { addressLine: "s2", customer: both } }),
        visit("movedB", "RT", "2026-12-31", { property: { addressLine: "m2", customer: both } }),
      ],
      [{ ...XMAS }, landing]
    );
    const res = await svc(db).apply("k1", { notifyCustomers: true });
    expect(res).toMatchObject({ moved: 2, skipped: 2, notifiedCustomers: 4 });
    expect(broadcast).toHaveBeenCalledTimes(2);
    expect(broadcast.mock.calls[0][1].body).toBe(CLOSURE_MOVE_CUSTOMER_BODY);
    expect(broadcast.mock.calls[0][0].map((t: any) => t.customer.id)).toEqual(["cm", "both"]);
    expect(broadcast.mock.calls[1][1].body).toBe(CLOSURE_SKIP_CUSTOMER_BODY);
    expect(broadcast.mock.calls[1][0].map((t: any) => t.customer.id)).toEqual(["cs"]);
  });

  it("a customer failure still completes the apply and reports customerNotificationError", async () => {
    broadcast.mockRejectedValueOnce(new Error("no channel"));
    const db = makeDb([visit("a", "RM", "2026-12-28")], [{ ...XMAS, notifyCustomers: true }]);
    const res = await svc(db).apply("k1");
    expect(res).toMatchObject({ moved: 1, notifiedCustomers: 0, customerNotificationError: "no channel" });
    expect(ymd(db, "a")).toBe("2027-01-04");
    expect(console.error).toHaveBeenCalled();
  });

  it("does not message anyone when nothing was changed", async () => {
    await svc(makeDb([], [{ ...XMAS, notifyCustomers: true }])).apply("k1");
    expect(broadcast).not.toHaveBeenCalled();
  });
});
