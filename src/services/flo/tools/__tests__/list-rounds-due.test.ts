import { describe, expect, it } from "vitest";
import { listRoundsDue } from "../list-rounds-due";
import { ctxFor, dec, fakePrisma } from "./fake-prisma";

const g = (roundId: string | null, count: number, price: number | null, min: string | null, max: string | null) => ({
  roundId, _count: count, _sum: { price: price === null ? null : dec(price) }, _min: { date: min ? new Date(min) : null }, _max: { date: max ? new Date(max) : null },
});

describe("list_rounds_due", () => {
  it("validates input", () => {
    expect(listRoundsDue.parse({})).toEqual({ from: undefined, to: undefined, limit: 50 });
    expect(() => listRoundsDue.parse({ from: "nope" })).toThrow(/YYYY-MM-DD/);
    expect(() => listRoundsDue.parse({ limit: 500 })).toThrow(/1 to 200/);
  });

  it("rejects a range over 366 days and from after to", async () => {
    const { tp } = fakePrisma();
    await expect(listRoundsDue.run({ from: "2025-01-01", to: "2026-06-01", limit: 50 }, ctxFor(tp))).rejects.toThrow(/366 days/);
    await expect(listRoundsDue.run({ from: "2026-02-02", to: "2026-02-01", limit: 50 }, ctxFor(tp))).rejects.toThrow(/must not be after/);
  });

  it("lists rounds by value with stops and dates, defaulting to today + 6 days", async () => {
    const { tp, calls } = fakePrisma({
      "visit.groupBy": [
        g("r1", 10, 120.5, "2026-11-10T00:00:00Z", "2026-11-12T00:00:00Z"),
        g("r2", 4, 300, "2026-11-11T00:00:00Z", "2026-11-11T00:00:00Z"),
        g("r3", 2, null, null, null),
        g("gone", 1, 50, "2026-11-13T00:00:00Z", "2026-11-13T00:00:00Z"),
        g(null, 1, 5, null, null),
      ],
      "round.findMany": [{ id: "r1", name: "Round 1" }, { id: "r2", name: "Round 2" }, { id: "r3", name: "A Round" }],
    });
    const out = await listRoundsDue.run({ limit: 50 }, ctxFor(tp));
    expect(out.dateRange).toEqual({ from: "2026-11-10", to: "2026-11-16", label: "10 to 16 Nov 2026" });
    expect(out.rows.map((r) => r.round)).toEqual(["Round 2", "Round 1", "Unknown round", "Unknown round", "A Round"]);
    expect(out.rows[0]).toEqual({ round: "Round 2", stops: 4, value: 300, firstDate: "2026-11-11", lastDate: "2026-11-11" });
    expect(out.rows[4]).toEqual({ round: "A Round", stops: 2, value: 0, firstDate: null, lastDate: null });
    expect(out.totals).toEqual({ round: "Total", rounds: 5, stops: 18, value: 475.5, firstDate: null, lastDate: null });
    const gb = calls.find((c) => c.path === "visit.groupBy")!.args as { where: { status: { in: string[] }; date: { gte: Date; lt: Date } } };
    expect(gb.where.status.in).toEqual(["SCHEDULED", "IN_PROGRESS"]);
    expect(gb.where.date).toEqual({ gte: new Date("2026-11-10T00:00:00Z"), lt: new Date("2026-11-17T00:00:00Z") });
  });

  it("caps rows at the limit and marks truncated; totals still cover everything", async () => {
    const { tp } = fakePrisma({
      "visit.groupBy": [g("a", 1, 1, null, null), g("b", 1, 2, null, null), g("c", 1, 3, null, null)],
      "round.findMany": [{ id: "a", name: "A" }, { id: "b", name: "B" }, { id: "c", name: "C" }],
    });
    const out = await listRoundsDue.run({ from: "2026-11-10", to: "2026-11-12", limit: 2 }, ctxFor(tp));
    expect(out.rows).toHaveLength(2);
    expect(out.truncated).toBe(true);
    expect(out.totals).toMatchObject({ stops: 3, value: 6 });
  });

  it("orders equal values by round name", async () => {
    const { tp } = fakePrisma({
      "visit.groupBy": [g("b", 1, 5, null, null), g("a", 1, 5, null, null)],
      "round.findMany": [{ id: "a", name: "Alpha" }, { id: "b", name: "Bravo" }],
    });
    expect((await listRoundsDue.run({ limit: 50 }, ctxFor(tp))).rows.map((r) => r.round)).toEqual(["Alpha", "Bravo"]);
  });

  it("handles an empty result without a name lookup", async () => {
    const { tp, calls } = fakePrisma();
    const out = await listRoundsDue.run({ limit: 50 }, ctxFor(tp));
    expect(out).toMatchObject({ rows: [], totals: null, truncated: false });
    expect(calls.some((c) => c.path === "round.findMany")).toBe(false);
  });
});
