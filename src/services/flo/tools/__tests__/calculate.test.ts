import { describe, expect, it } from "vitest";
import { calculate } from "../calculate";
import type { ToolResult } from "../../types";
import { ctxFor, fakePrisma } from "./fake-prisma";

const col = (key: string, format: "text" | "integer" | "currency" | "percent" | "date") => ({ key, label: key, format, align: "right" as const });

const R1: ToolResult = {
  sourceId: "r1", tool: "revenue_summary", label: "Revenue", dateRange: null, truncated: false,
  columns: [col("group", "text"), col("revenue", "currency"), col("jobs", "integer"), col("share", "percent")],
  rows: [
    { group: "Liam", revenue: 300, jobs: 10, share: 50 },
    { group: "Ava", revenue: 200, jobs: 0, share: null },
    { group: "Zed", revenue: 100.5, jobs: 5, share: 16.75 },
  ],
  totals: { group: "Total", revenue: 600.5, jobs: 15, customers: 3, empty: null },
};
const R5: ToolResult = { ...R1, sourceId: "r5", rows: [{ group: "A", revenue: 5, jobs: 1, share: 1, extra: 7 }], totals: { group: "T", revenue: 5, flag: true } };
const R2: ToolResult = { ...R1, sourceId: "r2", totals: { group: "Total", revenue: 480, jobs: 12 } };
const R3: ToolResult = { ...R1, sourceId: "r3", totals: null };

const R4: ToolResult = { ...R1, sourceId: "r4", totals: { group: "Total", revenue: 0, jobs: 0 } };
const results = new Map<string, ToolResult>([["r1", R1], ["r2", R2], ["r3", R3], ["r4", R4], ["r5", R5]]);
const ref = (sourceId: string, path: string) => ({ sourceId, path });

async function run(raw: unknown, withResults: ReadonlyMap<string, ToolResult> | null = results) {
  const { tp } = fakePrisma();
  return calculate.run(calculate.parse(raw), { ...ctxFor(tp), results: withResults ?? undefined } as never);
}

describe("calculate: parse", () => {
  it("accepts every operation shape", () => {
    expect(calculate.parse({ op: "sum", a: ref("r1", "column.revenue") })).toMatchObject({ op: "sum", aList: false, a: [ref("r1", "column.revenue")] });
    expect(calculate.parse({ op: "sum", a: [ref("r1", "totals.revenue"), ref("r2", "rows.0.revenue")] })).toMatchObject({ aList: true });
    expect(calculate.parse({ op: "ratio", a: ref("r1", "totals.revenue"), b: ref("r1", "totals.jobs") })).toMatchObject({ b: ref("r1", "totals.jobs") });
    expect(calculate.name).toBe("calculate");
    expect(calculate.readOnly).toBe(true);
  });

  it("rejects malformed input with a message the model can act on", () => {
    const bad = (raw: unknown, re: RegExp) => expect(() => calculate.parse(raw), JSON.stringify(raw)).toThrow(re);
    bad(undefined, /JSON object/);
    bad([], /JSON object/);
    bad({ op: "eval", a: ref("r1", "totals.x") }, /must be one of/);
    bad({ op: "sum", a: ref("r1", "totals.x"), z: 1 }, /Unknown argument/);
    bad({ op: "sum" }, /"a" is required/);
    bad({ op: "sum", a: "r1" }, /must be an object/);
    bad({ op: "sum", a: [] }, /1 to 50/);
    bad({ op: "sum", a: Array.from({ length: 51 }, () => ref("r1", "totals.x")) }, /1 to 50/);
    bad({ op: "sum", a: { sourceId: "r1", path: "totals.x", extra: 1 } }, /unknown field/);
    bad({ op: "sum", a: { sourceId: "", path: "totals.x" } }, /sourceId/);
    bad({ op: "sum", a: { sourceId: "r1", path: "totals" } }, /not valid/);
    bad({ op: "sum", a: { sourceId: "r1", path: 5 } }, /not valid/);
    bad({ op: "sum", a: { sourceId: "r1", path: "1 + 2" } }, /not valid/);
    bad({ op: "sum", a: ref("r1", "column.x"), b: ref("r1", "totals.x") }, /not used by sum/);
    bad({ op: "ratio", a: ref("r1", "column.x") }, /"b" is required for ratio/);
    bad({ op: "difference", a: [ref("r1", "totals.x")], b: ref("r1", "totals.x") }, /single reference/);
  });
});

