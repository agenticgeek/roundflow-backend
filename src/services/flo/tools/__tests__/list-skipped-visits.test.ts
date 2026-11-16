import { describe, expect, it } from "vitest";
import { listSkippedVisits } from "../list-skipped-visits";
import { ctxFor, fakePrisma } from "./fake-prisma";

const s = (over: Record<string, unknown> = {}) => ({
  date: new Date("2026-11-05T00:00:00Z"), skipReason: "No access", round: { name: "Round 7" }, technician: { name: "Liam" },
  property: { addressLine: "12 Oak Road", customer: { name: "Mrs Smith" } }, ...over,
});

describe("list_skipped_visits", () => {
  it("validates input", () => {
    expect(listSkippedVisits.parse({})).toEqual({ from: undefined, to: undefined, roundId: undefined, roundName: undefined, limit: 50 });
    expect(listSkippedVisits.parse({ roundId: "abc123", roundName: " Round 7 " })).toMatchObject({ roundId: "abc123", roundName: "Round 7" });
    expect(() => listSkippedVisits.parse({ roundId: "a b" })).toThrow(/not a valid id/);
    expect(() => listSkippedVisits.parse({ roundName: "x".repeat(81) })).toThrow(/at most 80/);
    expect(() => listSkippedVisits.parse({ from: "x" })).toThrow();
  });

  it("lists skipped visits with reasons; defaults to this month so far", async () => {
    const { tp, calls } = fakePrisma({
      "visit.count": 2,
      "visit.groupBy": (a: { by: string[] }) => (a.by[0] === "skipReason" ? [{ skipReason: "No access", _count: 1 }, { skipReason: null, _count: 1 }] : [{ roundId: "r7", _count: 1 }, { roundId: null, _count: 1 }]),
      "round.findMany": [{ id: "r7", name: "Round 7" }],
      "visit.findMany": [s(), s({ round: null, technician: null, skipReason: null, date: new Date("2026-11-03T00:00:00Z") })],
    });
    const out = await listSkippedVisits.run({ limit: 50 }, ctxFor(tp));
    expect(out.dateRange).toEqual({ from: "2026-11-01", to: "2026-11-10", label: "1 to 10 Nov 2026" });
    expect(out.rows).toEqual([
      { date: "2026-11-05", round: "Round 7", customer: "Mrs Smith", address: "12 Oak Road", technician: "Liam", reason: "No access" },
      { date: "2026-11-03", round: null, customer: "Mrs Smith", address: "12 Oak Road", technician: null, reason: null },
    ]);
    expect(out.totals).toEqual({
      date: null, round: "Total", skipped: 2,
      byReason: "No access: 1; No reason given: 1", topReason: "No access", topReasonCount: 1,
      byRound: "No round: 1; Round 7: 1", topRound: "No round", topRoundCount: 1,
    });
    expect(out.columns.map((c) => c.key)).toEqual(["date", "round", "customer", "address", "technician", "reason"]);
    expect(out.truncated).toBe(false);
    const fm = calls.find((c) => c.path === "visit.findMany")!.args as { where: Record<string, unknown> };
    expect(fm.where).toEqual({ status: "SKIPPED", date: { gte: new Date("2026-11-01T00:00:00Z"), lt: new Date("2026-11-11T00:00:00Z") } });
  });

  it("filters by round name (contains, case-insensitive)", async () => {
    const { tp, calls } = fakePrisma({ "visit.count": 1, "visit.findMany": [s()] });
    await listSkippedVisits.run({ roundName: "Round 7", limit: 10 }, ctxFor(tp));
    const fm = calls.find((c) => c.path === "visit.findMany")!.args as { where: { round: unknown }; take: number };
    expect(fm.where.round).toEqual({ name: { contains: "Round 7", mode: "insensitive" } });
    expect(fm.take).toBe(10);
  });

  it("resolves a round id through the tenant client; an unknown id (another tenant's) is not found", async () => {
    const own = fakePrisma({ "round.findUnique": { id: "r7" }, "visit.count": 0 });
    const out = await listSkippedVisits.run({ roundId: "r7", limit: 50 }, ctxFor(own.tp));
    expect((own.calls.find((c) => c.path === "visit.findMany")!.args as { where: { roundId: string } }).where.roundId).toBe("r7");
    expect(out).toMatchObject({ rows: [], totals: null });
    const other = fakePrisma({ "round.findUnique": null });
    await expect(listSkippedVisits.run({ roundId: "foreign-round", limit: 50 }, ctxFor(other.tp))).rejects.toThrow("Round not found");
    expect(other.calls.some((c) => c.path === "visit.findMany")).toBe(false);
  });

  it("rejects ranges over 366 days and flags truncation by the total", async () => {
    const { tp } = fakePrisma({ "visit.count": 90, "visit.findMany": [s()] });
    await expect(listSkippedVisits.run({ from: "2025-01-01", to: "2026-06-01", limit: 50 }, ctxFor(tp))).rejects.toThrow(/366 days/);
    expect((await listSkippedVisits.run({ limit: 1 }, ctxFor(tp))).truncated).toBe(true);
  });

  it("totals by reason and by round are exact over every match, merging blank reasons and unknown rounds", async () => {
    const { tp, calls } = fakePrisma({
      "visit.count": 60,
      "visit.groupBy": (a: { by: string[] }) =>
        a.by[0] === "skipReason"
          ? [{ skipReason: "Gate locked", _count: 30 }, { skipReason: "  ", _count: 5 }, { skipReason: null, _count: 5 }, { skipReason: "Weather", _count: 20 }]
          : [{ roundId: "r1", _count: 35 }, { roundId: "gone", _count: 25 }],
      "round.findMany": [{ id: "r1", name: "Round 1" }],
      "visit.findMany": [s()],
    });
    const out = await listSkippedVisits.run({ limit: 1 }, ctxFor(tp));
    expect(out.truncated).toBe(true);
    expect(out.totals).toMatchObject({
      skipped: 60, byReason: "Gate locked: 30; Weather: 20; No reason given: 10", topReason: "Gate locked", topReasonCount: 30,
      byRound: "Round 1: 35; Unknown round: 25", topRound: "Round 1", topRoundCount: 35,
    });
    const g = calls.filter((c) => c.path === "visit.groupBy").map((c) => (c.args as { by: string[] }).by[0]);
    expect(g.sort()).toEqual(["roundId", "skipReason"]);
  });

  it("describes when not to use it, an example and the totals", () => {
    expect(listSkippedVisits.description).toMatch(/Do NOT use/);
    expect(listSkippedVisits.description).toMatch(/Example: \{/);
    expect(listSkippedVisits.description).toMatch(/byReason/);
  });
});
