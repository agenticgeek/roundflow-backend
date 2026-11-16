import { describe, expect, it } from "vitest";
import { revenueSummary } from "../revenue-summary";
import { ctxFor, dec, fakePrisma } from "./fake-prisma";

type Where = { date: { gte: Date; lt: Date }; property?: { serviceAreaId: string | null } };
const isPrevious = (a: { where: Where }) => a.where.date.gte.toISOString() < "2026-11-01";
/** Picks the current or previous fixture by the requested window. */
const period = <T>(current: T, previous: T) => (a: { where: Where }) => (isPrevious(a) ? previous : current);

const g = (extra: Record<string, unknown>, revenue: number, jobs: number) => ({ ...extra, _sum: { price: dec(revenue) }, _count: jobs });
const agg = (revenue: number, jobs: number) => ({ _sum: { price: dec(revenue) }, _count: jobs });
const d = (day: string) => new Date(`${day}T00:00:00Z`);

const AREAS = [{ id: "a1", name: "Wirral" }, { id: "a2", name: "Chester" }, { id: "a3", name: "Old Area" }];
const CUR_AREA: Record<string, [number, number]> = { a1: [100, 1], a2: [50.5, 1], a3: [0, 0], none: [25, 1], all: [175.5, 3] };
const PREV_AREA: Record<string, [number, number]> = { a1: [80, 1], a2: [0, 0], a3: [40, 1], none: [0, 0], all: [120, 2] };
const areaAggregate = (table: Record<string, [number, number]>) => (a: { where: Where }) => {
  const k = a.where.property ? (a.where.property.serviceAreaId ?? "none") : "all";
  return agg(...table[k]);
};
const areaWorld = () =>
  fakePrisma({
    "serviceArea.findMany": AREAS,
    "visit.aggregate": (a: { where: Where }) => areaAggregate(isPrevious(a) ? PREV_AREA : CUR_AREA)(a),
  });

