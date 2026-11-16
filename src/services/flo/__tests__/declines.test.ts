import { describe, expect, it } from "vitest";
import {
  CAPABILITY_TEXT, declineForVerdict, fallbackFollowUps, FOLLOW_UPS_BY_TOOL, declineNoData, NO_DATA_TEXT, OUT_OF_SCOPE_TEXT, SUGGESTION_GROUPS, WRITE_REQUEST_TEXT,
} from "../declines";

describe("declines (fixed copy)", () => {
  it("OUT_OF_SCOPE and UNSAFE read identically and carry 3 suggestions", () => {
    const o = declineForVerdict("OUT_OF_SCOPE");
    const u = declineForVerdict("UNSAFE");
    expect(o).toEqual({ reason: "OUT_OF_SCOPE", text: OUT_OF_SCOPE_TEXT, suggestions: expect.any(Array) });
    expect(o.suggestions).toHaveLength(3);
    expect(u.text).toBe(o.text);
    expect(u.reason).toBe("UNSAFE");
    expect(OUT_OF_SCOPE_TEXT).toBe(
      "That's outside what I can help with. I'm Flo, and I look things up in your own RoundFlow data: rounds, jobs, payments, complaints and technicians."
    );
  });

  it("WRITE_REQUEST says Flo only looks things up", () => {
    const w = declineForVerdict("WRITE_REQUEST");
    expect(w.text).toBe(WRITE_REQUEST_TEXT);
    expect(w.text).toBe("Flo can only look things up for now. I can't change anything.");
    expect(w.suggestions).toHaveLength(3);
  });

  it("CAPABILITY_QUESTION is served from the suggestion data, one per area", () => {
    const c = declineForVerdict("CAPABILITY_QUESTION");
    expect(c.reason).toBe("CAPABILITY");
    expect(c.text).toBe(CAPABILITY_TEXT);
    expect(c.suggestions).toEqual(SUGGESTION_GROUPS.map((g) => g.items[0]));
  });

  it("the morning briefing is the first chip of the first group and in the capability suggestions", () => {
    expect(SUGGESTION_GROUPS[0].items[0]).toBe("Give me my morning briefing");
    expect(declineForVerdict("CAPABILITY_QUESTION").suggestions[0]).toBe("Give me my morning briefing");
    expect(declineForVerdict("GREETING").suggestions[0]).toBe("Give me my morning briefing");
  });

  it("has follow-ups for the 13 new tools", () => {
    const names = ["get_business_snapshot", "list_invoices", "service_plan_health", "revenue_leakage", "backlog_and_carryover", "round_performance",
      "technician_workload", "technician_incidents", "list_messages_delivery", "list_issues_photos", "forecast_schedule", "closures_and_weather", "calculate"];
    for (const t of names) {
      expect(FOLLOW_UPS_BY_TOOL[t], t).toHaveLength(2);
      expect(fallbackFollowUps([t]).length, t).toBeGreaterThan(0);
      for (const q of FOLLOW_UPS_BY_TOOL[t]) expect(q.length).toBeLessThanOrEqual(80);
    }
  });

  it("fallbackFollowUps skips unknown tools, de-duplicates and caps at max", () => {
    expect(fallbackFollowUps(["nope"])).toEqual([]);
    expect(fallbackFollowUps(["list_debtors", "list_debtors", "list_payments"], 3)).toHaveLength(3);
    expect(fallbackFollowUps(["list_debtors"], 1)).toHaveLength(1);
  });

  it("NO_DATA_USED has its own fixed copy", () => {
    const n = declineNoData();
    expect(n).toMatchObject({ reason: "NO_DATA_USED", text: NO_DATA_TEXT });
    expect(n.suggestions).toHaveLength(3);
  });

  it("every suggestion is non-empty and at most 80 characters", () => {
    const all = SUGGESTION_GROUPS.flatMap((g) => g.items);
    expect(all.length).toBeGreaterThanOrEqual(8);
    for (const s of all) {
      expect(s.length).toBeGreaterThan(0);
      expect(s.length).toBeLessThanOrEqual(80);
    }
  });

  it("returns fresh arrays so callers cannot mutate shared state", () => {
    const a = declineForVerdict("OUT_OF_SCOPE");
    a.suggestions.push("x");
    expect(declineForVerdict("OUT_OF_SCOPE").suggestions).toHaveLength(3);
  });
});
