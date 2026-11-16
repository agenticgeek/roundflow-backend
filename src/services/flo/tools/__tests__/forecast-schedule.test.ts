import { describe, expect, it } from "vitest";
import { forecastSchedule } from "../forecast-schedule";
import { ctxFor, dec, fakePrisma } from "./fake-prisma";
import { expectSafe, SECRETS } from "./e2-test-utils";

const d = (day: string) => new Date(`${day}T00:00:00Z`);
const vis = (day: string, price: number, roundId: string | null, round: string | null) => ({ date: d(day), price: dec(price), roundId, round: round ? { name: round } : null, ...SECRETS });

// today = 2026-11-10: week 0 = 10-16 Nov, week 1 = 17-23, week 2 = 24-30, week 3 = 1-7 Dec.
const VISITS = [
  vis("2026-11-10", 25, "r1", "Round 1"), vis("2026-11-12", 15, "r1", "Round 1"), vis("2026-11-11", 2, null, null), vis("2026-11-11", 3, "r2", "Round 2"),
  vis("2026-11-20", 10, null, null), vis("2026-11-25", 1, null, null), vis("2026-12-03", 5, "r2", "Round 2"),
];
const ROUNDS = [{ id: "r1", name: "Round 1", defaultDay: null, frequency: "FOUR_WEEKLY" }, { id: "r2", name: "Round 2", defaultDay: null, frequency: null }];
const PLANS = [{ id: "pl1", price: dec(20), cleaningFrequency: "FOUR_WEEKLY", status: "ACTIVE", nextDueDate: d("2026-11-18"), pauseEndDate: null, property: { roundId: "r1" } }];
const CLOSURES = [
  { id: "c1", label: "Bank holiday", startDate: d("2026-11-24"), endDate: d("2026-11-25"), mode: "SKIP", roundIds: [] },
  { id: "c2", label: "Round 2 break", startDate: d("2026-11-10"), endDate: d("2026-11-11"), mode: "SKIP", roundIds: ["r2"] },
];

const world = () => fakePrisma({ "visit.findMany": VISITS, "round.findMany": ROUNDS, "servicePlan.findMany": PLANS, "businessClosure.findMany": CLOSURES });

