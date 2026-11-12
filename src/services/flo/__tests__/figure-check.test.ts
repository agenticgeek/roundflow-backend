import { describe, expect, it } from "vitest";
import { createFigureChecker, extractFigures } from "../figure-check";
import type { ToolResult } from "../types";

function result(over: Partial<ToolResult> = {}): ToolResult {
  return {
    sourceId: "r1",
    tool: "compare_technicians",
    label: "Technicians",
    dateRange: null,
    rows: [
      { technician: "Liam Walsh", revenue: 8190.5, completed: 781, skips: 14, round: "Round 7", ok: true, note: null },
      { technician: "James Carter", revenue: 5460, completed: 400, skips: -3, round: "North", ok: false, note: "n/a" },
    ],
    totals: { revenue: 13650.5, rate: 96.4 },
    truncated: false,
    columns: [],
    ...over,
  };
}

const check = createFigureChecker([result()]);

describe("extractFigures", () => {
  it("reads currency, percent, thousands separators and decimals", () => {
    expect(extractFigures("£8,190.50 is 96.4% of 1,234 across 3 rounds")).toEqual([
      { value: 8190.5, decimals: 2 },
      { value: 96.4, decimals: 1 },
      { value: 1234, decimals: 0 },
      { value: 3, decimals: 0 },
    ]);
    expect(extractFigures("no numbers here")).toEqual([]);
  });

  it("whitelists dates, years, times, ordinals and ranks", () => {
    const text =
      "On 2026-10-30, 30 October 2026, 1 Oct, Oct 3rd, 12/11/2026, at 09:30 or 9am or 5 pm, the 1st, 22nd and 3rd, #2 and top 5 in 2026.";
    expect(extractFigures(text)).toEqual([]);
  });

  it("does not whitelist a year-looking amount with a currency sign or comma", () => {
    expect(extractFigures("£2026 and 2,026 and 2026.5")).toEqual([
      { value: 2026, decimals: 0 },
      { value: 2026, decimals: 0 },
      { value: 2026.5, decimals: 1 },
    ]);
  });
});

describe("createFigureChecker", () => {
  it("passes sentences with no figures and sentences whose figures are in the data", () => {
    expect(check("Liam Walsh had the most skips.")).toEqual({ ok: true, unmatched: [] });
    expect(check("Liam Walsh had the most skips (14).").ok).toBe(true);
    expect(check("Total revenue was £13,650.50 and completion 96.4%.").ok).toBe(true);
    expect(check("Revenue 13650.5 is shown").ok).toBe(true);
  });

  it("compares at the precision shown in the sentence (rounding tolerance)", () => {
    expect(check("About £8,191 from Liam.").ok).toBe(true); // 8190.5 shown to 0 dp is 8191
    expect(check("About £8,190 from Liam.").ok).toBe(false);
    expect(check("Completion 96% overall").ok).toBe(true); // 96.4 -> 96
  });

  it("matches negative values by magnitude, numbers inside text cells and the row count", () => {
    expect(check("There were 3 skips").ok).toBe(true); // -3
    expect(check("Round 7 stands out").ok).toBe(true); // number inside a text cell
    expect(check("You have 2 technicians").ok).toBe(true); // rows.length
  });

  it("ignores booleans, nulls and NaN cells, and a result without totals", () => {
    const c = createFigureChecker([result({ totals: null, rows: [{ a: true, b: null, c: Number.NaN, d: "x" }] })]);
    expect(c("There is 1 thing").ok).toBe(true); // row count 1
    expect(c("There are 9 things").ok).toBe(false);
  });

  it("flags a figure that is not in any stored result and lists it", () => {
    expect(check("Revenue is up 12% on September.")).toEqual({ ok: false, unmatched: [12] });
    expect(check("Revenue 13650.51").ok).toBe(false);
    expect(check("14 skips and 99 jobs").unmatched).toEqual([99]);
  });

  it("uses figures from every stored result and nothing from an empty store", () => {
    const other = result({ sourceId: "r2", rows: [{ n: 55 }], totals: null });
    expect(createFigureChecker([result(), other])("55 matched").ok).toBe(true);
    expect(createFigureChecker([])("55 matched").ok).toBe(false);
    expect(createFigureChecker([])("nothing numeric").ok).toBe(true);
  });
});