describe("revenue_summary", () => {
  it("validates input", () => {
    expect(revenueSummary.parse({})).toEqual({ from: undefined, to: undefined, groupBy: "SERVICE_AREA", compareFrom: undefined, compareTo: undefined });
    expect(revenueSummary.parse({ groupBy: "MONTH", compareFrom: "2026-10-01", compareTo: "2026-10-31" })).toMatchObject({ groupBy: "MONTH" });
    for (const gb of ["DAY", "WEEK", "SERVICE", "CUSTOMER", "PAYMENT_METHOD"]) expect(revenueSummary.parse({ groupBy: gb })).toMatchObject({ groupBy: gb });
    expect(revenueSummary.parse({ compare: true })).toMatchObject({ compare: true });
    expect(revenueSummary.parse({ compare: false }).compare).toBeUndefined();
    expect(() => revenueSummary.parse({ compare: 1 })).toThrow(/true or false/);
    expect(() => revenueSummary.parse({ groupBy: "COLOUR" })).toThrow(/must be one of/);
    expect(() => revenueSummary.parse({ compareFrom: "2026-10-01" })).toThrow(/together/);
    expect(() => revenueSummary.parse({ compareTo: "2026-10-01" })).toThrow(/together/);
    expect(() => revenueSummary.parse({ from: "bad" })).toThrow(/YYYY-MM-DD/);
  });

  it("sums completed-visit value per service area with shares, largest first, from aggregates (no row scan)", async () => {
    const { tp, calls } = areaWorld();
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
    expect(calls.some((c) => c.path === "visit.findMany")).toBe(false);
    const first = calls.find((c) => c.path === "visit.aggregate")!.args as { where: { status: string; date: { gte: Date; lt: Date } } };
    expect(first.where.status).toBe("COMPLETED");
    expect(first.where.date).toEqual({ gte: d("2026-11-01"), lt: d("2026-11-11") });
  });

  it("groups by round, technician, service and payment method, naming missing and unknown ones", async () => {
    const { tp } = fakePrisma({
      "visit.aggregate": agg(185.5, 5),
      "visit.groupBy": (a: { by: string[] }) =>
        ({
          roundId: [g({ roundId: "r1" }, 100, 2), g({ roundId: "r2" }, 50.5, 1), g({ roundId: null }, 25, 1), g({ roundId: "gone" }, 10, 1)],
          technicianId: [g({ technicianId: "t1" }, 160.5, 4), g({ technicianId: null }, 25, 1), g({ technicianId: "t2" }, 0, 0)],
          serviceId: [g({ serviceId: "s1" }, 150, 4), g({ serviceId: null }, 20, 1), g({ serviceId: "gone" }, 15.5, 1)],
          paymentMethod: [g({ paymentMethod: "GOCARDLESS" }, 120, 3), g({ paymentMethod: null }, 65.5, 2)],
        })[a.by[0]],
      "round.findMany": [{ id: "r1", name: "Round 1" }, { id: "r2", name: "Round 2" }],
      "technician.findMany": [{ id: "t1", name: "Liam" }, { id: "t2", name: null }],
      "service.findMany": [{ id: "s1", name: "Window clean" }],
    });
    const ctx = ctxFor(tp);
    const run = async (groupBy: string) => (await revenueSummary.run({ groupBy } as never, ctx)).rows.map((r) => [r.group, r.revenue, r.jobs]);
    expect(await run("ROUND")).toEqual([["Round 1", 100, 2], ["Round 2", 50.5, 1], ["No round", 25, 1], ["Unknown round", 10, 1]]);
    expect(await run("TECHNICIAN")).toEqual([["Liam", 160.5, 4], ["Unassigned", 25, 1], ["Unnamed technician", 0, 0]]);
    expect(await run("SERVICE")).toEqual([["Window clean", 150, 4], ["No service", 20, 1], ["Unknown service", 15.5, 1]]);
    expect(await run("PAYMENT_METHOD")).toEqual([["GOCARDLESS", 120, 3], ["No payment method", 65.5, 2]]);
  });

  it("orders equal revenue by group name and merges groups that share a name", async () => {
    const { tp } = fakePrisma({
      "visit.aggregate": agg(30, 3),
      "visit.groupBy": [g({ technicianId: "t1" }, 10, 1), g({ technicianId: "t2" }, 10, 1), g({ technicianId: "t3" }, 10, 1)],
      "technician.findMany": [{ id: "t1", name: "Zed" }, { id: "t2", name: "Abe" }, { id: "t3", name: "Zed" }],
    });
    const out = await revenueSummary.run({ groupBy: "TECHNICIAN" }, ctxFor(tp));
    expect(out.rows.map((r) => [r.group, r.revenue])).toEqual([["Zed", 20], ["Abe", 10]]);
  });

  it("groups over time: DAY, WEEK (Monday start, Sunday belongs to the week before) and MONTH, always in date order", async () => {
    const days = [g({ date: d("2026-11-09") }, 5, 1), g({ date: d("2026-11-08") }, 20, 2), g({ date: d("2026-11-02") }, 10, 1), g({ date: d("2026-11-03") }, 30, 1), g({ date: d("2026-10-30") }, 7, 1)];
    const { tp, calls } = fakePrisma({ "visit.aggregate": agg(72, 6), "visit.groupBy": days });
    const ctx = ctxFor(tp);
    const run = async (groupBy: string) => (await revenueSummary.run({ groupBy, from: "2026-10-01", to: "2026-11-10" } as never, ctx)).rows.map((r) => [r.group, r.revenue, r.jobs]);
    expect(await run("DAY")).toEqual([["2026-10-30", 7, 1], ["2026-11-02", 10, 1], ["2026-11-03", 30, 1], ["2026-11-08", 20, 2], ["2026-11-09", 5, 1]]);
    expect(await run("WEEK")).toEqual([["Week of 2026-10-26", 7, 1], ["Week of 2026-11-02", 60, 4], ["Week of 2026-11-09", 5, 1]]);
    expect(await run("MONTH")).toEqual([["2026-10", 7, 1], ["2026-11", 65, 5]]);
    expect((calls.find((c) => c.path === "visit.groupBy")!.args as { by: string[] }).by).toEqual(["date"]);
  });

  it("ranks the top 20 customers (folding properties into customers), keeps the total exact and flags truncation", async () => {
    const props = Array.from({ length: 25 }, (_, i) => g({ propertyId: `p${i}` }, 100 - i, 1));
    props.push(g({ propertyId: "p-extra" }, 0.5, 1)); // a second property of customer c0
    props.push(g({ propertyId: "p-orphan" }, 0.25, 1)); // property not found
    const { tp, calls } = fakePrisma({
      "visit.aggregate": agg(2500, 27),
      "visit.groupBy": props,
      "property.findMany": [
        ...Array.from({ length: 25 }, (_, i) => ({ id: `p${i}`, customerId: `c${i}`, customer: { name: `Customer ${String(i).padStart(2, "0")}` } })),
        { id: "p-extra", customerId: "c0", customer: { name: "Customer 00" } },
      ],
    });
    const out = await revenueSummary.run({ groupBy: "CUSTOMER" }, ctxFor(tp));
    expect(out.rows).toHaveLength(20);
    expect(out.rows[0]).toEqual({ group: "Customer 00", revenue: 100.5, jobs: 2, share: 4.02 });
    expect(out.rows[19]).toMatchObject({ group: "Customer 19", revenue: 81 });
    expect(out.totals).toEqual({ group: "Total", revenue: 2500, jobs: 27, share: 100 });
    expect(out.truncated).toBe(true);
    const q = calls.find((c) => c.path === "visit.groupBy")!.args as { by: string[]; orderBy: unknown; take: number };
    expect(q).toMatchObject({ by: ["propertyId"], orderBy: { _sum: { price: "desc" } }, take: 2001 });
  });

  it("customer ranking: not truncated with few customers, an unknown property keeps its own row, and the property scan cap is flagged", async () => {
    const small = fakePrisma({
      "visit.aggregate": agg(30.25, 2),
      "visit.groupBy": [g({ propertyId: "p1" }, 30, 1), g({ propertyId: "ghost" }, 0.25, 1)],
      "property.findMany": [{ id: "p1", customerId: "c1", customer: { name: "Mrs Smith" } }],
    });
    const out = await revenueSummary.run({ groupBy: "CUSTOMER" }, ctxFor(small.tp));
    expect(out.rows.map((r) => r.group)).toEqual(["Mrs Smith", "Unknown customer"]);
    expect(out.truncated).toBe(false);
    const capped = fakePrisma({ "visit.aggregate": agg(1, 1), "visit.groupBy": Array.from({ length: 2001 }, (_, i) => g({ propertyId: `p${i}` }, 1, 1)) });
    expect((await revenueSummary.run({ groupBy: "CUSTOMER" }, ctxFor(capped.tp))).truncated).toBe(true);
  });

  it("compares with a second range: change in pounds and percent, including new and vanished groups", async () => {
    const { tp, calls } = areaWorld();
    const out = await revenueSummary.run({ groupBy: "SERVICE_AREA", from: "2026-11-01", to: "2026-11-10", compareFrom: "2026-10-01", compareTo: "2026-10-31" }, ctxFor(tp));
    expect(out.columns.map((c) => c.key)).toEqual(["group", "revenue", "previousRevenue", "change", "changePercent", "jobs"]);
    expect(out.rows).toEqual([
      { group: "Wirral", revenue: 100, previousRevenue: 80, change: 20, changePercent: 25, jobs: 1 },
      { group: "Chester", revenue: 50.5, previousRevenue: 0, change: 50.5, changePercent: null, jobs: 1 },
      { group: "No service area", revenue: 25, previousRevenue: 0, change: 25, changePercent: null, jobs: 1 },
      { group: "Old Area", revenue: 0, previousRevenue: 40, change: -40, changePercent: -100, jobs: 0 },
    ]);
    expect(out.totals).toEqual({ group: "Total", revenue: 175.5, previousRevenue: 120, change: 55.5, changePercent: 46.25, jobs: 3 });
    expect(calls.filter((c) => c.path === "visit.aggregate" && !(c.args as { where: Where }).where.property)).toHaveLength(2);
  });

  it("compare:true uses the same-length window just before the range", async () => {
    const { tp, calls } = areaWorld();
    const out = await revenueSummary.run({ groupBy: "SERVICE_AREA", from: "2026-11-01", to: "2026-11-10", compare: true }, ctxFor(tp));
    expect(out.columns.map((c) => c.key)).toContain("previousRevenue");
    const windows = calls.filter((c) => c.path === "visit.aggregate" && !(c.args as { where: Where }).where.property).map((c) => (c.args as { where: Where }).where.date);
    expect(windows).toEqual([{ gte: d("2026-11-01"), lt: d("2026-11-11") }, { gte: d("2026-10-22"), lt: d("2026-11-01") }]);
    // explicit compareFrom/compareTo wins over compare:true
    const explicit = areaWorld();
    await revenueSummary.run({ groupBy: "SERVICE_AREA", compare: true, compareFrom: "2026-09-01", compareTo: "2026-09-30" }, ctxFor(explicit.tp));
    const w = explicit.calls.filter((c) => c.path === "visit.aggregate" && !(c.args as { where: Where }).where.property).map((c) => (c.args as { where: Where }).where.date);
    expect(w[1]).toEqual({ gte: d("2026-09-01"), lt: d("2026-10-01") });
  });

  it("customer comparison lists only the current top customers, with their previous revenue", async () => {
    const { tp } = fakePrisma({
      "visit.aggregate": period(agg(150, 2), agg(60, 1)),
      "visit.groupBy": period([g({ propertyId: "p1" }, 100, 1), g({ propertyId: "p2" }, 50, 1)], [g({ propertyId: "p1" }, 60, 1), g({ propertyId: "p9" }, 5, 1)]),
      "property.findMany": [
        { id: "p1", customerId: "c1", customer: { name: "Mrs Smith" } },
        { id: "p2", customerId: "c2", customer: { name: "Mr Jones" } },
        { id: "p9", customerId: "c9", customer: { name: "Gone Ltd" } },
      ],
    });
    const out = await revenueSummary.run({ groupBy: "CUSTOMER", compare: true }, ctxFor(tp));
    expect(out.rows).toEqual([
      { group: "Mrs Smith", revenue: 100, previousRevenue: 60, change: 40, changePercent: 66.67, jobs: 1 },
      { group: "Mr Jones", revenue: 50, previousRevenue: 0, change: 50, changePercent: null, jobs: 1 },
    ]);
  });

  it("rejects a bad comparison range and flags a capped customer scan on the comparison side", async () => {
    const { tp } = fakePrisma();
    await expect(revenueSummary.run({ groupBy: "ROUND", compareFrom: "2025-01-01", compareTo: "2026-06-01" }, ctxFor(tp))).rejects.toThrow(/366 days/);
    const many = Array.from({ length: 2001 }, (_, i) => g({ propertyId: `p${i}` }, 1, 1));
    const prevBig = fakePrisma({ "visit.aggregate": agg(1, 1), "visit.groupBy": period([g({ propertyId: "p1" }, 1, 1)], many) });
    expect((await revenueSummary.run({ groupBy: "CUSTOMER", compareFrom: "2026-10-01", compareTo: "2026-10-31" }, ctxFor(prevBig.tp))).truncated).toBe(true);
  });

  it("returns null totals when there is no revenue, with or without a comparison", async () => {
    const { tp } = fakePrisma();
    expect(await revenueSummary.run({ groupBy: "ROUND" }, ctxFor(tp))).toMatchObject({ rows: [], totals: null });
    expect(await revenueSummary.run({ groupBy: "ROUND", compareFrom: "2026-10-01", compareTo: "2026-10-31" }, ctxFor(tp))).toMatchObject({ rows: [], totals: null });
  });

  it("gives null shares (never NaN) when the period total is zero", async () => {
    const { tp } = fakePrisma({ "visit.aggregate": agg(0, 1), "visit.groupBy": [g({ roundId: null }, 0, 1)] });
    const out = await revenueSummary.run({ groupBy: "ROUND" }, ctxFor(tp));
    expect(out.rows).toEqual([{ group: "No round", revenue: 0, jobs: 1, share: null }]);
  });

  it("describes when not to use it, an example, the new groupings and the field glossary", () => {
    expect(revenueSummary.description).toMatch(/Do NOT use/);
    expect(revenueSummary.description).toMatch(/Example: \{/);
    expect(revenueSummary.description).toMatch(/Fields:/);
    for (const gb of ["DAY", "WEEK", "SERVICE", "CUSTOMER", "PAYMENT_METHOD"]) expect(revenueSummary.description).toContain(gb);
  });

  it("groups by service when no visit has a service (no name lookup needed)", async () => {
    const { tp, calls } = fakePrisma({ "visit.aggregate": agg(10, 1), "visit.groupBy": [g({ serviceId: null }, 10, 1)] });
    const out = await revenueSummary.run({ groupBy: "SERVICE" }, ctxFor(tp));
    expect(out.rows).toEqual([{ group: "No service", revenue: 10, jobs: 1, share: 100 }]);
    expect(calls.some((c) => c.path === "service.findMany")).toBe(false);
  });

  it("treats a null price sum as zero and skips the technician name lookup when none is assigned", async () => {
    const { tp, calls } = fakePrisma({
      "visit.aggregate": agg(0, 1),
      "visit.groupBy": [{ technicianId: null, _sum: { price: null }, _count: 1 }],
    });
    const out = await revenueSummary.run({ groupBy: "TECHNICIAN" }, ctxFor(tp));
    expect(out.rows).toEqual([{ group: "Unassigned", revenue: 0, jobs: 1, share: null }]);
    expect(calls.some((c) => c.path === "technician.findMany")).toBe(false);
  });

  it("breaks a revenue tie between differently named groups alphabetically", async () => {
    const { tp } = fakePrisma({
      "visit.aggregate": agg(20, 2),
      "visit.groupBy": [g({ technicianId: "t1" }, 10, 1), g({ technicianId: "t2" }, 10, 1)],
      "technician.findMany": [{ id: "t1", name: "Zed" }, { id: "t2", name: "Abe" }],
    });
    const out = await revenueSummary.run({ groupBy: "TECHNICIAN" }, ctxFor(tp));
    expect(out.rows.map((r) => r.group)).toEqual(["Abe", "Zed"]);
  });
});
