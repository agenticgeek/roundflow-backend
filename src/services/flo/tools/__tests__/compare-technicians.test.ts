import { describe, expect, it } from "vitest";
import { compareTechnicians } from "../compare-technicians";
import { ctxFor, dec, fakePrisma } from "./fake-prisma";

const visit = (tech: string, price: number, started?: string, completed?: string) => ({
  technicianId: tech, price: dec(price), startedAt: started ? new Date(started) : null, completedAt: completed ? new Date(completed) : null, _count: { issues: 1 },
});
const timedVisit = (tech: string, arrived: string, completed: string) => ({ technicianId: tech, arrivedAt: new Date(arrived), completedAt: new Date(completed) });
const grp = (technicianId: string, status: string, n: number) => ({ technicianId, status, _count: n });

const CURRENT = [
  visit("t1", 100, "2026-10-05T09:00:00Z", "2026-10-05T10:00:00Z"),
  visit("t1", 50.25),
  visit("t2", 200),
];
const PREVIOUS = [visit("t1", 50), visit("t2", 60), visit("t2", 40)];
const TIMED = [
  timedVisit("t1", "2026-10-05T09:00:00Z", "2026-10-05T09:30:00Z"),
  timedVisit("t1", "2026-10-06T08:00:00Z", "2026-10-06T09:00:00Z"),
  timedVisit("t2", "2026-10-07T08:00:00Z", "2026-10-07T07:00:00Z"), // completed before arrival: ignored
  { technicianId: "t1", arrivedAt: null, completedAt: null }, // no timestamps: ignored
];
const SEP = new Date("2026-09-01T00:00:00Z").getTime();

function world(extra: Record<string, unknown> = {}) {
  return fakePrisma({
    "visit.findMany": (a: { select: Record<string, unknown>; where: { date: { gte: Date } } }) =>
      a.select.arrivedAt ? TIMED : a.where.date.gte.getTime() === SEP ? PREVIOUS : CURRENT,
    "visit.groupBy": [grp("t1", "COMPLETED", 2), grp("t1", "SKIPPED", 2), grp("t2", "COMPLETED", 1), grp("t3", "SKIPPED", 4)],
    "technician.findMany": [
      { id: "t1", name: "James" },
      { id: "t2", name: "Liam" },
      { id: "t3", name: null },
      { id: "t4", name: "Idle" },
    ],
    "technicianIncident.groupBy": [{ technicianId: "t2", type: "STRIKE", _count: 1, _sum: { amount: null } }],
    "complaint.findMany": [{ technicianId: "t2", status: "OPEN", upheld: null, resolvedAt: null, createdAt: new Date("2026-10-06T00:00:00Z") }],
    ...extra,
  });
}

const BASE_KEYS = ["technician", "jobs", "skipped", "revenue", "revenuePerHour", "issues", "complaints", "strikes", "completionRate", "skipRate", "avgJobValue", "avgMinutesOnSite"];
const COMPARE_KEYS = ["previousJobs", "previousRevenue", "jobsChange", "revenueChange", "revenueChangePercent"];

