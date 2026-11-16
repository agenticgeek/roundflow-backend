import { describe, expect, it } from "vitest";
import { closuresAndWeather } from "../closures-and-weather";
import { ctxFor, fakePrisma } from "./fake-prisma";
import { expectSafe, SECRETS } from "./e2-test-utils";

const d = (day: string) => new Date(`${day}T00:00:00Z`);
const closure = (label: string, start: string, end: string, mode: string, roundIds: string[], appliedAt: Date | null) => ({
  label, startDate: d(start), endDate: d(end), mode, roundIds, appliedAt, ...SECRETS,
});

// today = 2026-11-10
const CLOSURES = [
  closure("Autumn break", "2026-11-05", "2026-11-12", "MOVE", ["r1", "r2"], new Date("2026-11-01T00:00:00Z")),
  closure("Christmas", "2026-12-24", "2027-01-02", "SKIP", [], null),
  closure("Old closure", "2026-10-20", "2026-10-22", "SKIP", ["r1"], null),
];
const HOLDS = [
  { entityId: "r1", createdAt: new Date("2026-11-08T08:00:00Z"), details: { date: "2026-11-09", condition: "heavy-rain", rescheduling: "next-available", visitIds: ["v1", "v2", "v3"], notifyCustomers: true }, ...SECRETS },
  { entityId: "gone", createdAt: new Date("2026-11-03T08:00:00Z"), details: { condition: "volcano", visitIds: "oops" } },
  { entityId: null, createdAt: new Date("2026-11-02T08:00:00Z"), details: null },
  { entityId: "r1", createdAt: new Date("2026-11-01T08:00:00Z"), details: ["not", "an", "object"] },
];

const world = () =>
  fakePrisma({
    "businessClosure.findMany": CLOSURES,
    "businessClosure.count": 3,
    "activityLog.findMany": HOLDS,
    "activityLog.count": 4,
    "round.count": 5,
    "round.findMany": [{ id: "r1", name: "Round 1" }],
  });