describe("calculate: run", () => {
  it("sum and average over a column, a list of refs and a mix", async () => {
    const s = await run({ op: "sum", a: ref("r1", "column.revenue") });
    expect(s.rows).toEqual([{ label: "Sum of column.revenue of r1", value: 600.5 }]);
    expect(s.columns.map((c) => [c.key, c.format])).toEqual([["label", "text"], ["value", "currency"]]);
    expect(s.totals).toBeNull();
    const l = await run({ op: "sum", a: [ref("r1", "totals.revenue"), ref("r2", "rows.1.revenue"), ref("r2", "totals.revenue"), ref("r1", "rows.0.revenue")] });
    expect(l.rows[0]).toEqual({ label: "Sum of 4 values (totals.revenue of r1; rows.1.revenue of r2; totals.revenue of r2; ...)", value: 1580.5 });
    const three = await run({ op: "sum", a: [ref("r1", "totals.revenue"), ref("r2", "totals.revenue")] });
    expect(three.rows[0].label).toBe("Sum of 2 values (totals.revenue of r1; totals.revenue of r2)");
    const avg = await run({ op: "average", a: ref("r1", "column.jobs") });
    expect(avg.rows[0]).toEqual({ label: "Average of column.jobs of r1", value: 5 });
    expect(avg.columns[1].format).toBe("integer");
    const nullsSkipped = await run({ op: "average", a: ref("r1", "column.share") });
    expect(nullsSkipped.rows[0].value).toBe(33.38);
  });

  it("difference, percent_change, percent_of and ratio with inferred formats", async () => {
    const diff = await run({ op: "difference", a: ref("r1", "totals.revenue"), b: ref("r2", "totals.revenue") });
    expect(diff.rows).toEqual([{ label: "Difference: totals.revenue of r1 vs totals.revenue of r2", value: 120.5 }]);
    expect(diff.columns[1].format).toBe("currency");
    const pc = await run({ op: "percent_change", a: ref("r1", "totals.revenue"), b: ref("r2", "totals.revenue") });
    expect(pc.rows[0].value).toBe(25.1);
    expect(pc.columns[1].format).toBe("percent");
    const po = await run({ op: "percent_of", a: ref("r1", "rows.0.revenue"), b: ref("r1", "totals.revenue") });
    expect(po.rows[0].value).toBe(49.96);
    const perJob = await run({ op: "ratio", a: ref("r1", "totals.revenue"), b: ref("r1", "totals.jobs") });
    expect(perJob.rows[0].value).toBe(40.03);
    expect(perJob.columns[1].format).toBe("currency");
    const unitless = await run({ op: "ratio", a: ref("r1", "totals.jobs"), b: ref("r1", "totals.customers") });
    expect(unitless.rows[0].value).toBe(5);
    expect(unitless.columns[1].format).toBe("text");
  });

  it("division by zero gives a null value and a note row, never an error", async () => {
    for (const op of ["percent_change", "percent_of", "ratio"] as const) {
      const out = await run({ op, a: ref("r1", "totals.revenue"), b: ref("r4", "totals.revenue") });
      expect(out.rows[0].value).toBeNull();
      expect(out.rows).toHaveLength(2);
      expect(out.rows[1]).toEqual({ label: expect.stringContaining("is 0"), value: null });
    }
    const pc = await run({ op: "percent_change", a: ref("r4", "totals.revenue"), b: ref("r4", "totals.revenue") });
    expect(pc.rows[0].value).toBeNull();
  });

  it("rank gives the position of b among the values of a", async () => {
    const top = await run({ op: "rank", a: ref("r1", "column.revenue"), b: ref("r1", "rows.0.revenue") });
    expect(top.rows[0]).toEqual({ label: "Rank of rows.0.revenue of r1 among 3 values (1 = highest)", value: 1 });
    expect(top.columns[1].format).toBe("integer");
    const last = await run({ op: "rank", a: [ref("r1", "rows.0.revenue"), ref("r1", "rows.1.revenue"), ref("r1", "rows.2.revenue")], b: ref("r1", "rows.2.revenue") });
    expect(last.rows[0].value).toBe(3);
    await expect(run({ op: "rank", a: ref("r1", "column.revenue"), b: ref("r2", "totals.revenue") })).rejects.toThrow(/one of the values/);
    await expect(run({ op: "rank", a: ref("r1", "column.revenue"), b: ref("r1", "column.revenue") })).rejects.toThrow(/single value/);
    await expect(run({ op: "rank", a: ref("r1", "column.revenue"), b: ref("r1", "totals.jobs") })).rejects.toThrow(/Cannot rank/);
  });

  it("throws ToolInputError (never a crash) for bad references and misuse", async () => {
    const err = async (raw: unknown, re: RegExp, res: ReadonlyMap<string, ToolResult> | null = results) => {
      const e = await run(raw, res).catch((x: Error) => x);
      expect(e).toBeInstanceOf(Error);
      expect((e as Error).name).toBe("ToolInputError");
      expect((e as Error).message).toMatch(re);
    };
    await err({ op: "sum", a: ref("r1", "totals.x") }, /no earlier results/, null);
    await err({ op: "sum", a: ref("r1", "totals.x") }, /no earlier results/, new Map());
    await err({ op: "sum", a: ref("r9", "totals.revenue") }, /No result with sourceId "r9".*Available: r1, r2, r3, r4, r5/);
    await err({ op: "sum", a: ref("r3", "totals.revenue") }, /has no totals/);
    await err({ op: "sum", a: ref("r1", "totals.nope") }, /no "nope".*Available: group, revenue/);
    await err({ op: "sum", a: ref("r1", "totals.group") }, /not a number \("Total"\)/);
    await err({ op: "sum", a: ref("r1", "totals.empty") }, /is empty/);
    await err({ op: "sum", a: ref("r5", "totals.flag") }, /not a number \(true\)/);
    await err({ op: "sum", a: ref("r1", "rows.9.revenue") }, /has 3 row\(s\); row 9 does not exist/);
    await err({ op: "sum", a: ref("r1", "rows.0.nope") }, /no "nope"/);
    await err({ op: "sum", a: ref("r1", "rows.1.share") }, /is empty/);
    await err({ op: "sum", a: ref("r1", "column.nope") }, /no column "nope"/);
    await err({ op: "sum", a: ref("r1", "column.group") }, /not a number/);
    await err({ op: "sum", a: [ref("r1", "totals.revenue"), ref("r1", "totals.jobs")] }, /Cannot sum a currency value and a integer value/);
    await err({ op: "difference", a: ref("r1", "totals.revenue"), b: ref("r1", "totals.jobs") }, /Cannot difference/);
    await err({ op: "percent_change", a: ref("r1", "totals.revenue"), b: ref("r1", "totals.jobs") }, /Cannot percent change/);
    await err({ op: "difference", a: ref("r1", "column.revenue"), b: ref("r2", "totals.revenue") }, /one value on each side/);
    await err({ op: "ratio", a: ref("r1", "totals.revenue"), b: ref("r1", "column.jobs") }, /one value on each side/);
  });

  it("flags a column with only empty cells and an out-of-range result", async () => {
    const allNull = new Map([["r1", { ...R1, rows: [{ group: "A", revenue: null, jobs: null, share: null }] }]]);
    await expect(run({ op: "sum", a: ref("r1", "column.revenue") }, allNull)).rejects.toThrow(/no numeric values/);
    const huge = new Map([["r1", { ...R1, totals: { group: "T", revenue: 1.7e308, jobs: 1 }, rows: [{ group: "A", revenue: 1.7e308, jobs: 1, share: 1 }] }]]);
    await expect(run({ op: "sum", a: [ref("r1", "totals.revenue"), ref("r1", "rows.0.revenue")] }, huge)).rejects.toThrow(/outside the range/);
  });

  it("falls back to text format for a key that is not a declared column, and does not touch the database", async () => {
    const out = await run({ op: "sum", a: ref("r1", "totals.customers") });
    expect(out.columns[1].format).toBe("text");
    expect(out.rows[0].value).toBe(3);
    expect((await run({ op: "sum", a: ref("r5", "rows.0.extra") })).columns[1].format).toBe("text");
    const { tp, calls } = fakePrisma();
    await calculate.run(calculate.parse({ op: "sum", a: ref("r1", "totals.revenue") }), { ...ctxFor(tp), results } as never);
    expect(calls.filter((c) => c.path !== "businessSettings.findFirst")).toEqual([]);
  });
});