describe("forecast_schedule", () => {
  it("validates input", () => {
    expect(forecastSchedule.parse({})).toEqual({ weeks: 4, limit: 50 });
    expect(forecastSchedule.parse({ weeks: 12, limit: 9 })).toEqual({ weeks: 12, limit: 9 });
    expect(() => forecastSchedule.parse({ weeks: 13 })).toThrow(/1 to 12/);
    expect(() => forecastSchedule.parse({ weeks: 0 })).toThrow(/1 to 12/);
    expect(() => forecastSchedule.parse({ weeks: 2.5 })).toThrow(/whole number/);
    expect(() => forecastSchedule.parse({ limit: 201 })).toThrow(/1 to 200/);
    expect(() => forecastSchedule.parse({ days: 3 })).toThrow(/Unknown argument/);
    expect(forecastSchedule.name).toBe("forecast_schedule");
    expect(forecastSchedule.readOnly).toBe(true);
  });

  it("totals scheduled and projected stops and value per week and per round, and flags closure weeks", async () => {
    const fp = world();
    const out = await forecastSchedule.run({ weeks: 4, limit: 50 }, ctxFor(fp.tp));
    expect(out.dateRange).toEqual({ from: "2026-11-10", to: "2026-12-07", label: "10 Nov to 7 Dec 2026" });
    const w = (weekStart: string, weekEnd: string) => ({ weekStart, weekEnd });
    expect(out.rows).toEqual([
      { ...w("2026-11-10", "2026-11-16"), round: "All rounds", scheduledStops: 4, projectedStops: 0, stops: 4, value: 45, closure: "Round 2 break" },
      { ...w("2026-11-10", "2026-11-16"), round: "Round 1", scheduledStops: 2, projectedStops: 0, stops: 2, value: 40, closure: null },
      { ...w("2026-11-10", "2026-11-16"), round: "Round 2", scheduledStops: 1, projectedStops: 0, stops: 1, value: 3, closure: "Round 2 break" },
      { ...w("2026-11-10", "2026-11-16"), round: "No round", scheduledStops: 1, projectedStops: 0, stops: 1, value: 2, closure: null },
      { ...w("2026-11-17", "2026-11-23"), round: "All rounds", scheduledStops: 1, projectedStops: 1, stops: 2, value: 30, closure: null },
      { ...w("2026-11-17", "2026-11-23"), round: "Round 1", scheduledStops: 0, projectedStops: 1, stops: 1, value: 20, closure: null },
      { ...w("2026-11-17", "2026-11-23"), round: "No round", scheduledStops: 1, projectedStops: 0, stops: 1, value: 10, closure: null },
      { ...w("2026-11-24", "2026-11-30"), round: "All rounds", scheduledStops: 1, projectedStops: 0, stops: 1, value: 1, closure: "Bank holiday" },
      { ...w("2026-11-24", "2026-11-30"), round: "No round", scheduledStops: 1, projectedStops: 0, stops: 1, value: 1, closure: "Bank holiday" },
      { ...w("2026-12-01", "2026-12-07"), round: "All rounds", scheduledStops: 1, projectedStops: 0, stops: 1, value: 5, closure: null },
      { ...w("2026-12-01", "2026-12-07"), round: "Round 2", scheduledStops: 1, projectedStops: 0, stops: 1, value: 5, closure: null },
    ]);
    expect(out.totals).toEqual({ weekStart: null, weekEnd: null, round: "Total", scheduledStops: 7, projectedStops: 1, stops: 8, value: 81, closure: null });
    expect(out.truncated).toBe(false);
    expect(out.columns.map((c) => c.key)).toEqual(["weekStart", "weekEnd", "round", "scheduledStops", "projectedStops", "stops", "value", "closure"]);
    expectSafe(out, fp);
    const visitWhere = (fp.calls.find((c) => c.path === "visit.findMany")!.args as { where: { status: { in: string[] } } }).where;
    expect(visitWhere.status.in).toEqual(["SCHEDULED", "IN_PROGRESS"]);
  });

  it("honours limit and flags truncation", async () => {
    const out = await forecastSchedule.run({ weeks: 4, limit: 3 }, ctxFor(world().tp));
    expect(out.rows).toHaveLength(3);
    expect(out.truncated).toBe(true);
  });

  it("orders rounds of equal value by name", async () => {
    const fp = fakePrisma({ "visit.findMany": [vis("2026-11-10", 5, "b", "Beta"), vis("2026-11-10", 5, "a", "Alpha")] });
    const out = await forecastSchedule.run({ weeks: 1, limit: 50 }, ctxFor(fp.tp));
    expect(out.rows.map((r) => r.round)).toEqual(["All rounds", "Alpha", "Beta"]);
  });

  it("with nothing scheduled still returns one zero row per week", async () => {
    const out = await forecastSchedule.run({ weeks: 2, limit: 50 }, ctxFor(fakePrisma().tp));
    expect(out.rows.map((r) => [r.weekStart, r.round, r.stops, r.value])).toEqual([["2026-11-10", "All rounds", 0, 0], ["2026-11-17", "All rounds", 0, 0]]);
    expect(out.totals).toMatchObject({ stops: 0, value: 0 });
  });

  it("flags a capped scan", async () => {
    const many = Array.from({ length: 20_001 }, () => vis("2026-11-10", 1, "r1", "Round 1"));
    const fp = fakePrisma({ "visit.findMany": many });
    const out = await forecastSchedule.run({ weeks: 1, limit: 50 }, ctxFor(fp.tp));
    expect(out.truncated).toBe(true);
    expect(out.totals).toMatchObject({ scheduledStops: 20_000 });
  });

  it("starts the window on the tenant-local day (Auckland)", async () => {
    const fp = fakePrisma({}, { timezone: "Pacific/Auckland" });
    const out = await forecastSchedule.run({ weeks: 1, limit: 50 }, ctxFor(fp.tp, "2026-11-10T21:30:00.000Z"));
    expect(out.dateRange).toMatchObject({ from: "2026-11-11", to: "2026-11-17" });
  });
});
