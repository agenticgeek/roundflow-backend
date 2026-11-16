import { describe, expect, it } from "vitest";
import { roundPerformance } from "../round-performance";
import { ctxFor, dec, fakePrisma } from "./fake-prisma";
import { expectSafe, SECRETS } from "./e2-test-utils";

const v = (status: string, price: number, over: Record<string, unknown> = {}) => ({
  status, price: dec(price), propertyId: "p1", arrivedAt: null, completedAt: null, roundId: "r1", round: { name: "Round 1" }, technician: { name: "Liam" }, ...SECRETS, ...over,
});
const at = (hhmm: string) => new Date(`2026-11-03T${hhmm}:00Z`);

const VISITS = [
  v("COMPLETED", 40, { arrivedAt: at("09:00"), completedAt: at("09:20") }),
  v("COMPLETED", 60, { propertyId: "p2", arrivedAt: at("10:00"), completedAt: at("10:40"), technician: { name: "Abe" } }),
  v("SKIPPED", 30, { propertyId: "p3" }),
  v("SCHEDULED", 20, { propertyId: "p4", technician: null }),
  v("COMPLETED", 15, { propertyId: "p5", roundId: "r2", round: { name: "Round 2" }, technician: null }), // no times
  v("COMPLETED", 5, { propertyId: "p6", roundId: "r2", round: { name: "Round 2" }, arrivedAt: at("11:00"), completedAt: at("10:00"), technician: null }), // impossible order
  v("COMPLETED", 10, { propertyId: "p7", roundId: null, round: null }),
];

describe("round_performance", () => {
  it("validates input", () => {
    expect(roundPerformance.parse({})).toEqual({ from: undefined, to: undefined, limit: 50 });
    expect(roundPerformance.parse({ from: "2026-10-01", limit: 5 })).toMatchObject({ from: "2026-10-01", limit: 5 });
    expect(() => roundPerformance.parse({ limit: 201 })).toThrow(/1 to 200/);
    expect(() => roundPerformance.parse({ to: "bad" })).toThrow(/YYYY-MM-DD/);
    expect(() => roundPerformance.parse({ round: "x" })).toThrow(/Unknown argument/);
    expect(() => roundPerformance.parse([])).toThrow(/object/);
    expect(roundPerformance.name).toBe("round_performance");
    expect(roundPerformance.readOnly).toBe(true);
  });

  it("computes per-round value, rates, revenue per stop and on-site minutes, sorted by revenue, with totals", async () => {
    const fp = fakePrisma({ "visit.findMany": VISITS });
    const out = await roundPerformance.run({ limit: 50 }, ctxFor(fp.tp));
    expect(out.dateRange).toEqual({ from: "2026-11-01", to: "2026-11-10", label: "1 to 10 Nov 2026" });
    expect(out.rows).toEqual([
      { round: "Round 1", properties: 4, stops: 4, completed: 2, skipped: 1, scheduledValue: 150, completedValue: 100, completionRate: 50, skipRate: 25, revenuePerStop: 50, avgMinutesOnSite: 30, technicians: "Abe, Liam" },
      { round: "Round 2", properties: 2, stops: 2, completed: 2, skipped: 0, scheduledValue: 20, completedValue: 20, completionRate: 100, skipRate: 0, revenuePerStop: 10, avgMinutesOnSite: null, technicians: null },
      { round: "No round", properties: 1, stops: 1, completed: 1, skipped: 0, scheduledValue: 10, completedValue: 10, completionRate: 100, skipRate: 0, revenuePerStop: 10, avgMinutesOnSite: null, technicians: "Liam" },
    ]);
    expect(out.totals).toMatchObject({ round: "Total", rounds: 3, properties: 7, stops: 7, completed: 5, skipped: 1, scheduledValue: 180, completedValue: 130, completionRate: 71.43, skipRate: 14.29, revenuePerStop: 26, avgMinutesOnSite: 30, technicians: null });
    expect(out.truncated).toBe(false);
    expect(out.columns.map((c) => c.key)).toEqual(["round", "properties", "stops", "completed", "skipped", "scheduledValue", "completedValue", "completionRate", "skipRate", "revenuePerStop", "avgMinutesOnSite", "technicians"]);
    expectSafe(out, fp);
    const where = (fp.calls[fp.calls.length - 1].args as { where: { status: { in: string[] } } }).where;
    expect(where.status.in).not.toContain("CANCELLED");
  });

  it("breaks equal revenue ties by name and honours limit with truncated", async () => {
    const fp = fakePrisma({ "visit.findMany": [v("SCHEDULED", 1, { roundId: "b", round: { name: "B" } }), v("SCHEDULED", 1, { roundId: "a", round: { name: "A" } })] });
    const out = await roundPerformance.run({ limit: 1 }, ctxFor(fp.tp));
    expect(out.rows.map((r) => r.round)).toEqual(["A"]);
    expect(out.truncated).toBe(true);
    expect(out.rows[0]).toMatchObject({ completionRate: 0, revenuePerStop: null });
  });

  it("returns empty rows and null totals when there are no visits", async () => {
    const fp = fakePrisma();
    expect(await roundPerformance.run({ limit: 50 }, ctxFor(fp.tp))).toMatchObject({ rows: [], totals: null, truncated: false });
  });

  it("flags a capped scan and rejects a bad range", async () => {
    const many = Array.from({ length: 20_001 }, () => v("COMPLETED", 1));
    const fp = fakePrisma({ "visit.findMany": many });
    expect((await roundPerformance.run({ limit: 50 }, ctxFor(fp.tp))).truncated).toBe(true);
    await expect(roundPerformance.run({ from: "2026-11-10", to: "2026-11-01", limit: 50 }, ctxFor(fp.tp))).rejects.toThrow(/must not be after/);
    await expect(roundPerformance.run({ from: "2025-01-01", to: "2026-11-01", limit: 50 }, ctxFor(fp.tp))).rejects.toThrow(/366 days/);
  });

  it("uses the tenant-local day for the default range (Auckland is already on 11 Nov at 21:30Z on 10 Nov)", async () => {
    const fp = fakePrisma({}, { timezone: "Pacific/Auckland" });
    const out = await roundPerformance.run({ limit: 50 }, ctxFor(fp.tp, "2026-11-10T21:30:00.000Z"));
    expect(out.dateRange).toMatchObject({ from: "2026-11-01", to: "2026-11-11" });
    const q = (fp.calls.find((c) => c.path === "visit.findMany")!.args as { where: { date: { gte: Date; lt: Date } } }).where.date;
    expect(q.lt.toISOString()).toBe("2026-11-12T00:00:00.000Z");
  });
});