describe("closures_and_weather", () => {
  it("validates input", () => {
    expect(closuresAndWeather.parse({})).toEqual({ from: undefined, to: undefined, limit: 50 });
    expect(closuresAndWeather.parse({ from: "2026-12-01", to: "2026-12-31", limit: 5 })).toMatchObject({ from: "2026-12-01", limit: 5 });
    expect(() => closuresAndWeather.parse({ from: "12/01" })).toThrow(/YYYY-MM-DD/);
    expect(() => closuresAndWeather.parse({ limit: 0 })).toThrow(/1 to 200/);
    expect(() => closuresAndWeather.parse({ mode: "SKIP" })).toThrow(/Unknown argument/);
    expect(closuresAndWeather.name).toBe("closures_and_weather");
    expect(closuresAndWeather.readOnly).toBe(true);
  });

  it("lists closures with status, action, rounds affected and applied, and weather holds from the activity log details", async () => {
    const fp = world();
    const out = await closuresAndWeather.run({ limit: 50 }, ctxFor(fp.tp));
    expect(out.dateRange).toEqual({ from: "2026-10-11", to: "2027-02-08", label: "11 Oct 2026 to 8 Feb 2027" });
    const none = { visits: null, condition: null };
    expect(out.rows).toEqual([
      { kind: "Closure", label: "Autumn break", status: "Active", startDate: "2026-11-05", endDate: "2026-11-12", action: "MOVE", rounds: 2, ...none, applied: "Yes" },
      { kind: "Closure", label: "Christmas", status: "Upcoming", startDate: "2026-12-24", endDate: "2027-01-02", action: "SKIP", rounds: 5, ...none, applied: "No" },
      { kind: "Closure", label: "Old closure", status: "Past", startDate: "2026-10-20", endDate: "2026-10-22", action: "SKIP", rounds: 1, ...none, applied: "No" },
      { kind: "Weather hold", label: "Round 1", status: "Applied", startDate: "2026-11-09", endDate: "2026-11-09", action: "next-available", rounds: 1, visits: 3, condition: "Heavy rain", applied: "Yes" },
      { kind: "Weather hold", label: "Unknown round", status: "Applied", startDate: "2026-11-03", endDate: "2026-11-03", action: null, rounds: 1, visits: 0, condition: null, applied: "Yes" },
      { kind: "Weather hold", label: "Unknown round", status: "Applied", startDate: "2026-11-02", endDate: "2026-11-02", action: null, rounds: 1, visits: 0, condition: null, applied: "Yes" },
      { kind: "Weather hold", label: "Round 1", status: "Applied", startDate: "2026-11-01", endDate: "2026-11-01", action: null, rounds: 1, visits: 0, condition: null, applied: "Yes" },
    ]);
    expect(out.totals).toMatchObject({ kind: "Total", visits: 3, closures: 3, weatherHolds: 4 });
    expect(out.truncated).toBe(false);
    expect(out.columns.map((c) => c.key)).toEqual(["kind", "label", "status", "startDate", "endDate", "action", "rounds", "visits", "condition", "applied"]);
    expectSafe(out, fp);
    const sel = (fp.calls.find((c) => c.path === "activityLog.findMany")!.args as { select: Record<string, unknown>; where: { type: string } });
    expect(Object.keys(sel.select).sort()).toEqual(["createdAt", "details", "entityId"]);
    expect(sel.where.type).toBe("WEATHER_HOLD");
  });

  it("honours an explicit range and flags truncation when more rows exist than shown", async () => {
    const fp = fakePrisma({ "businessClosure.findMany": CLOSURES.slice(0, 1), "businessClosure.count": 3, "activityLog.count": 0 });
    const out = await closuresAndWeather.run({ from: "2026-11-01", to: "2026-11-30", limit: 1 }, ctxFor(fp.tp));
    expect(out.dateRange).toMatchObject({ from: "2026-11-01", to: "2026-11-30" });
    expect(out.truncated).toBe(true);
    expect(fp.calls.some((c) => c.path === "round.findMany")).toBe(false);
    const where = (fp.calls.find((c) => c.path === "businessClosure.findMany")!.args as { where: { startDate: { lte: Date }; endDate: { gte: Date } } }).where;
    expect(where.startDate.lte.toISOString()).toBe("2026-11-30T00:00:00.000Z");
    expect(where.endDate.gte.toISOString()).toBe("2026-11-01T00:00:00.000Z");
  });

  it("truncates when only the weather holds are cut", async () => {
    const fp = fakePrisma({ "activityLog.findMany": HOLDS.slice(0, 1), "activityLog.count": 9, "round.findMany": [{ id: "r1", name: "Round 1" }] });
    expect((await closuresAndWeather.run({ limit: 1 }, ctxFor(fp.tp))).truncated).toBe(true);
  });

  it("returns empty rows and null totals when nothing exists; rejects a bad range", async () => {
    const fp = fakePrisma();
    expect(await closuresAndWeather.run({ limit: 50 }, ctxFor(fp.tp))).toMatchObject({ rows: [], totals: null, truncated: false });
    await expect(closuresAndWeather.run({ from: "2026-11-10", to: "2026-11-01", limit: 50 }, ctxFor(fp.tp))).rejects.toThrow(/must not be after/);
    await expect(closuresAndWeather.run({ from: "2024-01-01", limit: 50 }, ctxFor(fp.tp))).rejects.toThrow(/366 days/);
  });

  it("uses the tenant-local day for 'today' and for the hold timestamp range (Auckland)", async () => {
    const fp = fakePrisma({ "businessClosure.findMany": [closure("Open day", "2026-11-11", "2026-11-11", "MOVE", ["r1"], null)], "businessClosure.count": 1 }, { timezone: "Pacific/Auckland" });
    const out = await closuresAndWeather.run({ from: "2026-11-10", to: "2026-11-12", limit: 50 }, ctxFor(fp.tp, "2026-11-10T21:30:00.000Z"));
    expect(out.rows[0]).toMatchObject({ label: "Open day", status: "Active" });
    const where = (fp.calls.find((c) => c.path === "activityLog.findMany")!.args as { where: { createdAt: { gte: Date } } }).where.createdAt;
    expect(where.gte.toISOString()).toBe("2026-11-09T11:00:00.000Z");
  });
});
