import { describe, expect, it } from "vitest";
import { AnswerBuilder, answerText, buildBlock, buildLink, splitSentences, type BuildContext } from "../answer";
import { getModeConfig } from "../modes";
import type { ToolResult } from "../types";

const env = {} as NodeJS.ProcessEnv;

function techResult(over: Partial<ToolResult> = {}): ToolResult {
  return {
    sourceId: "r1",
    tool: "compare_technicians",
    label: "Technicians",
    dateRange: { from: "2026-10-01", to: "2026-10-30", label: "1 to 30 Oct 2026" },
    rows: [
      { technician: "James Carter", revenue: 5460, completed: 400, lastVisit: "2026-10-29", ok: true },
      { technician: "Liam Walsh", revenue: 8190, completed: 381, lastVisit: null, ok: false },
    ],
    totals: { technician: "Total", revenue: 13650, completed: 781 },
    truncated: false,
    columns: [
      { key: "technician", label: "Technician", format: "text", align: "left" },
      { key: "revenue", label: "Revenue", format: "currency", align: "right" },
      { key: "completed", label: "Completed", format: "integer", align: "right" },
      { key: "lastVisit", label: "Last visit", format: "date", align: "left" },
      { key: "ok", label: "OK", format: "text", align: "left" },
    ],
    ...over,
  };
}

function ctxOf(results: ToolResult[], over: Partial<BuildContext> = {}): BuildContext {
  return { results: new Map(results.map((r) => [r.sourceId, r])), isKnownId: (id) => id === "r7", figuresOk: () => true, ...over };
}

describe("splitSentences", () => {
  it("splits on sentence ends but not on abbreviations or decimals", () => {
    expect(splitSentences("Liam had 14 skips. Mrs. Smith owes £50.25! Is that 96.4% done? Yes")).toEqual([
      "Liam had 14 skips.",
      "Mrs. Smith owes £50.25!",
      "Is that 96.4% done?",
      "Yes",
    ]);
    expect(splitSentences("  ")).toEqual([]);
    expect(splitSentences("One sentence only.")).toEqual(["One sentence only."]);
  });
});

describe("buildLink", () => {
  const known = (id: string) => id === "r7";
  it("accepts only the closed screen enum with validated params", () => {
    expect(buildLink({ screen: "REPORTS", params: { period: "thisMonth" } }, known)).toEqual({ screen: "REPORTS", params: { period: "thisMonth" } });
    expect(buildLink({ screen: "ROUND", params: { roundId: "r7", date: "2026-10-01" } }, known)).toEqual({ screen: "ROUND", params: { roundId: "r7", date: "2026-10-01" } });
    expect(buildLink({ screen: "TODAYS_WORK", params: { visitId: "r7" } }, known)).toEqual({ screen: "TODAYS_WORK", params: { visitId: "r7" } });
    expect(buildLink({ screen: "COMPLAINTS" }, known)).toEqual({ screen: "COMPLAINTS" });
  });

  it("rejects an arbitrary URL, an unknown screen and non-objects", () => {
    expect(buildLink({ screen: "https://evil.example.com" }, known)).toBeUndefined();
    expect(buildLink({ screen: "ADMIN_PANEL" }, known)).toBeUndefined();
    expect(buildLink("REPORTS", known)).toBeUndefined();
    expect(buildLink(null, known)).toBeUndefined();
    expect(buildLink({}, known)).toBeUndefined();
  });

  it("drops params that are unknown, malformed, not strings or ids not seen in this chat", () => {
    const link = buildLink(
      { screen: "ROUND", params: { roundId: "other-tenant-id", date: "10/01/2026", url: "http://x.io", constructor: "x", visitId: "r7" } },
      known
    );
    expect(link).toEqual({ screen: "ROUND" });
    expect(buildLink({ screen: "ROUND", params: { roundId: 7 } }, known)).toEqual({ screen: "ROUND" });
    expect(buildLink({ screen: "REPORTS", params: { period: "forever" } }, known)).toEqual({ screen: "REPORTS" });
    expect(buildLink({ screen: "ROUND", params: "nope" }, known)).toEqual({ screen: "ROUND" });
    expect(buildLink({ screen: "ROUND", params: { roundId: "bad id!" } }, known)).toEqual({ screen: "ROUND" });
  });
});

