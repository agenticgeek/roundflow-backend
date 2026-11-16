import { describe, expect, it } from "vitest";
import { AnswerBuilder, autoLink, buildBlock, type BuildContext } from "../answer";
import { getModeConfig } from "../modes";
import { AnswerStreamParser } from "../stream-parser";
import type { ModeConfig, ToolResult } from "../types";

const env = {} as NodeJS.ProcessEnv;

function techResult(over: Partial<ToolResult> = {}): ToolResult {
  return {
    sourceId: "r1",
    tool: "compare_technicians",
    label: "Technicians",
    dateRange: { from: "2026-10-01", to: "2026-10-30", label: "1 to 30 Oct 2026" },
    rows: [
      { technician: "James Carter", revenue: 5460, completed: 400, lastVisit: "2026-10-29" },
      { technician: "Liam Walsh", revenue: 8190, completed: 381, lastVisit: null },
    ],
    totals: { technician: "Total", revenue: 13650, completed: 781 },
    truncated: false,
    columns: [
      { key: "technician", label: "Technician", format: "text", align: "left" },
      { key: "revenue", label: "Revenue", format: "currency", align: "right" },
      { key: "completed", label: "Completed", format: "integer", align: "right" },
      { key: "lastVisit", label: "Last visit", format: "date", align: "left" },
    ],
    ...over,
  };
}

function ctxOf(results: ToolResult[]): BuildContext {
  return { results: new Map(results.map((r) => [r.sourceId, r])), isKnownId: () => false, figuresOk: () => true };
}

describe("buildBlock: charts", () => {
  const chart = (extra: object = {}) => ({ type: "chart", kind: "bar", title: "Revenue by technician", sourceId: "r1", x: "technician", y: ["revenue"], ...extra });

  it("builds the exact ChartBlock from the stored result (never from model values)", () => {
    const out = buildBlock({ ...chart(), rows: [{ technician: "Fake", revenue: 1 }], link: { screen: "REPORTS", params: { period: "thisMonth" } } }, ctxOf([techResult()]));
    expect(out).toEqual({
      ok: true,
      block: {
        type: "chart",
        kind: "bar",
        title: "Revenue by technician",
        sourceId: "r1",
        x: { key: "technician", label: "Technician", format: "text" },
        series: [{ key: "revenue", label: "Revenue", format: "currency" }],
        rows: [
          { technician: "James Carter", revenue: 5460 },
          { technician: "Liam Walsh", revenue: 8190 },
        ],
        link: { screen: "REPORTS", params: { period: "thisMonth" } },
      },
    });
  });

  it("supports line charts with several series and falls back to the result label for a missing or unsafe title", () => {
    const out = buildBlock(chart({ kind: "line", x: "lastVisit", y: ["revenue", "completed"], title: "see https://evil.io" }), ctxOf([techResult()]));
    expect(out).toMatchObject({ ok: true, block: { kind: "line", title: "Technicians", x: { format: "date" }, series: [{ key: "revenue" }, { key: "completed" }] } });
    expect(buildBlock(chart({ title: undefined }), ctxOf([techResult()]))).toMatchObject({ ok: true, block: { title: "Technicians" } });
  });

  it("rejects unknown sources and columns, non-numeric y columns, bad kinds and bad series lists", () => {
    const ctx = ctxOf([techResult()]);
    const bad = (extra: object, reason: string) => expect(buildBlock(chart(extra), ctx)).toEqual({ ok: false, reason });
    bad({ sourceId: "nope" }, "UNKNOWN_SOURCE");
    bad({ sourceId: 5 }, "UNKNOWN_SOURCE");
    bad({ x: "nope" }, "UNKNOWN_COLUMN");
    bad({ y: ["nope"] }, "UNKNOWN_COLUMN");
    bad({ y: ["technician"] }, "INVALID"); // text
    bad({ y: ["lastVisit"] }, "INVALID"); // date
    bad({ kind: "pie" }, "INVALID");
    bad({ x: 5 }, "INVALID");
    bad({ y: [] }, "INVALID");
    bad({ y: "revenue" }, "INVALID");
    bad({ y: [1] }, "INVALID");
    bad({ y: ["revenue", "revenue"] }, "INVALID");
    bad({ y: ["revenue", "completed", "revenue", "completed"] }, "INVALID");
    bad({ y: ["technician", "revenue"] }, "INVALID"); // x repeated as y
    expect(buildBlock(chart(), ctxOf([techResult({ rows: [] })]))).toEqual({ ok: false, reason: "EMPTY" });
  });

  it("takes the first 24 rows when the result has more", () => {
    const rows = Array.from({ length: 30 }, (_, i) => ({ technician: `T${i}`, revenue: i }));
    const out = buildBlock(chart(), ctxOf([techResult({ rows })]));
    const block = out.ok && out.block.type === "chart" ? out.block : null;
    expect(block?.rows).toHaveLength(24);
    expect(block?.rows[23]).toEqual({ technician: "T23", revenue: 23 });
  });
});

