import { describe, expect, it } from "vitest";
import { servicePlanHealth, VISITS_PER_YEAR } from "../service-plan-health";
import { ctxFor, dec, fakePrisma, WRITE_METHODS } from "./fake-prisma";

const d = (v: string) => new Date(`${v}T00:00:00Z`);
const plan = (id: string, price: number, freq: string | null, status: string, extra: Record<string, unknown> = {}) => ({
  id, price: dec(price), cleaningFrequency: freq, status, pauseEndDate: null, nextDueDate: null, updatedAt: d("2026-01-01"), service: { name: "Windows" }, ...extra,
});

const PLANS = [
  plan("a", 20, "FOUR_WEEKLY", "ACTIVE", { nextDueDate: d("2026-11-01") }), // overdue, no visit
  plan("b", 30, "FOUR_WEEKLY", "ACTIVE", { nextDueDate: d("2026-11-02") }), // overdue but has a visit
  plan("c", 40, "EIGHT_WEEKLY", "ACTIVE", { nextDueDate: d("2026-12-01"), service: { name: "Gutters" } }),
  plan("d", 10, "SIX_WEEKLY", "PAUSED", { pauseEndDate: d("2026-12-20") }),
  plan("e", 10, "SIX_WEEKLY", "PAUSED", { pauseEndDate: d("2026-12-05") }),
  plan("f", 10, null, "PAUSED"),
  plan("g", 25, "TWELVE_WEEKLY", "CANCELLED", { updatedAt: d("2026-11-05"), service: null }),
  plan("h", 25, null, "ACTIVE"),
];

describe("service_plan_health", () => {
  it("documents the visits-per-year constants and validates input", () => {
    expect(VISITS_PER_YEAR).toEqual({ FOUR_WEEKLY: 13, SIX_WEEKLY: 8.67, EIGHT_WEEKLY: 6.5, TWELVE_WEEKLY: 4.33 });
    expect(servicePlanHealth.parse({})).toEqual({ groupBy: "FREQUENCY", from: undefined, to: undefined, limit: 50 });
    expect(servicePlanHealth.parse({ groupBy: "SERVICE", from: "2026-10-01", to: "2026-10-31", limit: 3 })).toMatchObject({ groupBy: "SERVICE", limit: 3 });
    expect(() => servicePlanHealth.parse({ groupBy: "COLOUR" })).toThrow(/must be one of/);
    expect(servicePlanHealth.name).toBe("service_plan_health");
  });

  it("groups by frequency with annualised value, resume dates, overdue plans and cancellations", async () => {
    const { tp, calls } = fakePrisma({ "servicePlan.findMany": PLANS, "visit.findMany": [{ servicePlanId: "b" }, { servicePlanId: null }] });
    const out = await servicePlanHealth.run({ groupBy: "FREQUENCY", limit: 50 }, ctxFor(tp));
    expect(out.rows).toEqual([
      { group: "4-weekly", plans: 2, active: 2, paused: 0, cancelled: 0, annualisedValue: 650, averagePrice: 25, nextResumeDate: null, overduePlans: 1 },
      { group: "8-weekly", plans: 1, active: 1, paused: 0, cancelled: 0, annualisedValue: 260, averagePrice: 40, nextResumeDate: null, overduePlans: 0 },
      { group: "6-weekly", plans: 2, active: 0, paused: 2, cancelled: 0, annualisedValue: 0, averagePrice: null, nextResumeDate: "2026-12-05", overduePlans: 0 },
      { group: "Not set", plans: 2, active: 1, paused: 1, cancelled: 0, annualisedValue: 0, averagePrice: 25, nextResumeDate: null, overduePlans: 0 },
      { group: "12-weekly", plans: 1, active: 0, paused: 0, cancelled: 1, annualisedValue: 0, averagePrice: null, nextResumeDate: null, overduePlans: 0 },
    ]);
    expect(out.totals).toEqual({
      group: "Total", plans: 8, active: 4, paused: 3, cancelled: 1, annualisedValue: 910, averagePrice: 28.75, nextResumeDate: "2026-12-05", overduePlans: 1,
      cancellationsInPeriod: 1, pausedWithoutResumeDate: 1, monthlyRecurringValue: 75.83,
    });
    expect(out.dateRange).toMatchObject({ from: "2026-11-01", to: "2026-11-10" });
    expect(out.truncated).toBe(false);
    expect((calls.find((c) => c.path === "visit.findMany")!.args as { where: { servicePlanId: { in: string[] } } }).where.servicePlanId.in).toEqual(["a", "b"]);
  });

  it("groups by status and by service, honours the limit and the cancellation window", async () => {
    const { tp } = fakePrisma({ "servicePlan.findMany": PLANS });
    const st = await servicePlanHealth.run({ groupBy: "STATUS", limit: 50 }, ctxFor(tp));
    expect(st.rows.map((r) => r.group)).toEqual(["ACTIVE", "PAUSED", "CANCELLED"]);
    const sv = await servicePlanHealth.run({ groupBy: "SERVICE", from: "2026-10-01", to: "2026-10-31", limit: 1 }, ctxFor(tp));
    expect(sv.rows).toHaveLength(1);
    expect(sv.truncated).toBe(true);
    expect(sv.totals).toMatchObject({ cancellationsInPeriod: 0 });
    const all = await servicePlanHealth.run({ groupBy: "SERVICE", limit: 50 }, ctxFor(tp));
    expect(all.rows.map((r) => r.group).sort()).toEqual(["Gutters", "No service", "Windows"]);
  });

  it("groups an unrecognised frequency as Other", async () => {
    const { tp } = fakePrisma({ "servicePlan.findMany": [plan("x", 10, "WEEKLY", "ACTIVE")] });
    expect((await servicePlanHealth.run({ groupBy: "FREQUENCY", limit: 5 }, ctxFor(tp))).rows[0]).toMatchObject({ group: "Other", annualisedValue: 0 });
  });

  it("returns null totals for no plans and flags a capped scan", async () => {
    const empty = fakePrisma();
    expect(await servicePlanHealth.run({ groupBy: "FREQUENCY", limit: 5 }, ctxFor(empty.tp))).toMatchObject({ rows: [], totals: null, truncated: false });
    const many = Array.from({ length: 20_001 }, (_, i) => plan(`p${i}`, 1, "FOUR_WEEKLY", "ACTIVE"));
    const big = fakePrisma({ "servicePlan.findMany": many });
    expect((await servicePlanHealth.run({ groupBy: "FREQUENCY", limit: 5 }, ctxFor(big.tp))).truncated).toBe(true);
  });

  it("never writes and exposes no secret-looking keys", async () => {
    const { tp, calls } = fakePrisma({ "servicePlan.findMany": PLANS });
    const out = await servicePlanHealth.run({ groupBy: "FREQUENCY", limit: 50 }, ctxFor(tp));
    expect(calls.filter((c) => (WRITE_METHODS as readonly string[]).some((m) => c.path.endsWith(`.${m}`)))).toEqual([]);
    expect([...Object.keys(out.rows[0]), ...Object.keys(out.totals ?? {})].filter((k) => /bank|token|secret|password|webhook|mandate|stripe|note|body/i.test(k))).toEqual([]);
  });
});
