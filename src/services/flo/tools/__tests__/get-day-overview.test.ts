import { describe, expect, it } from "vitest";
import { getDayOverview } from "../get-day-overview";
import { ctxFor, dec, fakePrisma } from "./fake-prisma";

const stat = (roundId: string | null, status: string, n: number, price: number) => ({ roundId, status, _count: n, _sum: { price: dec(price) } });
const tech = (roundId: string | null, technicianId: string, n = 1) => ({ roundId, technicianId, _count: n });
const time = (roundId: string | null, min: string | null, max: string | null) => ({ roundId, _min: { completedAt: min ? new Date(min) : null }, _max: { completedAt: max ? new Date(max) : null } });

/** Routes visit.groupBy by its `by` list so each of the three queries gets its own rows. */
const groupBy = (status: unknown[], techs: unknown[], times: unknown[]) => (a: { by: string[] }) =>
  a.by.length === 2 && a.by[1] === "status" ? status : a.by.length === 2 ? techs : times;

const FIXTURE = {
  "visit.groupBy": groupBy(
    [
      stat("r7", "COMPLETED", 2, 50.5), stat("r7", "SKIPPED", 1, 25),
      stat("r2", "IN_PROGRESS", 1, 10), stat("r2", "SCHEDULED", 1, 15.25),
      stat(null, "SCHEDULED", 1, 5),
    ],
    [tech("r7", "t-liam", 2), tech("r7", "t-ana"), tech("r2", "t-zed")],
    [time("r7", "2026-11-10T08:30:00Z", "2026-11-10T10:15:00Z")]
  ),
  "round.findMany": [{ id: "r7", name: "Round 7" }, { id: "r2", name: "Round 2" }],
  "technician.findMany": [{ id: "t-liam", name: "Liam" }, { id: "t-ana", name: "Ana" }, { id: "t-zed", name: "Zed" }],
};