describe("auto deep links", () => {
  const tableOf = (tool: string, over: Partial<ToolResult> = {}) =>
    buildBlock({ type: "table", sourceId: "r1", columns: ["technician"] }, ctxOf([techResult({ tool, ...over })]));
  const linkOf = (o: ReturnType<typeof buildBlock>) => (o.ok && o.block.type !== "cards" ? o.block.link : "no block");

  it("maps every tool in the spec to its screen", () => {
    const map: Record<string, string> = {
      list_debtors: "DEBT_PAYMENT",
      list_complaints: "COMPLAINTS",
      compare_technicians: "TECHNICIANS",
      list_technicians: "TECHNICIANS",
      technician_workload: "TECHNICIANS",
      technician_incidents: "TECHNICIANS",
      revenue_summary: "REPORTS",
      revenue_leakage: "REPORTS",
      get_business_snapshot: "REPORTS",
      list_invoices: "INVOICES",
      get_day_overview: "TODAYS_WORK",
      list_skipped_visits: "TODAYS_WORK",
      backlog_and_carryover: "TODAYS_WORK",
      round_performance: "ROUND",
      list_rounds_due: "ROUND",
      forecast_schedule: "ROUND",
      get_customer_summary: "CUSTOMERS",
      list_at_risk_customers: "CUSTOMERS",
      service_plan_health: "CUSTOMERS",
      list_messages_delivery: "CUSTOMERS",
    };
    for (const [tool, screen] of Object.entries(map)) expect(linkOf(tableOf(tool))).toEqual({ screen });
  });

  it("attaches no link for an unmapped tool, including prototype keys", () => {
    expect(linkOf(tableOf("calculate"))).toBeUndefined();
    expect(linkOf(tableOf("constructor"))).toBeUndefined();
    expect(autoLink(techResult({ tool: "toString" }))).toBeUndefined();
  });

  it("passes the date only for a single-day TODAYS_WORK result", () => {
    const day = { from: "2026-10-05", to: "2026-10-05", label: "5 Oct" };
    expect(linkOf(tableOf("get_day_overview", { dateRange: day }))).toEqual({ screen: "TODAYS_WORK", params: { date: "2026-10-05" } });
    expect(linkOf(tableOf("get_day_overview", { dateRange: null }))).toEqual({ screen: "TODAYS_WORK" });
    expect(linkOf(tableOf("get_day_overview"))).toEqual({ screen: "TODAYS_WORK" }); // a range, not a day
    expect(linkOf(tableOf("list_rounds_due", { dateRange: day }))).toEqual({ screen: "ROUND" });
    expect(linkOf(tableOf("get_day_overview", { dateRange: { from: "today", to: "today", label: "x" } }))).toEqual({ screen: "TODAYS_WORK" });
  });

  it("a valid model link wins; an invalid one is dropped and the auto link applies", () => {
    const ctx = ctxOf([techResult()]);
    const base = { type: "table", sourceId: "r1", columns: ["technician"] };
    expect(buildBlock({ ...base, link: { screen: "REPORTS" } }, ctx)).toMatchObject({ block: { link: { screen: "REPORTS" } } });
    expect(buildBlock({ ...base, link: { screen: "https://evil.io" } }, ctx)).toMatchObject({ block: { link: { screen: "TECHNICIANS" } } });
    const chart = { type: "chart", kind: "bar", sourceId: "r1", x: "technician", y: ["revenue"] };
    expect(buildBlock(chart, ctx)).toMatchObject({ block: { link: { screen: "TECHNICIANS" } } });
    expect(buildBlock({ ...chart, link: { screen: "nope" } }, ctx)).toMatchObject({ block: { link: { screen: "TECHNICIANS" } } });
  });

  it("cards take the link of the first item whose source maps to a screen, or none", () => {
    const calc = techResult({ sourceId: "r2", tool: "calculate" });
    const out = buildBlock(
      {
        type: "cards",
        items: [
          "junk",
          { label: "a", sourceId: "nope", path: "totals.revenue" },
          { label: "b", sourceId: "r2", path: "totals.revenue" },
          { label: "c", sourceId: "r1", path: "totals.revenue" },
        ],
      },
      ctxOf([techResult(), calc])
    );
    expect(out).toMatchObject({ ok: true, block: { link: { screen: "TECHNICIANS" } } });
    const none = buildBlock({ type: "cards", items: [{ label: "b", sourceId: "r2", path: "totals.revenue" }] }, ctxOf([calc]));
    expect(none.ok && none.block.type === "cards" && "link" in none.block).toBe(false);
  });
});

