import { describe, expect, it } from "vitest";
import { getDayOverview } from "../get-day-overview";
import { ctxFor, dec, fakePrisma } from "./fake-prisma";

const v = (status: string, price: number, round: string | null, tech: string | null) => ({
  status, price: dec(price), paymentHold: false, round: round ? { name: round } : null, technician: tech ? { name: tech } : null,
});

describe("get_day_overview", () => {
  it("parses an optional date and rejects bad input", () => {
    expect(getDayOverview.parse(undefined)).toEqual({ date: undefined });
    expect(getDayOverview.parse({ date: "2026-11-09" })).toEqual({ date: "2026-11-09" });
    expect(() => getDayOverview.parse({ date: "2026-13-09" })).toThrow();
    expect(() => getDayOverview.parse({ day: "x" })).toThrow(/Unknown argument/);
  });

  it("summarises a day per round with totals, values in pounds and a tenant-local default date", async () => {
    const { tp, calls } = fakePrisma({
      "visit.findMany": [
        v("COMPLETED", 20.5, "Round 7", "Liam"),
        v("COMPLETED", 30, "Round 7", "Liam"),
        v("SKIPPED", 25, "Round 7", "Ana"),
        v("IN_PROGRESS", 10, "Round 2", "Zed"),
        v("SCHEDULED", 15.25, "Round 2", null),
        v("SCHEDULED", 5, null, null),
      ],
    });
    // 23:30Z on the 9th in summer is already the 10th in London... use a winter instant for clarity
    const out = await getDayOverview.run({}, ctxFor(tp, "2026-11-10T09:00:00Z"));
    expect(out.dateRange).toEqual({ from: "2026-11-10", to: "2026-11-10", label: "10 Nov 2026" });
    expect(out.rows).toEqual([
      { round: "No round", technician: null, total: 1, completed: 0, skipped: 0, inProgress: 0, remaining: 1, scheduledValue: 5, completedValue: 0 },
      { round: "Round 2", technician: "Zed", total: 2, completed: 0, skipped: 0, inProgress: 1, remaining: 2, scheduledValue: 25.25, completedValue: 0 },
      { round: "Round 7", technician: "Ana, Liam", total: 3, completed: 2, skipped: 1, inProgress: 0, remaining: 0, scheduledValue: 75.5, completedValue: 50.5 },
    ]);
    expect(out.totals).toMatchObject({ round: "Total", total: 6, completed: 2, skipped: 1, inProgress: 1, remaining: 3, scheduledValue: 105.75, completedValue: 50.5 });
    expect(out.truncated).toBe(false);
    expect(out.columns.map((c) => c.key)).toEqual(["round", "technician", "total", "completed", "skipped", "inProgress", "remaining", "scheduledValue", "completedValue"]);
    const where = (calls.find((c) => c.path === "visit.findMany")!.args as { where: { date: { gte: Date; lt: Date }; status: unknown } }).where;
    expect(where.date).toEqual({ gte: new Date("2026-11-10T00:00:00Z"), lt: new Date("2026-11-11T00:00:00Z") });
    expect(where.status).toEqual({ not: "CANCELLED" });
  });

  it("uses the requested date, and the tenant-local date when UTC is still the previous day", async () => {
    const a = fakePrisma();
    await getDayOverview.run({ date: "2026-11-09" }, ctxFor(a.tp));
    expect((a.calls.find((c) => c.path === "visit.findMany")!.args as { where: { date: { gte: Date } } }).where.date.gte).toEqual(new Date("2026-11-09T00:00:00Z"));
    const b = fakePrisma();
    const out = await getDayOverview.run({}, ctxFor(b.tp, "2026-07-14T23:30:00Z")); // 00:30 BST on the 15th
    expect(out.dateRange?.from).toBe("2026-07-15");
  });

  it("returns an empty result with null totals when nothing is scheduled", async () => {
    const { tp } = fakePrisma();
    const out = await getDayOverview.run({}, ctxFor(tp));
    expect(out).toMatchObject({ rows: [], totals: null, truncated: false });
  });

  it("flags truncation when more visits than the scan cap exist", async () => {
    const many = Array.from({ length: 20_001 }, () => v("SCHEDULED", 1, "R", null));
    const { tp } = fakePrisma({ "visit.findMany": many });
    const out = await getDayOverview.run({}, ctxFor(tp));
    expect(out.truncated).toBe(true);
    expect(out.totals).toMatchObject({ total: 20_000 });
  });
});