describe("compare_technicians", () => {
  it("validates period / from / to / compare", () => {
    expect(compareTechnicians.parse({})).toEqual({ period: undefined, from: undefined, to: undefined });
    expect(compareTechnicians.parse({ period: "lastMonth" })).toMatchObject({ period: "lastMonth" });
    expect(compareTechnicians.parse({ from: "2026-10-01", to: "2026-10-31" })).toMatchObject({ from: "2026-10-01" });
    expect(compareTechnicians.parse({ compare: true })).toMatchObject({ compare: true });
    expect(compareTechnicians.parse({ compare: false }).compare).toBeUndefined();
    expect(compareTechnicians.parse({ compare: null }).compare).toBeUndefined();
    expect(() => compareTechnicians.parse({ compare: "yes" })).toThrow(/true or false/);
    expect(() => compareTechnicians.parse({ period: "decade" })).toThrow(/must be one of/);
    expect(() => compareTechnicians.parse({ period: "thisMonth", from: "2026-10-01", to: "2026-10-31" })).toThrow(/not both/);
    expect(() => compareTechnicians.parse({ from: "2026-10-01" })).toThrow(/together/);
    expect(() => compareTechnicians.parse({ to: "2026-10-01" })).toThrow(/together/);
    expect(() => compareTechnicians.parse({ from: "2026-02-30", to: "2026-03-01" })).toThrow(/calendar date/);
  });

  it("compares technicians with rates, average job value and minutes on site (null-safe, never NaN)", async () => {
    const { tp, calls } = world();
    const out = await compareTechnicians.run({ period: "lastMonth" }, ctxFor(tp));
    expect(out.dateRange).toEqual({ from: "2026-10-01", to: "2026-10-31", label: "1 to 31 Oct 2026" });
    expect(out.rows).toEqual([
      { technician: "Liam", jobs: 1, skipped: 0, revenue: 200, revenuePerHour: null, issues: 1, complaints: 1, strikes: 1, completionRate: 100, skipRate: 0, avgJobValue: 200, avgMinutesOnSite: null },
      { technician: "James", jobs: 2, skipped: 2, revenue: 150.25, revenuePerHour: 100, issues: 2, complaints: 0, strikes: 0, completionRate: 50, skipRate: 50, avgJobValue: 75.13, avgMinutesOnSite: 45 },
      { technician: "Idle", jobs: 0, skipped: 0, revenue: 0, revenuePerHour: null, issues: 0, complaints: 0, strikes: 0, completionRate: null, skipRate: null, avgJobValue: null, avgMinutesOnSite: null },
      { technician: "Unnamed technician", jobs: 0, skipped: 4, revenue: 0, revenuePerHour: null, issues: 0, complaints: 0, strikes: 0, completionRate: 0, skipRate: 100, avgJobValue: null, avgMinutesOnSite: null },
    ]);
    expect(out.totals).toEqual({
      technician: "Total", jobs: 3, skipped: 6, revenue: 350.25, revenuePerHour: null, issues: 3, complaints: 1, strikes: 1,
      completionRate: 33.33, skipRate: 66.67, avgJobValue: 116.75, avgMinutesOnSite: 45,
    });
    expect(out.truncated).toBe(false);
    expect(out.columns.map((c) => c.key)).toEqual(BASE_KEYS);
    for (const row of out.rows) expect(Object.keys(row)).toEqual(BASE_KEYS);
    const sk = calls.find((c) => c.path === "visit.groupBy")!.args as { where: { date: { gte: Date; lt: Date } } };
    expect(sk.where.date).toEqual({ gte: new Date("2026-10-01T00:00:00Z"), lt: new Date("2026-11-01T00:00:00Z") });
  });

  it("only counts visits due up to today, so a half-finished month is not marked as misses", async () => {
    const { tp, calls } = world();
    await compareTechnicians.run({}, ctxFor(tp)); // 10 Nov: this month ends 30 Nov
    const g = calls.find((c) => c.path === "visit.groupBy")!.args as { where: { date: { lt: Date } } };
    expect(g.where.date.lt).toEqual(new Date("2026-11-11T00:00:00Z"));
  });

  it("with compare:true adds the previous calendar month and the change", async () => {
    const { tp } = world();
    const out = await compareTechnicians.run({ period: "lastMonth", compare: true }, ctxFor(tp));
    const keys = [...BASE_KEYS, ...COMPARE_KEYS];
    expect(out.columns.map((c) => c.key)).toEqual(keys);
    for (const row of out.rows) expect(Object.keys(row)).toEqual(keys);
    expect(out.rows[0]).toMatchObject({ technician: "Liam", previousJobs: 2, previousRevenue: 100, jobsChange: -1, revenueChange: 100, revenueChangePercent: 100 });
    expect(out.rows[1]).toMatchObject({ technician: "James", previousJobs: 1, previousRevenue: 50, jobsChange: 1, revenueChange: 100.25, revenueChangePercent: 200.5 });
    // No previous revenue: the percentage is null, not Infinity.
    expect(out.rows[2]).toMatchObject({ technician: "Idle", previousRevenue: 0, revenueChange: 0, revenueChangePercent: null });
    expect(out.totals).toMatchObject({ previousJobs: 3, previousRevenue: 150, jobsChange: 0, revenueChange: 200.25, revenueChangePercent: 133.5 });
  });

  it("computes the previous window for a year, a rolling window and an explicit range", async () => {
    const seen: string[] = [];
    const spy = (a: { select: Record<string, unknown>; where: { date: { gte: Date; lt: Date } } }) => {
      if (!a.select.arrivedAt) seen.push(`${a.where.date.gte.toISOString().slice(0, 10)}..${a.where.date.lt.toISOString().slice(0, 10)}`);
      return [];
    };
    for (const args of [{ period: "thisYear" }, { period: "last30" }, { from: "2026-10-01", to: "2026-10-10" }, { period: "thisMonth" }] as const) {
      const { tp } = fakePrisma({ "visit.findMany": spy });
      await compareTechnicians.run({ ...args, compare: true }, ctxFor(tp));
    }
    // each call: current range then previous range (end exclusive)
    expect(seen).toEqual([
      "2026-01-01..2027-01-01", "2025-01-01..2026-01-01",
      "2026-10-12..2026-11-11", "2026-09-12..2026-10-12",
      "2026-10-01..2026-10-11", "2026-09-21..2026-10-01",
      "2026-11-01..2026-12-01", "2026-10-01..2026-11-01",
    ]);
  });

  it("flags truncation when more timed visits than the scan cap exist", async () => {
    const many = Array.from({ length: 20_001 }, () => timedVisit("t1", "2026-10-05T09:00:00Z", "2026-10-05T09:10:00Z"));
    const { tp } = world({ "visit.findMany": (a: { select: Record<string, unknown> }) => (a.select.arrivedAt ? many : CURRENT) });
    const out = await compareTechnicians.run({ period: "lastMonth" }, ctxFor(tp));
    expect(out.truncated).toBe(true);
    expect(out.rows.find((r) => r.technician === "James")).toMatchObject({ avgMinutesOnSite: 10 });
  });

  it("defaults to thisMonth and computes the month from the tenant-local date (00:30 BST on 1 Aug)", async () => {
    const { tp } = world();
    const out = await compareTechnicians.run({}, ctxFor(tp, "2026-07-31T23:30:00Z"));
    expect(out.dateRange).toMatchObject({ from: "2026-08-01", to: "2026-08-31" });
  });

  it("supports an explicit inclusive range and rejects ranges over 366 days", async () => {
    const { tp, calls } = world();
    const out = await compareTechnicians.run({ from: "2026-10-01", to: "2026-10-30" }, ctxFor(tp));
    expect(out.dateRange?.label).toBe("1 to 30 Oct 2026");
    const sk = calls.find((c) => c.path === "visit.groupBy")!.args as { where: { date: { lt: Date } } };
    expect(sk.where.date.lt).toEqual(new Date("2026-10-31T00:00:00Z"));
    await expect(compareTechnicians.run({ from: "2025-01-01", to: "2026-10-30" }, ctxFor(tp))).rejects.toThrow(/366 days/);
  });

  it("returns null totals when there are no technicians (also with compare)", async () => {
    const { tp } = fakePrisma();
    expect(await compareTechnicians.run({ period: "last30" }, ctxFor(tp))).toMatchObject({ rows: [], totals: null });
    expect(await compareTechnicians.run({ period: "last30", compare: true }, ctxFor(tp))).toMatchObject({ rows: [], totals: null });
  });

  it("uses the tenant-local date for yearly ranges too", async () => {
    const { tp } = fakePrisma();
    const out = await compareTechnicians.run({ period: "thisYear" }, ctxFor(tp));
    expect(out.dateRange).toMatchObject({ from: "2026-01-01", to: "2026-12-31" });
  });

  it("describes when not to use it, an example, the field glossary and the KPI vs complaints caveat", () => {
    expect(compareTechnicians.description).toMatch(/Do NOT use/);
    expect(compareTechnicians.description).toMatch(/Example: \{/);
    expect(compareTechnicians.description).toMatch(/Fields:/);
    expect(compareTechnicians.description).toMatch(/list_complaints/);
  });

  it("counts scheduled and in-progress visits as due (not completed, not skipped) and has no average time when nobody has timestamps", async () => {
    const { tp } = world({
      "visit.groupBy": [grp("t1", "COMPLETED", 1), grp("t1", "SCHEDULED", 2), grp("t1", "IN_PROGRESS", 1)],
      "visit.findMany": (a: { select: Record<string, unknown> }) => (a.select.arrivedAt ? [] : CURRENT),
    });
    const out = await compareTechnicians.run({ period: "lastMonth" }, ctxFor(tp));
    expect(out.rows.find((r) => r.technician === "James")).toMatchObject({ completionRate: 25, skipRate: 0, avgMinutesOnSite: null });
    expect(out.totals).toMatchObject({ completionRate: 25, skipRate: 0, avgMinutesOnSite: null });
  });
});
