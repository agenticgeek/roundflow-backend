import { describe, expect, it } from "vitest";
import { technicianWorkload } from "../technician-workload";
import { ctxFor, fakePrisma } from "./fake-prisma";
import { expectSafe, SECRETS } from "./e2-test-utils";

const d = (day: string) => new Date(`${day}T00:00:00Z`);
const vis = (day: string, technicianId: string | null, roundId: string | null = "r1") => ({ date: d(day), technicianId, roundId, ...SECRETS });

const TECHS = [{ id: "t1", name: "Liam", ...SECRETS }, { id: "t2", name: "Abe" }, { id: "t3", name: null }];
// "today" in ctxFor is 2026-11-10 (London), so the default window is 10 to 16 Nov.
const VISITS = [
  vis("2026-11-10", "t1"), vis("2026-11-10", "t1"), vis("2026-11-11", "t1"),
  vis("2026-11-11", "t2"),
  vis("2026-11-12", null, "r2"), vis("2026-11-12", null, "r2"),
  vis("2026-11-13", "t2", "r2"),
];

describe("technician_workload", () => {
  it("validates input", () => {
    expect(technicianWorkload.parse({})).toEqual({ days: 7, limit: 50 });
    expect(technicianWorkload.parse({ days: 28, limit: 3 })).toEqual({ days: 28, limit: 3 });
    expect(() => technicianWorkload.parse({ days: 29 })).toThrow(/1 to 28/);
    expect(() => technicianWorkload.parse({ days: 0 })).toThrow(/1 to 28/);
    expect(() => technicianWorkload.parse({ days: "7" })).toThrow(/whole number/);
    expect(() => technicianWorkload.parse({ limit: 500 })).toThrow(/1 to 200/);
    expect(() => technicianWorkload.parse({ technicianId: "x" })).toThrow(/Unknown argument/);
    expect(technicianWorkload.name).toBe("technician_workload");
    expect(technicianWorkload.readOnly).toBe(true);
  });

  it("lists stops per technician per day, time off with reason, unassigned visits and rounds with no technician", async () => {
    const fp = fakePrisma({
      "technician.findMany": TECHS,
      "visit.findMany": VISITS,
      "technicianAvailability.findMany": [
        { technicianId: "t2", from: d("2026-11-08"), to: d("2026-11-11"), reason: "Holiday", ...SECRETS }, // starts before the window
        { technicianId: "t2", from: d("2026-11-15"), to: d("2026-11-30"), reason: "  ", ...SECRETS }, // ends after, blank reason
        { technicianId: "t3", from: d("2026-11-12"), to: d("2026-11-12"), reason: null },
      ],
      "round.findMany": [{ id: "r2", name: "Round 2" }, { id: "r9", name: "Round 9" }],
    });
    const out = await technicianWorkload.run({ days: 7, limit: 50 }, ctxFor(fp.tp));
    expect(out.dateRange).toEqual({ from: "2026-11-10", to: "2026-11-16", label: "10 to 16 Nov 2026" });
    expect(out.rows).toEqual([
      { kind: "Technician", technician: "Liam", stops: 3, busiestDay: "2026-11-10", busiestDayStops: 2, daysOff: 0, offDetail: null, byDay: "2026-11-10: 2; 2026-11-11: 1" },
      { kind: "Technician", technician: "Abe", stops: 2, busiestDay: "2026-11-11", busiestDayStops: 1, daysOff: 4, offDetail: "10 to 11 Nov 2026 (Holiday); 15 to 16 Nov 2026", byDay: "2026-11-11: 1; 2026-11-13: 1" },
      { kind: "Technician", technician: "Unnamed technician", stops: 0, busiestDay: null, busiestDayStops: null, daysOff: 1, offDetail: "12 Nov 2026", byDay: null },
      { kind: "Unassigned", technician: "Visits with no technician", stops: 2, busiestDay: null, busiestDayStops: null, daysOff: null, offDetail: null, byDay: null },
      { kind: "Round without technician", technician: "Round 2", stops: 3, busiestDay: null, busiestDayStops: null, daysOff: null, offDetail: null, byDay: null },
      { kind: "Round without technician", technician: "Round 9", stops: 0, busiestDay: null, busiestDayStops: null, daysOff: null, offDetail: null, byDay: null },
    ]);
    expect(out.totals).toMatchObject({ kind: "Total", stops: 7, daysOff: 5, technicians: 3 });
    expect(out.truncated).toBe(false);
    expect(out.columns.map((c) => c.key)).toEqual(["kind", "technician", "stops", "busiestDay", "busiestDayStops", "daysOff", "offDetail", "byDay"]);
    expectSafe(out, fp);
  });

  it("breaks ties by name, honours limit and the days window, and flags truncation", async () => {
    const fp = fakePrisma({ "technician.findMany": [{ id: "a", name: "Zed" }, { id: "b", name: "Amy" }] });
    const out = await technicianWorkload.run({ days: 28, limit: 1 }, ctxFor(fp.tp));
    expect(out.dateRange).toMatchObject({ from: "2026-11-10", to: "2026-12-07" });
    expect(out.rows.map((r) => r.technician)).toEqual(["Amy"]);
    expect(out.truncated).toBe(true);
    const call = fp.calls.find((c) => c.path === "visit.findMany")!.args as { where: { date: { gte: Date; lt: Date } } };
    expect(call.where.date.lt.toISOString()).toBe("2026-12-08T00:00:00.000Z");
  });

  it("returns empty rows and null totals when nothing exists, and flags a capped scan", async () => {
    const fp = fakePrisma();
    expect(await technicianWorkload.run({ days: 7, limit: 50 }, ctxFor(fp.tp))).toMatchObject({ rows: [], totals: null, truncated: false });
    const many = Array.from({ length: 20_001 }, () => vis("2026-11-10", "t1"));
    const big = fakePrisma({ "technician.findMany": TECHS, "visit.findMany": many });
    const out = await technicianWorkload.run({ days: 1, limit: 50 }, ctxFor(big.tp));
    expect(out.truncated).toBe(true);
    expect(out.totals).toMatchObject({ stops: 20_000 });
  });

  it("starts the window on the tenant-local day (Auckland is already on 11 Nov)", async () => {
    const fp = fakePrisma({}, { timezone: "Pacific/Auckland" });
    const out = await technicianWorkload.run({ days: 2, limit: 50 }, ctxFor(fp.tp, "2026-11-10T21:30:00.000Z"));
    expect(out.dateRange).toMatchObject({ from: "2026-11-11", to: "2026-11-12" });
  });
});