describe("AnswerBuilder: charts", () => {
  const chartJson = JSON.stringify({ type: "chart", kind: "bar", sourceId: "r1", x: "technician", y: ["revenue"] });
  const make = (maxCharts?: number) => {
    const mode: Record<string, unknown> = { ...getModeConfig("BALANCED", env), maxCharts };
    if (maxCharts === undefined) delete mode.maxCharts; // a ModeConfig without the field (older shape)
    return new AnswerBuilder(mode as unknown as ModeConfig, { results: new Map([["r1", techResult()]]), knownIds: new Set() });
  };

  it("emits a block event and counts the chart in the final answer and its date range", () => {
    const builder = make(1);
    expect(builder.accept({ kind: "block", text: chartJson })).toMatchObject([{ event: "block", data: { index: 0, block: { type: "chart", sourceId: "r1" } } }]);
    const { answer } = builder.finish();
    expect(answer.blocks).toHaveLength(1);
    expect(answer.dateRange).toMatchObject({ from: "2026-10-01" });
  });

  it("enforces maxCharts per mode and treats a missing maxCharts as zero", () => {
    const one = make(1);
    expect(one.accept({ kind: "block", text: chartJson })).toHaveLength(1);
    expect(one.accept({ kind: "block", text: chartJson })).toEqual([]);
    expect(one.rejected).toBe(1);
    expect(make(0).accept({ kind: "block", text: chartJson })).toEqual([]);
    expect(make().accept({ kind: "block", text: chartJson })).toEqual([]);
    const two = make(2);
    two.accept({ kind: "block", text: chartJson });
    expect(two.accept({ kind: "block", text: chartJson })).toHaveLength(1);
  });

  it("a chart block from the stream parser goes through unchanged", () => {
    const parser = new AnswerStreamParser();
    const els = [...parser.push(`<block>${chartJson}</block>`), ...parser.end()];
    expect(els).toEqual([{ kind: "block", text: chartJson }]);
    expect(make(1).accept(els[0])).toMatchObject([{ event: "block", data: { block: { type: "chart" } } }]);
  });
});

describe("AnswerBuilder: finish with nothing to follow up", () => {
  it("sends no follow_ups event when there are no results and the model wrote none", () => {
    const builder = new AnswerBuilder(getModeConfig("BALANCED", env), { results: new Map(), knownIds: new Set() });
    expect(builder.finish().events).toEqual([]);
  });
});

describe("AnswerBuilder: unverified insight", () => {
  it("raises the warning when only an insight fails the figure check", () => {
    const builder = new AnswerBuilder(getModeConfig("BALANCED", env), { results: new Map([["r1", techResult()]]), knownIds: new Set() });
    builder.accept({ kind: "intro", text: "Revenue was 13650." });
    builder.accept({ kind: "insight", text: "That is 987 above target." });
    const { warnings, answer } = builder.finish();
    expect(warnings).toEqual(["UNVERIFIED_FIGURES"]);
    expect(answer.introUnverified).toBe(false);
  });
});