describe("get_day_overview", () => {
  it("parses an optional date and rejects bad input", () => {
    expect(getDayOverview.parse(undefined)).toEqual({ date: undefined });
    expect(getDayOverview.parse({ date: "2026-11-09" })).toEqual({ date: "2026-11-09" });
    expect(() => getDayOverview.parse({ date: "2026-13-09" })).toThrow();
    expect(() => getDayOverview.parse({ day: "x" })).toThrow(/Unknown argument/);
  });

  it("summarises a day per round with every derived metric (14:00 local: two thirds of the working day gone)", async () => {
    const { tp, calls } = fakePrisma(FIXTURE);
    const out = await getDayOverview.run({}, ctxFor(tp, "2026-11-10T14:00:00Z")); // 14:00 London in November = 14:00 local
    expect(out.dateRange).toEqual({ from: "2026-11-10", to: "2026-11-10", label: "10 Nov 2026" });
    expect(out.rows).toEqual([
      { round: "No round", technician: null, total: 1, completed: 0, skipped: 0, inProgress: 0, remaining: 1, scheduledValue: 5, completedValue: 0, completionRate: 0, valueAtRisk: 5, behindBy: 1, firstCompletedAt: null, lastCompletedAt: null },
      { round: "Round 2", technician: "Zed", total: 2, completed: 0, skipped: 0, inProgress: 1, remaining: 2, scheduledValue: 25.25, completedValue: 0, completionRate: 0, valueAtRisk: 25.25, behindBy: 1, firstCompletedAt: null, lastCompletedAt: null },
      { round: "Round 7", technician: "Ana, Liam", total: 3, completed: 2, skipped: 1, inProgress: 0, remaining: 0, scheduledValue: 75.5, completedValue: 50.5, completionRate: 66.67, valueAtRisk: 25, behindBy: 0, firstCompletedAt: "08:30", lastCompletedAt: "10:15" },
    ]);
    // 14:00 is 6h into a 9h day: expected share 0.6667. No round: round(0.67)=1; Round 2: round(1.33)=1; Round 7: round(2)=2 done/skipped 3
    expect(out.totals).toEqual({
      round: "Total", technician: null, total: 6, completed: 2, skipped: 1, inProgress: 1, remaining: 3, scheduledValue: 105.75, completedValue: 50.5,
      completionRate: 33.33, valueAtRisk: 55.25, behindBy: 2, firstCompletedAt: "08:30", lastCompletedAt: "10:15",
    });
    expect(out.truncated).toBe(false);
    expect(out.columns.map((c) => c.key)).toEqual([
      "round", "technician", "total", "completed", "skipped", "inProgress", "remaining", "scheduledValue", "completedValue",
      "completionRate", "valueAtRisk", "behindBy", "firstCompletedAt", "lastCompletedAt",
    ]);
    for (const row of out.rows) expect(Object.keys(row)).toEqual(out.columns.map((c) => c.key));
    const where = (calls.find((c) => c.path === "visit.groupBy")!.args as { where: { date: { gte: Date; lt: Date }; status: unknown } }).where;
    expect(where.date).toEqual({ gte: new Date("2026-11-10T00:00:00Z"), lt: new Date("2026-11-11T00:00:00Z") });
    expect(where.status).toEqual({ not: "CANCELLED" });
    expect(calls.filter((c) => c.path === "visit.findMany")).toEqual([]); // no in-memory scan
  });

  it("a past day expects everything done (behindBy = still to do) and a future day expects nothing", async () => {
    const { tp } = fakePrisma(FIXTURE);
    const past = await getDayOverview.run({ date: "2026-11-09" }, ctxFor(tp, "2026-11-10T14:00:00Z"));
    expect(past.totals).toMatchObject({ behindBy: 1 + 2 + 0 });
    const future = await getDayOverview.run({ date: "2026-11-12" }, ctxFor(tp, "2026-11-10T14:00:00Z"));
    expect(future.totals).toMatchObject({ behindBy: 0 });
  });

  it("is never behind before the working day starts and clamps after it ends", async () => {
    const { tp } = fakePrisma(FIXTURE);
    expect((await getDayOverview.run({}, ctxFor(tp, "2026-11-10T06:00:00Z"))).totals).toMatchObject({ behindBy: 0 });
    expect((await getDayOverview.run({}, ctxFor(tp, "2026-11-10T20:00:00Z"))).totals).toMatchObject({ behindBy: 3 });
  });

  it("uses the requested date, and the tenant-local date when UTC is still the previous day", async () => {
    const a = fakePrisma();
    await getDayOverview.run({ date: "2026-11-09" }, ctxFor(a.tp));
    expect((a.calls.find((c) => c.path === "visit.groupBy")!.args as { where: { date: { gte: Date } } }).where.date.gte).toEqual(new Date("2026-11-09T00:00:00Z"));
    const b = fakePrisma();
    const out = await getDayOverview.run({}, ctxFor(b.tp, "2026-07-14T23:30:00Z")); // 00:30 BST on the 15th
    expect(out.dateRange?.from).toBe("2026-07-15");
  });

  it("renders completion times in the tenant zone (BST), keeping the earliest first and the latest last across a split round", async () => {
    const { tp } = fakePrisma({
      ...FIXTURE,
      "visit.groupBy": groupBy(
        [stat("r7", "COMPLETED", 2, 40)],
        [],
        [time("r7", "2026-07-14T07:05:00Z", "2026-07-14T09:00:00Z"), time("r7", "2026-07-14T06:00:00Z", "2026-07-14T08:00:00Z"), time("r7", null, null)]
      ),
    });
    const out = await getDayOverview.run({ date: "2026-07-14" }, ctxFor(tp, "2026-07-14T12:00:00Z"));
    expect(out.rows[0]).toMatchObject({ round: "Round 7", technician: null, firstCompletedAt: "07:00", lastCompletedAt: "10:00" });
  });

  it("returns an empty result with null totals when nothing is scheduled", async () => {
    const { tp } = fakePrisma();
    const out = await getDayOverview.run({}, ctxFor(tp));
    expect(out).toMatchObject({ rows: [], totals: null, truncated: false });
  });

  it("gives a null completion rate (not NaN) for a round with zero stops and names an unknown round", async () => {
    const { tp } = fakePrisma({ "visit.groupBy": groupBy([stat("gone", "COMPLETED", 0, 0)], [], []) });
    const out = await getDayOverview.run({}, ctxFor(tp));
    expect(out.rows[0]).toMatchObject({ round: "Unknown round", total: 0, completionRate: null, valueAtRisk: 0 });
    expect(out.totals).toMatchObject({ completionRate: null });
  });

  it("describes when not to use it, an example and the output fields", () => {
    expect(getDayOverview.description).toMatch(/Do NOT use/);
    expect(getDayOverview.description).toMatch(/Example: \{/);
    expect(getDayOverview.description).toMatch(/Fields:/);
  });

  it("takes the earliest first and the latest last completion across rounds", async () => {
    const { tp } = fakePrisma({
      ...FIXTURE,
      "visit.groupBy": groupBy(
        [stat("r7", "COMPLETED", 1, 10), stat("r2", "COMPLETED", 1, 10)],
        [],
        [time("r7", "2026-11-10T08:30:00Z", "2026-11-10T10:15:00Z"), time("r2", "2026-11-10T07:45:00Z", "2026-11-10T12:00:00Z")]
      ),
    });
    const out = await getDayOverview.run({}, ctxFor(tp, "2026-11-10T14:00:00Z"));
    expect(out.totals).toMatchObject({ firstCompletedAt: "07:45", lastCompletedAt: "12:00" });
    const reversed = fakePrisma({
      ...FIXTURE,
      "visit.groupBy": groupBy(
        [stat("r2", "COMPLETED", 1, 10), stat("r7", "COMPLETED", 1, 10)],
        [],
        [time("r2", "2026-11-10T08:30:00Z", "2026-11-10T12:00:00Z"), time("r7", "2026-11-10T07:45:00Z", "2026-11-10T10:15:00Z")]
      ),
    });
    expect((await getDayOverview.run({}, ctxFor(reversed.tp, "2026-11-10T14:00:00Z"))).totals).toMatchObject({ firstCompletedAt: "07:45", lastCompletedAt: "12:00" });
  });

  it("tolerates a null price sum, visits with no technician, an unknown technician, and a completion time with no latest", async () => {
    const { tp } = fakePrisma({
      "visit.groupBy": groupBy(
        [{ roundId: "r7", status: "COMPLETED", _count: 1, _sum: { price: null } }],
        [tech("r7", "t-liam"), { roundId: "r7", technicianId: null, _count: 1 }, tech("r7", "t-gone")],
        [{ roundId: "r7", _min: { completedAt: new Date("2026-11-10T08:30:00Z") }, _max: { completedAt: null } }]
      ),
      "round.findMany": [{ id: "r7", name: "Round 7" }],
      "technician.findMany": [{ id: "t-liam", name: "Liam" }],
    });
    const out = await getDayOverview.run({}, ctxFor(tp, "2026-11-10T14:00:00Z"));
    expect(out.rows[0]).toMatchObject({ technician: "Liam", scheduledValue: 0, firstCompletedAt: "08:30", lastCompletedAt: null });
    expect(out.totals).toMatchObject({ firstCompletedAt: "08:30", lastCompletedAt: null });
  });

  it("keeps the later last completion when a later-named round finishes after an earlier one", async () => {
    const { tp } = fakePrisma({
      ...FIXTURE,
      "visit.groupBy": groupBy(
        [stat("r2", "COMPLETED", 1, 10), stat("r7", "COMPLETED", 1, 10)],
        [],
        [time("r2", "2026-11-10T07:45:00Z", "2026-11-10T09:00:00Z"), time("r7", "2026-11-10T08:30:00Z", "2026-11-10T10:15:00Z")]
      ),
    });
    const out = await getDayOverview.run({}, ctxFor(tp, "2026-11-10T14:00:00Z"));
    expect(out.totals).toMatchObject({ firstCompletedAt: "07:45", lastCompletedAt: "10:15" });
  });
});
