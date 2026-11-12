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
      "visit.findMany": [s(), s({ round: null, technician: null, skipReason: null, date: new Date("2026-11-03T00:00:00Z") })],
    });
    const out = await listSkippedVisits.run({ limit: 50 }, ctxFor(tp));
    expect(out.dateRange).toEqual({ from: "2026-11-01", to: "2026-11-10", label: "1 to 10 Nov 2026" });
    expect(out.rows).toEqual([
      { date: "2026-11-05", round: "Round 7", customer: "Mrs Smith", address: "12 Oak Road", technician: "Liam", reason: "No access" },
      { date: "2026-11-03", round: null, customer: "Mrs Smith", address: "12 Oak Road", technician: null, reason: null },
    ]);
    expect(out.totals).toEqual({ date: null, round: "Total", skipped: 2 });
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
});