describe("buildBlock: cards", () => {
  it("builds values and formats from the stored result, never from the model", () => {
    const out = buildBlock(
      {
        type: "cards",
        items: [
          { label: "Revenue", sourceId: "r1", path: "totals.revenue", sub: "across 2 technicians", tone: "positive", value: 999999 },
          { label: "First tech", sourceId: "r1", path: "rows.0.technician" },
          { label: "Raw", sourceId: "r1", path: "totals.completed" },
        ],
        link: { screen: "REPORTS", params: { period: "thisMonth" } },
      },
      ctxOf([techResult()])
    );
    expect(out).toEqual({
      ok: true,
      block: {
        type: "cards",
        items: [
          { label: "Revenue", value: 13650, format: "currency", sub: "across 2 technicians", tone: "positive" },
          { label: "First tech", value: "James Carter", format: "text" },
          { label: "Raw", value: 781, format: "integer" },
        ],
        link: { screen: "REPORTS", params: { period: "thisMonth" } },
      },
    });
  });

  it("infers the format when the path key is not a column, and drops a sub that fails lint or the figure check", () => {
    const result = techResult({ totals: { odd: 1.5, count: 4 } });
    const out = buildBlock(
      {
        type: "cards",
        items: [
          { label: "Odd", sourceId: "r1", path: "totals.odd", sub: "see https://evil.example.com", tone: "angry" },
          { label: "Count", sourceId: "r1", path: "totals.count", sub: "12 more than expected" },
        ],
      },
      ctxOf([result], { figuresOk: (t) => !t.includes("12") })
    );
    expect(out).toEqual({ ok: true, block: { type: "cards", items: [{ label: "Odd", value: 1.5, format: "text" }, { label: "Count", value: 4, format: "integer" }] } });
  });

  it("skips bad items and rejects the block when none survive", () => {
    const ctx = ctxOf([techResult()]);
    const items = [
      null,
      { label: "x", sourceId: "nope", path: "totals.revenue" },
      { label: "x", sourceId: "r1", path: "totals.missing" },
      { label: "x", sourceId: "r1", path: "rows.9.revenue" },
      { label: "x", sourceId: "r1", path: "rows.0.ok" }, // boolean
      { label: "x", sourceId: "r1", path: "rows.0.lastVisit" }, // value present but null: rows.0 has a date
      { label: "x", sourceId: "r1", path: "rows.1.lastVisit" }, // null
      { label: "x", sourceId: "r1", path: "__proto__.polluted" },
      { label: "x", sourceId: "r1", path: "totals" },
      { label: "a very long label that is far beyond forty characters", sourceId: "r1", path: "totals.revenue" },
      { label: "see http://evil.io", sourceId: "r1", path: "totals.revenue" },
      { label: 5, sourceId: "r1", path: "totals.revenue" },
    ];
    expect(buildBlock({ type: "cards", items }, ctx)).toEqual({
      ok: true,
      block: { type: "cards", items: [{ label: "x", value: "2026-10-29", format: "date" }] },
    });
    expect(buildBlock({ type: "cards", items: items.filter((_, i) => i !== 5) }, ctx)).toEqual({ ok: false, reason: "INVALID" });
    expect(buildBlock({ type: "cards" }, ctx)).toEqual({ ok: false, reason: "INVALID" });
    expect(buildBlock({ type: "cards", items: [] }, ctx)).toEqual({ ok: false, reason: "INVALID" });
  });

  it("totals with no totals object cannot be read", () => {
    expect(buildBlock({ type: "cards", items: [{ label: "x", sourceId: "r1", path: "totals.revenue" }] }, ctxOf([techResult({ totals: null })]))).toEqual({
      ok: false,
      reason: "INVALID",
    });
  });

  it("caps the items per block at six", () => {
    const items = Array.from({ length: 9 }, () => ({ label: "Rev", sourceId: "r1", path: "totals.revenue" }));
    const out = buildBlock({ type: "cards", items }, ctxOf([techResult()]));
    expect(out.ok && out.block.type === "cards" && out.block.items.length).toBe(6);
  });
});

