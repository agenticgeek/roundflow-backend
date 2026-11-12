import { describe, expect, it } from "vitest";
import { compareTechnicians } from "../compare-technicians";
import { ctxFor, dec, fakePrisma } from "./fake-prisma";

const visit = (tech: string, price: number, started?: string, completed?: string) => ({
  technicianId: tech, price: dec(price), startedAt: started ? new Date(started) : null, completedAt: completed ? new Date(completed) : null, _count: { issues: 1 },
});

function world() {
  return fakePrisma({
    "visit.findMany": [
      visit("t1", 100, "2026-10-05T09:00:00Z", "2026-10-05T10:00:00Z"),
      visit("t1", 50.25),
      visit("t2", 200),
    ],
    "visit.groupBy": [{ technicianId: "t1", _count: 2 }, { technicianId: "t3", _count: 4 }],
    "technician.findMany": [
      { id: "t1", name: "James" },
      { id: "t2", name: "Liam" },
      { id: "t3", name: null },
      { id: "t4", name: "Idle" },
    ],
    "technicianIncident.groupBy": [{ technicianId: "t2", type: "STRIKE", _count: 1, _sum: { amount: null } }],
    "complaint.findMany": [{ technicianId: "t2", status: "OPEN", upheld: null, resolvedAt: null, createdAt: new Date("2026-10-06T00:00:00Z") }],
  });
}

describe("compare_technicians", () => {
  it("validates period / from / to", () => {
    expect(compareTechnicians.parse({})).toEqual({ period: undefined, from: undefined, to: undefined });
    expect(compareTechnicians.parse({ period: "lastMonth" })).toMatchObject({ period: "lastMonth" });
    expect(compareTechnicians.parse({ from: "2026-10-01", to: "2026-10-31" })).toMatchObject({ from: "2026-10-01" });
    expect(() => compareTechnicians.parse({ period: "decade" })).toThrow(/must be one of/);
    expect(() => compareTechnicians.parse({ period: "thisMonth", from: "2026-10-01", to: "2026-10-31" })).toThrow(/not both/);
    expect(() => compareTechnicians.parse({ from: "2026-10-01" })).toThrow(/together/);
    expect(() => compareTechnicians.parse({ to: "2026-10-01" })).toThrow(/together/);
    expect(() => compareTechnicians.parse({ from: "2026-02-30", to: "2026-03-01" })).toThrow(/calendar date/);
  });

  it("compares technicians for a named period using the KPI service and adds skipped counts", async () => {
    const { tp, calls } = world();
    const out = await compareTechnicians.run({ period: "lastMonth" }, ctxFor(tp));
    expect(out.dateRange).toEqual({ from: "2026-10-01", to: "2026-10-31", label: "1 to 31 Oct 2026" });
    expect(out.rows).toEqual([
      { technician: "Liam", jobs: 1, skipped: 0, revenue: 200, revenuePerHour: null, issues: 1, complaints: 1, strikes: 1 },
      { technician: "James", jobs: 2, skipped: 2, revenue: 150.25, revenuePerHour: 100, issues: 2, complaints: 0, strikes: 0 },
      { technician: "Idle", jobs: 0, skipped: 0, revenue: 0, revenuePerHour: null, issues: 0, complaints: 0, strikes: 0 },
      { technician: "Unnamed technician", jobs: 0, skipped: 4, revenue: 0, revenuePerHour: null, issues: 0, complaints: 0, strikes: 0 },
    ]);
    expect(out.totals).toEqual({ technician: "Total", jobs: 3, skipped: 6, revenue: 350.25, revenuePerHour: null, issues: 3, complaints: 1, strikes: 1 });
    expect(out.truncated).toBe(false);
    const sk = calls.find((c) => c.path === "visit.groupBy")!.args as { where: { date: { gte: Date; lt: Date } } };
    expect(sk.where.date).toEqual({ gte: new Date("2026-10-01T00:00:00Z"), lt: new Date("2026-11-01T00:00:00Z") });
  });

  it("defaults to thisMonth and computes the month from the tenant-local date (00:30 BST on 1 Nov-like edges)", async () => {
    const { tp } = world();
    // 2026-10-31T23:30Z is 23:30 GMT-less... London is on GMT after 25 Oct, so use summer: 2026-07-31T23:30Z = 00:30 BST on 1 Aug.
    const out = await compareTechnicians.run({}, ctxFor(tp, "2026-07-31T23:30:00Z"));
    expect(out.dateRange).toMatchObject({ from: "2026-08-01", to: "2026-08-31" });
  });

  it("supports an explicit inclusive range and rejects ranges over 366 days", async () => {
    const { tp, calls } = world();
    const out = await compareTechnicians.run({ from: "2026-10-01", to: "2026-10-30" }, ctxFor(tp));
    expect(out.dateRange?.label).toBe("1 to 30 Oct 2026");
    const sk = calls.find((c) => c.path === "visit.groupBy")!.args as { where: { date: { lt: Date } } };
    expect(sk.where.date.lt).toEqual(new Date("2026-10-31T00:00:00Z"));
    await expect(compareTechnicians.run({ from: "2025-01-01", to: "2026-10-30" }, ctxFor(tp))).rejects.toThrow(/366 days/);
  });

  it("returns null totals when there are no technicians", async () => {
    const { tp } = fakePrisma();
    expect(await compareTechnicians.run({ period: "last30" }, ctxFor(tp))).toMatchObject({ rows: [], totals: null });
  });

  it("uses the tenant-local date for yearly ranges too", async () => {
    const { tp } = fakePrisma();
    const out = await compareTechnicians.run({ period: "thisYear" }, ctxFor(tp));
    expect(out.dateRange).toMatchObject({ from: "2026-01-01", to: "2026-12-31" });
  });
});
