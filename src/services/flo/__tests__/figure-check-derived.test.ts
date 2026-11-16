import { describe, expect, it } from "vitest";
import { createFigureChecker } from "../figure-check";
import type { ToolResult } from "../types";

function result(rows: ToolResult["rows"]): ToolResult {
  return { sourceId: "r1", tool: "t", label: "T", dateRange: null, rows, totals: null, truncated: false, columns: [] };
}

const two = (a: number, b: number) => createFigureChecker([result([{ a, b }])]);

describe("figure check: derived values over pairs of known values", () => {
  it("accepts a percent change, percent-of, ratio, sum, difference and absolute difference", () => {
    expect(two(112.5, 100)("Revenue is 12.5% up on last month.").ok).toBe(true); // (a-b)/b*100
    expect(two(30, 120)("That is 25% of the total.").ok).toBe(true); // a/b*100
    expect(two(150, 100)("A ratio of 1.5 to one.").ok).toBe(true); // a/b
    expect(two(40, 35)("Together that is 75.").ok).toBe(true); // sum
    expect(two(40, 35)("A gap of 5 jobs.").ok).toBe(true); // difference
    expect(two(35, 40)("A gap of 5 jobs.").ok).toBe(true); // absolute difference
    expect(two(100, 112.5)("Down 11.1% on last month.").ok).toBe(true); // |a-b|/b*100
  });

  it("rounds to the displayed precision", () => {
    expect(two(1, 3)("A third is 33%.").ok).toBe(true);
    expect(two(1, 3)("A third is 33.3%.").ok).toBe(true);
    expect(two(1, 3)("A third is 33.4%.").ok).toBe(false);
  });

  it("rejects an invented figure and lists it", () => {
    const c = two(112.5, 100);
    expect(c("Revenue is 15% up.")).toEqual({ ok: false, unmatched: [15] });
  });

  it("skips a zero divisor without throwing", () => {
    expect(two(0, 5)("That is 7 in all.").ok).toBe(false);
    expect(two(5, 0)("That is 5 in all.").ok).toBe(true);
    expect(two(0, 0)("That is 3 in all.").ok).toBe(false);
  });

  it("keeps the whitelist and direct matching unchanged", () => {
    const c = two(112.5, 100);
    expect(c("On 2026-10-01 at 09:30 in 2026, the 3rd one, top 5.").ok).toBe(true);
    expect(c("£112.50 and 100").ok).toBe(true);
  });

  it("searches at most 400 values, stays fast and is deterministic", () => {
    const row: Record<string, number> = {};
    for (let i = 0; i < 450; i++) row[`k${i}`] = 1000 + i * 7;
    const c = createFigureChecker([result([row])]);
    const start = Date.now();
    for (let i = 0; i < 20; i++) c("An invented 9999.37 figure.");
    expect(Date.now() - start).toBeLessThan(3000);
    expect(c("An invented 9999.37 figure.").ok).toBe(false);
    expect(c("That makes 2007.").ok).toBe(true); // 1000 + 1007, both inside the cap
    expect(c("A gap of 3143.").ok).toBe(false); // only 4143 - 1000 gives it, and 4143 is the 450th value (beyond the cap)
    expect(c("The top value is 4143.").ok).toBe(true); // direct matches are never capped
  });
});
