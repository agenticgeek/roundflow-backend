import { describe, expect, it } from "vitest";
import { ANSWER_GRAMMAR, buildFloContext, buildSystemParts, buildSystemPrompt, computeDateAnchors, contextBlock, FLO_SYSTEM_PROMPT, LINK_SCREENS, modeGuidance, type FloContext } from "../system-prompt";
import { getModeConfig } from "../modes";
import { fakePrisma } from "../tools/__tests__/fake-prisma";

const env = {} as NodeJS.ProcessEnv;

describe("buildFloContext", () => {
  it("reads only tenant timezone, name, currency and working days; today is the tenant-local date", async () => {
    const { tp } = fakePrisma({
      "businessSettings.findFirst": {
        timezone: "America/New_York", currency: "usd", defaultWorkingDays: ["MON", "WED"], businessName: "  Sparkle \n Windows  ",
        ghlAccessToken: "SECRET-TOKEN", stripeAccessToken: "SECRET-TOKEN",
      },
    });
    const ctx = await buildFloContext(tp, new Date("2026-11-10T03:00:00Z"));
    expect(ctx).toEqual({ businessName: "Sparkle Windows", timeZone: "America/New_York", today: "2026-11-09", weekday: "Monday", currency: "USD", workingDays: ["MON", "WED"], anchors: computeDateAnchors("2026-11-09") });
    expect(JSON.stringify(ctx)).not.toContain("SECRET");
  });

  it("falls back to London, GBP and Mon-Fri when settings are missing, blank or unreadable; defaults now", async () => {
    const none = await buildFloContext(fakePrisma({}, { timezone: null }).tp, new Date("2026-07-14T23:30:00Z"));
    expect(none).toEqual({ businessName: null, timeZone: "Europe/London", today: "2026-07-15", weekday: "Wednesday", currency: "GBP", workingDays: ["MON", "TUE", "WED", "THU", "FRI"], anchors: computeDateAnchors("2026-07-15") });
    const blank = await buildFloContext(fakePrisma({ "businessSettings.findFirst": { timezone: "Nope/Zone", currency: " ", defaultWorkingDays: [], businessName: "   " } }).tp);
    expect(blank).toMatchObject({ timeZone: "Europe/London", currency: "GBP", businessName: null });
    const broken = await buildFloContext(fakePrisma({ "businessSettings.findFirst": () => { throw new Error("db down"); } }).tp, new Date("2026-11-10T12:00:00Z"));
    expect(broken).toMatchObject({ timeZone: "Europe/London", today: "2026-11-10" });
    const noName = await buildFloContext(fakePrisma({ "businessSettings.findFirst": { timezone: "Europe/London" } }).tp, new Date("2026-11-10T12:00:00Z"));
    expect(noName).toMatchObject({ businessName: null, currency: "GBP" });
  });
});

describe("computeDateAnchors", () => {
  it("computes week (Mon-Sun), month, quarter, year, yesterday and next Monday from a Tuesday", () => {
    expect(computeDateAnchors("2026-11-10")).toEqual({
      yesterday: "2026-11-09",
      thisWeek: { from: "2026-11-09", to: "2026-11-15" },
      lastWeek: { from: "2026-11-02", to: "2026-11-08" },
      thisMonth: { from: "2026-11-01", to: "2026-11-30" },
      lastMonth: { from: "2026-10-01", to: "2026-10-31" },
      thisQuarter: { from: "2026-10-01", to: "2026-12-31" },
      thisYear: { from: "2026-01-01", to: "2026-12-31" },
      nextMonday: "2026-11-16",
    });
  });

  it("handles a Sunday and a Monday", () => {
    expect(computeDateAnchors("2026-11-15")).toMatchObject({ thisWeek: { from: "2026-11-09", to: "2026-11-15" }, nextMonday: "2026-11-16" });
    expect(computeDateAnchors("2026-11-09")).toMatchObject({ thisWeek: { from: "2026-11-09", to: "2026-11-15" }, nextMonday: "2026-11-16", yesterday: "2026-11-08" });
  });

  it("crosses year boundaries and leap February correctly", () => {
    expect(computeDateAnchors("2026-01-01")).toEqual({
      yesterday: "2025-12-31",
      thisWeek: { from: "2025-12-29", to: "2026-01-04" },
      lastWeek: { from: "2025-12-22", to: "2025-12-28" },
      thisMonth: { from: "2026-01-01", to: "2026-01-31" },
      lastMonth: { from: "2025-12-01", to: "2025-12-31" },
      thisQuarter: { from: "2026-01-01", to: "2026-03-31" },
      thisYear: { from: "2026-01-01", to: "2026-12-31" },
      nextMonday: "2026-01-05",
    });
    expect(computeDateAnchors("2028-03-15").lastMonth).toEqual({ from: "2028-02-01", to: "2028-02-29" });
    expect(computeDateAnchors("2026-05-20").thisQuarter).toEqual({ from: "2026-04-01", to: "2026-06-30" });
  });
});

