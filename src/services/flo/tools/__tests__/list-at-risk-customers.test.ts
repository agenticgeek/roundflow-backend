import { describe, expect, it } from "vitest";
import { listAtRiskCustomers } from "../list-at-risk-customers";
import { ctxFor, fakePrisma } from "./fake-prisma";

const v = (propertyId: string, customer: string, date: string, status: string, skipReason: string | null = null) => ({
  propertyId, date: new Date(`${date}T00:00:00Z`), status, skipReason, property: { addressLine: `${propertyId} High St`, customer: { name: customer } },
});

const VISITS = [
  // P1: skipped twice in a row, then a completed clean, then another skip (older skip must not count)
  v("P1", "Alice", "2026-11-05", "SKIPPED", "No access"),
  v("P1", "Alice", "2026-10-20", "SKIPPED", "Gate locked"),
  v("P1", "Alice", "2026-10-01", "COMPLETED"),
  v("P1", "Alice", "2026-09-01", "SKIPPED"),
  // P2: latest visit completed, so the streak is 0
  v("P2", "Bob", "2026-11-04", "COMPLETED"),
  v("P2", "Bob", "2026-10-20", "SKIPPED"),
  v("P2", "Bob", "2026-10-01", "SKIPPED"),
  // P3: three in a row
  v("P3", "Cara", "2026-11-01", "SKIPPED", null),
  v("P3", "Cara", "2026-10-15", "SKIPPED"),
  v("P3", "Cara", "2026-10-01", "SKIPPED"),
  // P4: one skip only
  v("P4", "Dan", "2026-11-02", "SKIPPED"),
  // P5: two skips, same last date as P1, name sorts first -> tie-break by customer
  v("P5", "Aaron", "2026-11-05", "SKIPPED"),
  v("P5", "Aaron", "2026-10-02", "SKIPPED"),
  // P6: two skips, older
  v("P6", "Zed", "2026-09-10", "SKIPPED"),
  v("P6", "Zed", "2026-09-01", "SKIPPED"),
];

describe("list_at_risk_customers", () => {
  it("validates input", () => {
    expect(listAtRiskCustomers.parse({})).toEqual({ minConsecutiveSkips: 2, since: undefined, limit: 50 });
    expect(listAtRiskCustomers.parse({ minConsecutiveSkips: 3, since: "2026-06-01" })).toMatchObject({ minConsecutiveSkips: 3, since: "2026-06-01" });
    expect(() => listAtRiskCustomers.parse({ minConsecutiveSkips: 1 })).toThrow(/2 to 10/);
    expect(() => listAtRiskCustomers.parse({ minConsecutiveSkips: 11 })).toThrow(/2 to 10/);
    expect(() => listAtRiskCustomers.parse({ since: "soon" })).toThrow(/YYYY-MM-DD/);
  });

  it("finds properties whose latest visits were skipped N times in a row", async () => {
    const { tp, calls } = fakePrisma({ "visit.findMany": VISITS });
    const out = await listAtRiskCustomers.run({ minConsecutiveSkips: 2, limit: 50 }, ctxFor(tp));
    expect(out.rows).toEqual([
      { customer: "Cara", address: "P3 High St", skips: 3, lastSkipped: "2026-11-01", reason: null },
      { customer: "Aaron", address: "P5 High St", skips: 2, lastSkipped: "2026-11-05", reason: null },
      { customer: "Alice", address: "P1 High St", skips: 2, lastSkipped: "2026-11-05", reason: "No access" },
      { customer: "Zed", address: "P6 High St", skips: 2, lastSkipped: "2026-09-10", reason: null },
    ]);
    expect(out.totals).toEqual({ customer: "Total", customers: 4 });
    expect(out.dateRange).toEqual({ from: "2026-05-14", to: "2026-11-10", label: "14 May to 10 Nov 2026" });
    expect(out.truncated).toBe(false);
    const q = calls.find((c) => c.path === "visit.findMany")!.args as { where: { status: { in: string[] }; date: { gte: Date; lt: Date } } };
    expect(q.where.status.in).toEqual(["COMPLETED", "SKIPPED"]);
    expect(q.where.date.gte).toEqual(new Date("2026-05-14T00:00:00Z"));
  });

  it("honours a higher minimum and the limit", async () => {
    const { tp } = fakePrisma({ "visit.findMany": VISITS });
    expect((await listAtRiskCustomers.run({ minConsecutiveSkips: 3, limit: 50 }, ctxFor(tp))).rows.map((r) => r.customer)).toEqual(["Cara"]);
    const out = await listAtRiskCustomers.run({ minConsecutiveSkips: 2, limit: 1 }, ctxFor(tp));
    expect(out.rows).toHaveLength(1);
    expect(out.truncated).toBe(true);
  });

  it("rejects a look-back over 366 days or a future start", async () => {
    const { tp } = fakePrisma();
    await expect(listAtRiskCustomers.run({ minConsecutiveSkips: 2, since: "2025-01-01", limit: 50 }, ctxFor(tp))).rejects.toThrow(/366 days/);
    await expect(listAtRiskCustomers.run({ minConsecutiveSkips: 2, since: "2027-01-01", limit: 50 }, ctxFor(tp))).rejects.toThrow(/must not be after/);
  });

  it("returns null totals when nothing is at risk and flags a truncated scan", async () => {
    const empty = fakePrisma();
    expect(await listAtRiskCustomers.run({ minConsecutiveSkips: 2, limit: 50 }, ctxFor(empty.tp))).toMatchObject({ rows: [], totals: null, truncated: false });
    const many = Array.from({ length: 20_001 }, (_, i) => v(`Q${i}`, "X", "2026-11-01", "COMPLETED"));
    const big = fakePrisma({ "visit.findMany": many });
    expect((await listAtRiskCustomers.run({ minConsecutiveSkips: 2, limit: 50 }, ctxFor(big.tp))).truncated).toBe(true);
  });
});
