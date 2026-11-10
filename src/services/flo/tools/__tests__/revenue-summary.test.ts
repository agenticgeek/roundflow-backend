import { describe, expect, it } from "vitest";
import { revenueSummary } from "../revenue-summary";
import { ctxFor, dec, fakePrisma } from "./fake-prisma";

const v = (date: string, price: number, over: Record<string, unknown> = {}) => ({
  date: new Date(`${date}T00:00:00Z`), price: dec(price), round: { name: "Round 1" }, technician: { name: "Liam" }, property: { serviceArea: { name: "Wirral" } }, ...over,
});

const CURRENT = [
  v("2026-11-02", 100),
  v("2026-11-03", 50.5, { property: { serviceArea: { name: "Chester" } }, round: { name: "Round 2" } }),
  v("2026-11-04", 25, { property: { serviceArea: null }, round: null, technician: null }),
];
const PREVIOUS = [
  v("2026-10-02", 80),
  v("2026-10-03", 40, { property: { serviceArea: { name: "Old Area" } } }),
];

const compareWorld = () =>
  fakePrisma({
    "visit.findMany": (a: { where: { date: { gte: Date } } }) => (a.where.date.gte.toISOString().startsWith("2026-10") ? PREVIOUS : CURRENT),
  });

describe("revenue_summary", () => {
  it("validates input", () => {
    expect(revenueSummary.parse({})).toEqual({ from: undefined, to: undefined, groupBy: "SERVICE_AREA", compareFrom: undefined, compareTo: undefined });
    expect(revenueSummary.parse({ groupBy: "MONTH", compareFrom: "2026-10-01", compareTo: "2026-10-31" })).toMatchObject({ groupBy: "MONTH" });
    expect(() => revenueSummary.parse({ groupBy: "COLOUR" })).toThrow(/must be one of/);
    expect(() => revenueSummary.parse({ compareFrom: "2026-10-01" })).toThrow(/together/);
    expect(() => revenueSummary.parse({ compareTo: "2026-10-01" })).toThrow(/together/);
    expect(() => revenueSummary.parse({ from: "bad" })).toThrow(/YYYY-MM-DD/);
  });

  it("sums completed-visit value per service area with shares, largest first", async () => {
    const { tp, calls } = fakePrisma({ "visit.findMany": CURRENT });
    const out = await revenueSummary.run({ groupBy: "SERVICE_AREA" }, ctxFor(tp));
    expect(out.dateRange).toEqual({ from: "2026-11-01", to: "2026-11-10", label: "1 to 10 Nov 2026" });
    expect(out.rows).toEqual([
      { group: "Wirral", revenue: 100, jobs: 1, share: 56.98 },
      { group: "Chester", revenue: 50.5, jobs: 1, share: 28.77 },
      { group: "No service area", revenue: 25, jobs: 1, share: 14.25 },
    ]);
    expect(out.totals).toEqual({ group: "Total", revenue: 175.5, jobs: 3, share: 100 });
    expect(out.columns.map((c) => c.key)).toEqual(["group", "revenue", "jobs", "share"]);
    expect(out.truncated).toBe(false);
    expect((calls.find((c) => c.path === "visit.findMany")!.args as { where: { status: string } }).where.status).toBe("COMPLETED");
  });

  it("groups by round, technician and month (months in date order)", async () => {
    const { tp } = fakePrisma({ "visit.findMany": [...CURRENT, v("2026-10-30", 10)] });
    const ctx = ctxFor(tp);
    expect((await revenueSummary.run({ groupBy: "ROUND", from: "2026-10-01", to: "2026-11-10" }, ctx)).rows.map((r) => r.group)).toEqual(["Round 1", "Round 2", "No round"]);
    expect((await revenueSummary.run({ groupBy: "TECHNICIAN", from: "2026-10-01", to: "2026-11-10" }, ctx)).rows.map((r) => [r.group, r.revenue])).toEqual([["Liam", 160.5], ["Unassigned", 25]]);
    expect((await revenueSummary.run({ groupBy: "MONTH", from: "2026-10-01", to: "2026-11-10" }, ctx)).rows.map((r) => [r.group, r.revenue])).toEqual([["2026-10", 10], ["2026-11", 175.5]]);
  });

  it("orders equal revenue by group name", async () => {
    const { tp } = fakePrisma({ "visit.findMany": [v("2026-11-02", 10, { technician: { name: "Zed" } }), v("2026-11-02", 10, { technician: { name: "Abe" } })] });
    expect((await revenueSummary.run({ groupBy: "TECHNICIAN" }, ctxFor(tp))).rows.map((r) => r.group)).toEqual(["Abe", "Zed"]);
  });

  it("compares with a second range: change in pounds and percent, including new and vanished groups", async () => {
    const { tp, calls } = compareWorld();
    const out = await revenueSummary.run({ groupBy: "SERVICE_AREA", from: "2026-11-01", to: "2026-11-10", compareFrom: "2026-10-01", compareTo: "2026-10-31" }, ctxFor(tp));
    expect(out.columns.map((c) => c.key)).toEqual(["group", "revenue", "previousRevenue", "change", "changePercent", "jobs"]);
    expect(out.rows).toEqual([
      { group: "Wirral", revenue: 100, previousRevenue: 80, change: 20, changePercent: 25, jobs: 1 },
      { group: "Chester", revenue: 50.5, previousRevenue: 0, change: 50.5, changePercent: null, jobs: 1 },
      { group: "No service area", revenue: 25, previousRevenue: 0, change: 25, changePercent: null, jobs: 1 },
      { group: "Old Area", revenue: 0, previousRevenue: 40, change: -40, changePercent: -100, jobs: 0 },
    ]);
    expect(out.totals).toEqual({ group: "Total", revenue: 175.5, previousRevenue: 120, change: 55.5, changePercent: 46.25, jobs: 3 });
    expect(calls.filter((c) => c.path === "visit.findMany")).toHaveLength(2);
  });

  it("rejects a bad comparison range and flags a truncated scan on either side", async () => {
    const { tp } = fakePrisma();
    await expect(revenueSummary.run({ groupBy: "ROUND", compareFrom: "2025-01-01", compareTo: "2026-06-01" }, ctxFor(tp))).rejects.toThrow(/366 days/);
    const many = Array.from({ length: 20_001 }, () => v("2026-11-02", 1));
    const big = fakePrisma({ "visit.findMany": many });
    expect((await revenueSummary.run({ groupBy: "ROUND" }, ctxFor(big.tp))).truncated).toBe(true);
    const prevBig = fakePrisma({ "visit.findMany": (a: { where: { date: { gte: Date } } }) => (a.where.date.gte.toISOString().startsWith("2026-10") ? many : []) });
    expect((await revenueSummary.run({ groupBy: "ROUND", compareFrom: "2026-10-01", compareTo: "2026-10-31" }, ctxFor(prevBig.tp))).truncated).toBe(true);
  });

  it("returns null totals when there is no revenue, with or without a comparison", async () => {
    const { tp } = fakePrisma();
    expect(await revenueSummary.run({ groupBy: "ROUND" }, ctxFor(tp))).toMatchObject({ rows: [], totals: null });
    expect(await revenueSummary.run({ groupBy: "ROUND", compareFrom: "2026-10-01", compareTo: "2026-10-31" }, ctxFor(tp))).toMatchObject({ rows: [], totals: null });
  });
});