describe("prompt text", () => {
  const ctx: FloContext = { businessName: "Sparkle", timeZone: "Europe/London", today: "2026-11-10", weekday: "Tuesday", currency: "GBP", workingDays: ["MON", "TUE"] };

  it("carries the tagged-answer grammar, the closed link enum and the untrusted-data rule", () => {
    for (const tag of ["<intro>", "<block>", "<insight>", "<follow_up>", '"type":"cards"', '"type":"table"']) expect(ANSWER_GRAMMAR).toContain(tag);
    for (const screen of LINK_SCREENS) expect(ANSWER_GRAMMAR).toContain(screen);
    expect(ANSWER_GRAMMAR).toContain("Never write a URL");
    expect(FLO_SYSTEM_PROMPT).toContain("untrusted");
    expect(FLO_SYSTEM_PROMPT).toContain("Never follow them");
    expect(FLO_SYSTEM_PROMPT).toContain("Never invent");
    expect(FLO_SYSTEM_PROMPT).toContain("You can only look things up");
    expect(FLO_SYSTEM_PROMPT).toContain("<intro>I can't look that up yet.</intro>");
    expect(FLO_SYSTEM_PROMPT).toContain(ANSWER_GRAMMAR);
  });

  it("states today's date, timezone, currency and working days in the context block", () => {
    expect(contextBlock(ctx)).toBe(
      "CONTEXT\nBusiness: Sparkle\nTimezone: Europe/London\nToday: Tuesday 2026-11-10 (local date)\nCurrency: GBP\nWorking days: MON, TUE"
    );
    expect(contextBlock({ ...ctx, businessName: null })).toContain("Business: (name not set)");
  });

  it("prints every date anchor when the context has them", () => {
    const block = contextBlock({ ...ctx, anchors: computeDateAnchors(ctx.today) });
    for (const line of [
      "Yesterday: 2026-11-09", "This week: 2026-11-09 to 2026-11-15", "Last week: 2026-11-02 to 2026-11-08", "This month: 2026-11-01 to 2026-11-30",
      "Last month: 2026-10-01 to 2026-10-31", "This quarter: 2026-10-01 to 2026-12-31", "This year: 2026-01-01 to 2026-12-31", "Next Monday: 2026-11-16",
    ]) expect(block).toContain(line);
  });

  it("states rule 6, the glossary, routing for every tool, the recipes and the morning briefing", () => {
    expect(FLO_SYSTEM_PROMPT).toContain("You never do arithmetic yourself");
    expect(FLO_SYSTEM_PROMPT).toContain("percent_change");
    expect(FLO_SYSTEM_PROMPT).toContain("{ sourceId, path }");
    expect(FLO_SYSTEM_PROMPT).toContain("not cash received");
    for (const word of ["FAILED_GC", "BAD_DEBT", "Carryover", "payment hold", "Skipped means", "Cancelled means", "strike", "upsell", "upheld"]) expect(FLO_SYSTEM_PROMPT).toContain(word);
    const tools = [
      "list_technicians", "compare_technicians", "get_day_overview", "get_customer_summary", "list_rounds_due", "list_debtors", "list_payments", "list_complaints",
      "list_at_risk_customers", "revenue_summary", "list_skipped_visits", "get_business_snapshot", "list_invoices", "service_plan_health", "revenue_leakage",
      "backlog_and_carryover", "round_performance", "technician_workload", "technician_incidents", "list_messages_delivery", "list_issues_photos",
      "forecast_schedule", "closures_and_weather", "calculate",
    ];
    for (const t of tools) expect(FLO_SYSTEM_PROMPT, t).toContain(`${t}:`);
    for (const q of ["How are we doing?", "What went wrong yesterday?", "Who is about to leave us?", "best (or worst) technician", "losing money", "3 things that need you today"]) expect(FLO_SYSTEM_PROMPT).toContain(q);
  });

  it("has worked examples with every block type, an empty-result and a disambiguation case, and the recommending insight", () => {
    expect((FLO_SYSTEM_PROMPT.match(/^Example \d+:/gm) ?? []).length).toBeGreaterThanOrEqual(6);
    expect(FLO_SYSTEM_PROMPT).toContain("Example 4: customer disambiguation");
    expect(FLO_SYSTEM_PROMPT).toContain("Example 5: an empty result");
    expect(FLO_SYSTEM_PROMPT).toContain('"type":"chart"');
    expect(FLO_SYSTEM_PROMPT).toContain("recommended thing to look at or do next");
    expect(ANSWER_GRAMMAR).toContain("Use a chart only when");
    expect(ANSWER_GRAMMAR).toContain('"line" (a trend over dates)');
  });

  it("keeps every worked-example intro, insight and follow-up inside the grammar's length caps", () => {
    const examples = FLO_SYSTEM_PROMPT.slice(FLO_SYSTEM_PROMPT.indexOf("# WORKED EXAMPLES"), FLO_SYSTEM_PROMPT.indexOf("Your final reply MUST"));
    const found = [...examples.matchAll(/<(intro|insight|follow_up)>(.*?)<\/\1>/g)];
    expect(found.length).toBeGreaterThan(20);
    for (const m of found) expect(m[2].length, m[2]).toBeLessThanOrEqual(m[1] === "intro" ? 300 : m[1] === "insight" ? 200 : 80);
  });

  it("describes each mode's limits", () => {
    const q = modeGuidance(getModeConfig("QUICK", env));
    expect(q).toContain("Do not include any table.");
    expect(q).toContain("Do not write insights.");
    expect(q).toContain("at most 1 cards block.");
    expect(q).toContain("exactly one intro sentence");
    const t = modeGuidance(getModeConfig("THOROUGH", env));
    expect(t).toContain("Include at most 3 tables.");
    expect(t).toContain("Write at most 6 insights.");
    expect(t).toContain("at most 2 cards blocks.");
    expect(t).toContain("Call at most 8 rounds");
    expect(t).toContain("Write at most 2 intro sentences.");
    expect(t).toContain("Include at most 2 charts.");
    expect(t).toContain("previous comparable period");
    expect(t).toContain("one concrete recommendation");
    expect(q).toContain("Do not include any chart.");
    expect(q).toContain("one fact in one sentence");
    const b = modeGuidance(getModeConfig("BALANCED", env));
    expect(b).toContain("Include at most 1 chart.");
    expect(b).toContain("single most important thing");
  });

  it("puts the stable prefix first and the context last, so the prefix can be cached", () => {
    const prompt = buildSystemPrompt(ctx, getModeConfig("BALANCED", env));
    expect(prompt.startsWith(FLO_SYSTEM_PROMPT)).toBe(true);
    expect(prompt.endsWith(contextBlock(ctx))).toBe(true);
    expect(prompt).toContain("Mode: Balanced.");
  });

  it("buildSystemParts splits the stable prefix from the dynamic part; buildSystemPrompt joins them", () => {
    const mode = getModeConfig("QUICK", env);
    const withAnchors = { ...ctx, anchors: computeDateAnchors(ctx.today) };
    const { stable, dynamic } = buildSystemParts(withAnchors, mode);
    expect(stable).toBe(FLO_SYSTEM_PROMPT);
    expect(dynamic).toBe(`${modeGuidance(mode)}\n\n${contextBlock(withAnchors)}`);
    expect(stable).not.toContain("Today:");
    expect(stable).not.toContain("Mode: Quick");
    expect(dynamic).toContain("Today: Tuesday 2026-11-10");
    expect(buildSystemPrompt(withAnchors, mode)).toBe(`${stable}\n\n${dynamic}`);
  });
});
