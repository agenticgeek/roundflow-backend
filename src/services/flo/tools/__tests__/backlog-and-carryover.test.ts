import { describe, expect, it } from "vitest";
import { backlogAndCarryover } from "../backlog-and-carryover";
import { ctxFor, dec, fakePrisma, WRITE_METHODS } from "./fake-prisma";

const d = (v: string) => new Date(`${v}T00:00:00Z`);

const CARRIED = [
  { roundId: "r1", _count: { _all: 2 }, _sum: { price: dec(60) }, _min: { carriedOverFromDate: d("2026-11-02") }, _max: { carryoverCount: 3 } },
  { roundId: null, _count: 1, _sum: { price: dec(10) }, _min: { carriedOverFromDate: null }, _max: { carryoverCount: 0 } },
];
const PAST = [
  { roundId: "r1", _count: { _all: 4 }, _sum: { price: dec(100) }, _min: { date: d("2026-11-01") } },
  { roundId: "r2", _count: { _all: 1 }, _sum: { price: dec(25) }, _min: { date: null } },
  { roundId: "gone", _count: { _all: 1 }, _sum: {}, _min: { date: d("2026-11-09") } },
];

const HANDLERS = {
  "visit.groupBy": (a: { where: { carryoverCount?: unknown } }) => (a.where.carryoverCount ? CARRIED : PAST),
  "round.findMany": [{ id: "r1", name: "Monday North" }, { id: "r2", name: "Tuesday South" }],
};

describe("backlog_and_carryover", () => {
  it("validates input", () => {
    expect(backlogAndCarryover.parse({})).toEqual({ roundId: undefined, limit: 50 });
    expect(backlogAndCarryover.parse({ roundId: "r1", limit: 5 })).toEqual({ roundId: "r1", limit: 5 });
    expect(() => backlogAndCarryover.parse({ roundId: "bad id!" })).toThrow(/not a valid id/);
    expect(() => backlogAndCarryover.parse({ limit: 0 })).toThrow();
    expect(backlogAndCarryover.name).toBe("backlog_and_carryover");
  });

  it("merges carried-over and past-due aggregates per round, biggest first, with totals", async () => {
    const { tp, calls } = fakePrisma(HANDLERS);
    const out = await backlogAndCarryover.run({ limit: 50 }, ctxFor(tp));
    expect(out.rows).toEqual([
      { round: "Monday North", carriedOver: 2, carriedOverValue: 60, maxCarryovers: 3, oldestCarriedFrom: "2026-11-02", pastDue: 4, pastDueValue: 100, oldestPastDue: "2026-11-01", daysBehind: 9 },
      { round: "Tuesday South", carriedOver: 0, carriedOverValue: 0, maxCarryovers: null, oldestCarriedFrom: null, pastDue: 1, pastDueValue: 25, oldestPastDue: null, daysBehind: null },
      { round: "No round", carriedOver: 1, carriedOverValue: 10, maxCarryovers: null, oldestCarriedFrom: null, pastDue: 0, pastDueValue: 0, oldestPastDue: null, daysBehind: null },
      { round: "Unknown round", carriedOver: 0, carriedOverValue: 0, maxCarryovers: null, oldestCarriedFrom: null, pastDue: 1, pastDueValue: 0, oldestPastDue: "2026-11-09", daysBehind: 1 },
    ]);
    expect(out.totals).toEqual({
      round: "Total", rounds: 4, carriedOver: 3, carriedOverValue: 70, maxCarryovers: 3, oldestCarriedFrom: "2026-11-02",
      pastDue: 6, pastDueValue: 125, oldestPastDue: "2026-11-01", daysBehind: 9,
    });
    expect(out.truncated).toBe(false);
    expect(out.dateRange).toBeNull();
    const pastQ = calls.filter((c) => c.path === "visit.groupBy").map((c) => c.args as { where: { date?: { lt: Date }; status: { in: string[] } } }).find((a) => a.where.date);
    expect(pastQ?.where.date?.lt).toEqual(d("2026-11-10"));
    expect(pastQ?.where.status.in).toEqual(["SCHEDULED", "IN_PROGRESS"]);
  });

  it("scopes to one round and honours the limit", async () => {
    const { tp, calls } = fakePrisma(HANDLERS);
    const out = await backlogAndCarryover.run({ roundId: "r1", limit: 1 }, ctxFor(tp));
    expect(out.rows).toHaveLength(1);
    expect(out.truncated).toBe(true);
    expect((calls.find((c) => c.path === "visit.groupBy")!.args as { where: { roundId: string } }).where.roundId).toBe("r1");
  });

  it("returns null totals when nothing has slipped", async () => {
    const { tp, calls } = fakePrisma();
    expect(await backlogAndCarryover.run({ limit: 50 }, ctxFor(tp))).toMatchObject({ rows: [], totals: null, truncated: false });
    expect(calls.find((c) => c.path === "round.findMany")).toBeUndefined();
  });

  it("only-carried and only-past rounds sum correctly (no carry-over at all)", async () => {
    const { tp } = fakePrisma({ "visit.groupBy": (a: { where: { carryoverCount?: unknown } }) => (a.where.carryoverCount ? [] : [{ roundId: "r1", _count: { _all: 1 }, _sum: { price: dec(5) }, _min: { date: d("2026-11-10") } }]), "round.findMany": [{ id: "r1", name: "A" }] });
    const out = await backlogAndCarryover.run({ limit: 5 }, ctxFor(tp));
    expect(out.totals).toMatchObject({ carriedOver: 0, maxCarryovers: null, oldestCarriedFrom: null, pastDue: 1, daysBehind: 0 });
  });

  it("breaks a value tie by round name and has no oldest-past date when only carry-overs exist", async () => {
    const carried = [
      { roundId: "r2", _count: { _all: 1 }, _sum: { price: dec(10) }, _min: { carriedOverFromDate: d("2026-11-03") }, _max: { carryoverCount: 1 } },
      { roundId: "r1", _count: { _all: 1 }, _sum: { price: dec(10) }, _min: { carriedOverFromDate: d("2026-11-05") }, _max: { carryoverCount: 2 } },
    ];
    const { tp } = fakePrisma({ "visit.groupBy": (a: { where: { carryoverCount?: unknown } }) => (a.where.carryoverCount ? carried : []), "round.findMany": [{ id: "r1", name: "A" }, { id: "r2", name: "B" }] });
    const out = await backlogAndCarryover.run({ limit: 5 }, ctxFor(tp));
    expect(out.rows.map((r) => r.round)).toEqual(["A", "B"]);
    expect(out.totals).toMatchObject({ oldestCarriedFrom: "2026-11-03", oldestPastDue: null, daysBehind: null });
  });

  it("never writes and exposes no secret-looking keys", async () => {
    const { tp, calls } = fakePrisma(HANDLERS);
    const out = await backlogAndCarryover.run({ limit: 50 }, ctxFor(tp));
    expect(calls.filter((c) => (WRITE_METHODS as readonly string[]).some((m) => c.path.endsWith(`.${m}`)))).toEqual([]);
    expect(JSON.stringify(calls.map((c) => c.args))).not.toMatch(/notes|stripe|gocardless|token|secret/i);
    expect([...Object.keys(out.rows[0]), ...Object.keys(out.totals ?? {})].filter((k) => /bank|token|secret|password|webhook|mandate|stripe|note|body/i.test(k))).toEqual([]);
  });
});