describe("buildBlock: tables", () => {
  it("builds columns, rows and totals from the result and keeps a validated link", () => {
    const out = buildBlock(
      { type: "table", title: "Performance by technician", sourceId: "r1", columns: ["technician", "revenue", "ok", "lastVisit"], link: { screen: "TECHNICIANS" } },
      ctxOf([techResult()])
    );
    expect(out).toEqual({
      ok: true,
      block: {
        type: "table",
        title: "Performance by technician",
        sourceId: "r1",
        columns: [
          { key: "technician", label: "Technician", format: "text", align: "left" },
          { key: "revenue", label: "Revenue", format: "currency", align: "right" },
          { key: "ok", label: "OK", format: "text", align: "left" },
          { key: "lastVisit", label: "Last visit", format: "date", align: "left" },
        ],
        rows: [
          { technician: "James Carter", revenue: 5460, ok: "Yes", lastVisit: "2026-10-29" },
          { technician: "Liam Walsh", revenue: 8190, ok: "No", lastVisit: null },
        ],
        totals: { technician: "Total", revenue: 13650, ok: null, lastVisit: null },
        link: { screen: "TECHNICIANS" },
      },
    });
  });

  it("falls back to the result label for a missing or unsafe title and omits totals when there are none", () => {
    const out = buildBlock({ type: "table", title: "<b>x</b>", sourceId: "r1", columns: ["technician"] }, ctxOf([techResult({ totals: null })]));
    expect(out).toMatchObject({ ok: true, block: { title: "Technicians" } });
    expect(out.ok && "totals" in out.block).toBe(false);
    const noTitle = buildBlock({ type: "table", sourceId: "r1", columns: ["technician"] }, ctxOf([techResult()]));
    expect(noTitle).toMatchObject({ ok: true, block: { title: "Technicians" } });
  });

  it("rejects an unknown source, unknown column, bad column lists and an empty result", () => {
    const ctx = ctxOf([techResult()]);
    expect(buildBlock({ type: "table", sourceId: "nope", columns: ["technician"] }, ctx)).toEqual({ ok: false, reason: "UNKNOWN_SOURCE" });
    expect(buildBlock({ type: "table", columns: ["technician"] }, ctx)).toEqual({ ok: false, reason: "UNKNOWN_SOURCE" });
    expect(buildBlock({ type: "table", sourceId: "r1", columns: ["technician", "salary"] }, ctx)).toEqual({ ok: false, reason: "UNKNOWN_COLUMN" });
    expect(buildBlock({ type: "table", sourceId: "r1", columns: [] }, ctx)).toEqual({ ok: false, reason: "INVALID" });
    expect(buildBlock({ type: "table", sourceId: "r1" }, ctx)).toEqual({ ok: false, reason: "INVALID" });
    expect(buildBlock({ type: "table", sourceId: "r1", columns: ["technician", 4] }, ctx)).toEqual({ ok: false, reason: "INVALID" });
    expect(buildBlock({ type: "table", sourceId: "r1", columns: ["technician", "technician"] }, ctx)).toEqual({ ok: false, reason: "INVALID" });
    expect(buildBlock({ type: "table", sourceId: "r1", columns: Array.from({ length: 9 }, (_, i) => `c${i}`) }, ctx)).toEqual({ ok: false, reason: "INVALID" });
    expect(buildBlock({ type: "table", sourceId: "r1", columns: ["technician"] }, ctxOf([techResult({ rows: [] })]))).toEqual({ ok: false, reason: "EMPTY" });
  });

  it("rejects unknown block types and non-objects", () => {
    const ctx = ctxOf([techResult()]);
    expect(buildBlock({ type: "html", html: "<b>x</b>" }, ctx)).toEqual({ ok: false, reason: "INVALID" });
    expect(buildBlock("table", ctx)).toEqual({ ok: false, reason: "INVALID" });
    expect(buildBlock([], ctx)).toEqual({ ok: false, reason: "INVALID" });
  });
});

