import { describe, it, expect } from "vitest";
import {
  DEFAULT_WORKING_DAYS,
  workingDayIndexes,
  isWorkingDay,
  nextWorkingDay,
  snapToWorkingDay,
  carryoverOptions,
  resolveCarryoverTarget,
  toCalendarDay,
} from "../working-days";

const d = (s: string) => new Date(`${s}T00:00:00.000Z`);
const iso = (x: Date) => x.toISOString().slice(0, 10);
// 2026-11-06 is a Friday.
const FRI = "2026-11-06";

describe("workingDayIndexes", () => {
  it("defaults to Mon-Fri when empty, null or invalid", () => {
    const def = [1, 2, 3, 4, 5];
    expect([...workingDayIndexes([])]).toEqual(def);
    expect([...workingDayIndexes(null)]).toEqual(def);
    expect([...workingDayIndexes(undefined)]).toEqual(def);
    expect([...workingDayIndexes(["xyz"])]).toEqual(def);
    expect(DEFAULT_WORKING_DAYS).toEqual(["MON", "TUE", "WED", "THU", "FRI"]);
  });
  it("reads stored MON..SUN codes", () => {
    expect([...workingDayIndexes(["SAT", "MON", "bogus"])].sort()).toEqual([1, 6]);
  });
});

describe("toCalendarDay", () => {
  it("keeps date strings and UTC-midnight dates as-is", () => {
    expect(iso(toCalendarDay("2026-11-06"))).toBe(FRI);
    expect(iso(toCalendarDay(d(FRI), "America/New_York"))).toBe(FRI);
  });
  it("resolves a real instant to the tenant-local calendar day", () => {
    // 23:30Z on Fri 3 Jul 2026 is already Saturday 00:30 in London (BST).
    expect(iso(toCalendarDay(new Date("2026-07-03T23:30:00Z"), "Europe/London"))).toBe("2026-07-04");
    expect(iso(toCalendarDay(new Date("2026-07-03T23:30:00Z"), "UTC"))).toBe("2026-07-03");
    // default zone is Europe/London
    expect(iso(toCalendarDay(new Date("2026-07-03T23:30:00Z")))).toBe("2026-07-04");
  });
});

describe("isWorkingDay / nextWorkingDay / snapToWorkingDay", () => {
  it("honours the default Mon-Fri", () => {
    expect(isWorkingDay(d("2026-11-07"))).toBe(false);
    expect(isWorkingDay(d("2026-11-09"))).toBe(true);
    expect(iso(nextWorkingDay(d(FRI)))).toBe("2026-11-09");
    expect(iso(nextWorkingDay(d("2026-11-07")))).toBe("2026-11-09");
    expect(iso(nextWorkingDay(d("2026-11-08")))).toBe("2026-11-09");
    expect(iso(nextWorkingDay(d("2026-11-03")))).toBe("2026-11-04");
  });
  it("honours a custom week (Tue-Sat)", () => {
    const workingDays = ["TUE", "WED", "THU", "FRI", "SAT"];
    expect(iso(nextWorkingDay(d(FRI), { workingDays }))).toBe("2026-11-07");
    expect(iso(nextWorkingDay(d("2026-11-07"), { workingDays }))).toBe("2026-11-10");
    expect(isWorkingDay(d("2026-11-09"), { workingDays })).toBe(false);
  });
  it("snaps forward onto a working day", () => {
    expect(iso(snapToWorkingDay(d("2026-11-07")))).toBe("2026-11-09");
    expect(iso(snapToWorkingDay(d("2026-11-08")))).toBe("2026-11-09");
    expect(iso(snapToWorkingDay(d("2026-11-04")))).toBe("2026-11-04");
    expect(iso(snapToWorkingDay(d("2026-11-07"), { workingDays: ["SAT"] }))).toBe("2026-11-07");
  });
  it("uses the tenant zone for instants (midnight edge)", () => {
    // Thu 23:30Z in July is Friday 00:30 in London: next working day is Monday.
    expect(iso(nextWorkingDay(new Date("2026-07-02T23:30:00Z"), { tz: "Europe/London" }))).toBe("2026-07-06");
    expect(iso(nextWorkingDay(new Date("2026-07-02T23:30:00Z"), { tz: "UTC" }))).toBe("2026-07-03");
  });
});

describe("carryoverOptions", () => {
  it("Mon-Thu offers only the next working day", () => {
    for (const [date, next] of [["2026-11-02", "2026-11-03"], ["2026-11-03", "2026-11-04"], ["2026-11-04", "2026-11-05"], ["2026-11-05", "2026-11-06"]]) {
      const opts = carryoverOptions(d(date));
      expect(opts).toHaveLength(1);
      expect(opts[0]).toMatchObject({ key: "NEXT_WORKING_DAY", date: next, default: true });
    }
  });
  it("Friday always offers Saturday and Monday (never Sunday), Monday default", () => {
    const opts = carryoverOptions(d(FRI));
    expect(opts.map((o) => [o.key, o.date, o.default])).toEqual([
      ["SATURDAY", "2026-11-07", false],
      ["MONDAY", "2026-11-09", true],
    ]);
    expect(opts[0].label).toBe("Saturday 7 Nov");
    expect(opts[1].label).toBe("Monday 9 Nov");
  });
  it("Friday ignores the working-days setting for what is offered, but it drives the default", () => {
    const sixDay = carryoverOptions(d(FRI), { workingDays: ["MON", "TUE", "WED", "THU", "FRI", "SAT"] });
    expect(sixDay.map((o) => o.key)).toEqual(["SATURDAY", "MONDAY"]);
    expect(sixDay.find((o) => o.default)!.key).toBe("MONDAY");
    const satOnly = carryoverOptions(d(FRI), { workingDays: ["TUE", "WED", "THU", "FRI", "SAT"] });
    expect(satOnly.map((o) => o.key)).toEqual(["SATURDAY", "MONDAY"]);
    expect(satOnly.find((o) => o.default)!.key).toBe("SATURDAY");
    const monFri = carryoverOptions(d(FRI), { workingDays: ["MON", "FRI"] });
    expect(monFri.find((o) => o.default)!.key).toBe("MONDAY");
  });
  it("a Friday in the tenant zone is detected from an instant (midnight in tz)", () => {
    const opts = carryoverOptions(new Date("2026-11-05T23:30:00Z"), { tz: "Asia/Tokyo" });
    expect(opts.map((o) => o.key)).toEqual(["SATURDAY", "MONDAY"]);
  });
  it("Saturday and Sunday offer the next working day", () => {
    expect(carryoverOptions(d("2026-11-07"))[0]).toMatchObject({ key: "NEXT_WORKING_DAY", date: "2026-11-09" });
    expect(carryoverOptions(d("2026-11-08"))[0]).toMatchObject({ key: "NEXT_WORKING_DAY", date: "2026-11-09" });
  });
});

describe("resolveCarryoverTarget", () => {
  it("returns the option date for a valid key and null otherwise", () => {
    expect(iso(resolveCarryoverTarget(d(FRI), "SATURDAY")!)).toBe("2026-11-07");
    expect(iso(resolveCarryoverTarget(d(FRI), "MONDAY")!)).toBe("2026-11-09");
    expect(resolveCarryoverTarget(d(FRI), "NEXT_WORKING_DAY")).toBeNull();
    expect(iso(resolveCarryoverTarget(d("2026-11-03"), "NEXT_WORKING_DAY")!)).toBe("2026-11-04");
  });
});
