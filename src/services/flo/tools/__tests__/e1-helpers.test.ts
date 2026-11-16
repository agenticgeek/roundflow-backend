import { describe, expect, it } from "vitest";
import { countOf, optBool, previousMonthPeriod } from "../e1-helpers";

describe("e1 helpers", () => {
  it("countOf reads a number, an { _all } object or nothing", () => {
    expect(countOf(4)).toBe(4);
    expect(countOf({ _all: 7 })).toBe(7);
    expect(countOf(undefined)).toBe(0);
    expect(countOf(null)).toBe(0);
  });

  it("previousMonthPeriod gives the same part of the previous month, clamped, across a year boundary", () => {
    expect(previousMonthPeriod("2026-11-17")).toEqual({ from: "2026-10-01", to: "2026-10-17" });
    expect(previousMonthPeriod("2026-03-31")).toEqual({ from: "2026-02-01", to: "2026-02-28" });
    expect(previousMonthPeriod("2028-03-30")).toEqual({ from: "2028-02-01", to: "2028-02-29" });
    expect(previousMonthPeriod("2027-01-05")).toEqual({ from: "2026-12-01", to: "2026-12-05" });
  });

  it("optBool accepts booleans and rejects anything else", () => {
    expect(optBool({}, "x")).toBeUndefined();
    expect(optBool({ x: null }, "x")).toBeUndefined();
    expect(optBool({ x: false }, "x")).toBe(false);
    expect(() => optBool({ x: "yes" }, "x")).toThrow(/true or false/);
  });
});