describe("AnswerBuilder", () => {
  function setup(mode = "BALANCED" as "BALANCED" | "QUICK" | "THOROUGH", results: ToolResult[] = [techResult()], knownIds: string[] = []) {
    const map = new Map(results.map((r) => [r.sourceId, r]));
    const builder = new AnswerBuilder(getModeConfig(mode, env), { results: map, knownIds: new Set(knownIds) });
    return { builder, map };
  }
  const table = (extra: object = {}) => JSON.stringify({ type: "table", sourceId: "r1", columns: ["technician", "revenue"], ...extra });
  const cards = JSON.stringify({ type: "cards", items: [{ label: "Revenue", sourceId: "r1", path: "totals.revenue" }] });

  it("emits per-target indexes, flags unverified sentences and assembles the final answer", () => {
    const { builder } = setup();
    expect(builder.hasContent()).toBe(false);
    const e1 = builder.accept({ kind: "intro", text: "Here is October across 2 technicians. Revenue is up 12% on September." });
    expect(e1).toEqual([
      { event: "text", data: { target: "intro", index: 0, text: "Here is October across 2 technicians." } },
      { event: "text", data: { target: "intro", index: 1, text: "Revenue is up 12% on September.", unverified: true } },
    ]);
    const e2 = builder.accept({ kind: "block", text: cards });
    expect(e2).toMatchObject([{ event: "block", data: { index: 0, block: { type: "cards" } } }]);
    const e3 = builder.accept({ kind: "block", text: table() });
    expect(e3).toMatchObject([{ event: "block", data: { index: 1, block: { type: "table", sourceId: "r1" } } }]);
    const e4 = builder.accept({ kind: "insight", text: "Liam Walsh led on revenue (8190). Check the table." });
    expect(e4).toEqual([
      { event: "text", data: { target: "insight", index: 0, text: "Liam Walsh led on revenue (8190)." } },
      { event: "text", data: { target: "insight", index: 1, text: "Check the table." } },
    ]);
    expect(builder.accept({ kind: "follow_up", text: "Compare with September" })).toEqual([]);
    builder.accept({ kind: "follow_up", text: "Compare with September" }); // duplicate
    builder.accept({ kind: "follow_up", text: "Show skips" });
    builder.accept({ kind: "follow_up", text: "Show complaints" });
    builder.accept({ kind: "follow_up", text: "A fourth is over the cap" });

    const { events, answer, warnings } = builder.finish();
    expect(events).toEqual([
      { event: "follow_ups", data: { items: ["Compare with September", "Show skips", "Show complaints"] } },
      { event: "warning", data: { code: "UNVERIFIED_FIGURES" } },
    ]);
    expect(warnings).toEqual(["UNVERIFIED_FIGURES"]);
    expect(answer).toMatchObject({
      intro: "Here is October across 2 technicians. Revenue is up 12% on September.",
      introUnverified: true,
      dateRange: { from: "2026-10-01", to: "2026-10-30", label: "1 to 30 Oct 2026" },
      insights: [
        { text: "Liam Walsh led on revenue (8190).", unverified: false },
        { text: "Check the table.", unverified: false },
      ],
      sources: [{ id: "r1", tool: "compare_technicians", label: "Technicians", rows: 2 }],
      truncated: false,
    });
    expect(answer.blocks).toHaveLength(2);
    expect(builder.hasContent()).toBe(true);
    expect(answerText(answer)).toBe(
      "Here is October across 2 technicians. Revenue is up 12% on September. Liam Walsh led on revenue (8190). Check the table."
    );
  });

  it("finishes a clean answer with no warning, no follow-ups and the first result's date range", () => {
    const { builder } = setup("BALANCED", [techResult({ truncated: true })]);
    builder.accept({ kind: "intro", text: "All good." });
    const { events, answer, warnings } = builder.finish();
    expect(events).toEqual([]);
    expect(warnings).toEqual([]);
    expect(answer).toMatchObject({ introUnverified: false, truncated: true, dateRange: { from: "2026-10-01" } });
  });

  it("omits the date range when no result has one", () => {
    const { builder } = setup("BALANCED", [techResult({ dateRange: null })]);
    builder.accept({ kind: "intro", text: "Fine." });
    expect("dateRange" in builder.finish().answer).toBe(false);
  });

  it("prefers the date range of the result a table cites", () => {
    const other = techResult({ sourceId: "r2", dateRange: { from: "2026-09-01", to: "2026-09-30", label: "1 to 30 Sep 2026" } });
    const { builder } = setup("BALANCED", [techResult({ dateRange: null }), other]);
    builder.accept({ kind: "block", text: JSON.stringify({ type: "table", sourceId: "r2", columns: ["technician"] }) });
    expect(builder.finish().answer.dateRange?.from).toBe("2026-09-01");
  });

  it("drops sentences that fail the lint (URL, code, html) and counts them", () => {
    const { builder } = setup();
    const out = builder.accept({ kind: "intro", text: "Open https://evil.example.com now. Then run `rm -rf`. <b>Hi</b>. Totals are fine." });
    expect(out).toEqual([{ event: "text", data: { target: "intro", index: 0, text: "Totals are fine." } }]);
    expect(builder.rejected).toBe(3);
  });

  it("stops an element at its character cap and at the mode's sentence cap", () => {
    const { builder } = setup("BALANCED");
    const long = Array.from({ length: 5 }, (_, i) => `Sentence number ${i} is padded out with quite a few extra words to use up the room.`).join(" ");
    const out = builder.accept({ kind: "insight", text: long });
    expect(out.length).toBeGreaterThan(0);
    expect(out.length).toBeLessThan(5);
    const intro = builder.accept({ kind: "intro", text: "One. Two. Three. Four." });
    expect(intro).toHaveLength(2); // BALANCED allows two intro sentences
  });

  it("QUICK: one intro sentence, no insights, no tables, one cards block", () => {
    const { builder } = setup("QUICK");
    expect(builder.accept({ kind: "intro", text: "First. Second." })).toHaveLength(1);
    expect(builder.accept({ kind: "insight", text: "Not allowed." })).toEqual([]);
    expect(builder.accept({ kind: "block", text: table() })).toEqual([]);
    expect(builder.accept({ kind: "block", text: cards })).toHaveLength(1);
    expect(builder.accept({ kind: "block", text: cards })).toEqual([]);
    expect(builder.rejected).toBe(2);
  });

  it("BALANCED allows two tables and THOROUGH three", () => {
    const b = setup("BALANCED").builder;
    expect([1, 2, 3].map(() => b.accept({ kind: "block", text: table() }).length)).toEqual([1, 1, 0]);
    const t = setup("THOROUGH").builder;
    expect([1, 2, 3, 4].map(() => t.accept({ kind: "block", text: table() }).length)).toEqual([1, 1, 1, 0]);
  });

  it("rejects malformed JSON, unknown block types and blocks citing a source that does not exist", () => {
    const { builder } = setup();
    expect(builder.accept({ kind: "block", text: "{oops" })).toEqual([]);
    expect(builder.accept({ kind: "block", text: '"just a string"' })).toEqual([]);
    expect(builder.accept({ kind: "block", text: '{"type":"html"}' })).toEqual([]);
    expect(builder.accept({ kind: "block", text: JSON.stringify({ type: "table", sourceId: "r99", columns: ["technician"] }) })).toEqual([]);
    expect(builder.rejected).toBe(4);
    expect(builder.hasContent()).toBe(false);
  });

  it("link ids must be known: seen in a result row or passed to a tool as an argument", () => {
    const withId = techResult({ rows: [{ technician: "Liam", roundId: "round-9", revenue: 1 }], columns: [{ key: "technician", label: "T", format: "text", align: "left" }] });
    const { builder } = setup("THOROUGH", [withId], ["arg-id"]);
    const link = (id: string) => JSON.stringify({ type: "table", sourceId: "r1", columns: ["technician"], link: { screen: "ROUND", params: { roundId: id } } });
    const first = builder.accept({ kind: "block", text: link("round-9") });
    const second = builder.accept({ kind: "block", text: link("arg-id") });
    const third = builder.accept({ kind: "block", text: link("other-tenant") });
    const links = [first, second, third].map((e) => (e[0] as { data: { block: { link?: unknown } } }).data.block.link);
    expect(links).toEqual([{ screen: "ROUND", params: { roundId: "round-9" } }, { screen: "ROUND", params: { roundId: "arg-id" } }, { screen: "ROUND" }]);
  });

  it("re-checks figures when a new result arrives after the checker was cached", () => {
    const { builder, map } = setup();
    expect(builder.accept({ kind: "intro", text: "There are 55 things." })[0]).toMatchObject({ data: { unverified: true } });
    map.set("r2", techResult({ sourceId: "r2", rows: [{ n: 55 }], totals: null }));
    expect(builder.accept({ kind: "insight", text: "There are 55 things." })[0]).toMatchObject({ data: { text: "There are 55 things." } });
    expect((builder.accept({ kind: "insight", text: "Again 55 things." })[0] as { data: { unverified?: true } }).data.unverified).toBeUndefined();
  });
});
