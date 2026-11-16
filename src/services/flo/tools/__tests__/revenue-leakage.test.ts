import { describe, expect, it } from "vitest";
import { revenueLeakage } from "../revenue-leakage";
import { ctxFor, dec, fakePrisma, WRITE_METHODS } from "./fake-prisma";

interface Where { status?: unknown; originalPrice?: unknown; invoice?: { is: unknown }; paymentHold?: boolean; carryoverCount?: unknown }

const HANDLERS = {
  "visit.aggregate": (a: { where: Where }) => {
    const w = a.where;
    if (w.originalPrice) return { _count: { _all: 3 }, _sum: { price: dec(80), originalPrice: dec(100) } };
    if (w.status === "SKIPPED") return { _count: { _all: 2 }, _sum: { price: dec(45) } };
    if (w.carryoverCount && typeof w.carryoverCount === "object") return { _count: 1, _sum: { price: dec(30.5) } };
    if (w.invoice?.is === null) return { _count: { _all: 4 }, _sum: { price: dec(120) } };
    if (w.invoice?.is) return { _count: { _all: 5 }, _sum: { price: dec(200) } };
    return { _count: { _all: 1 }, _sum: { price: dec(15) } };
  },
  "visit.groupBy": [
    { priceAdjustmentReason: "Front only", _count: { _all: 2 } },
    { priceAdjustmentReason: null, _count: 1 },
    { priceAdjustmentReason: "Back only", _count: { _all: 2 } },
    { priceAdjustmentReason: "Dog", _count: { _all: 1 } },
    { priceAdjustmentReason: "Rain", _count: { _all: 1 } },
  ],
};

describe("revenue_leakage", () => {
  it("validates input", () => {
    expect(revenueLeakage.parse({})).toEqual({ from: undefined, to: undefined });
    expect(revenueLeakage.parse({ from: "2026-10-01", to: "2026-10-31" })).toEqual({ from: "2026-10-01", to: "2026-10-31" });
    expect(() => revenueLeakage.parse({ from: "soon" })).toThrow(/YYYY-MM-DD/);
    expect(() => revenueLeakage.parse({ x: 1 })).toThrow(/Unknown argument/);
    expect(revenueLeakage.name).toBe("revenue_leakage");
  });

  it("returns one row per leakage category and the total at stake", async () => {
    const { tp, calls } = fakePrisma(HANDLERS);
    const out = await revenueLeakage.run({}, ctxFor(tp));
    expect(out.rows).toEqual([
      { category: "Price adjustments (discounts given)", visits: 3, value: 20, detail: "Back only (2), Front only (2), Dog (1)" },
      { category: "Skipped visits", visits: 2, value: 45, detail: "Value of visits skipped, not earned" },
      { category: "Carried over", visits: 1, value: 30.5, detail: "Visits moved to a later day and not yet done" },
      { category: "Completed, not invoiced", visits: 4, value: 120, detail: "Done but no invoice exists" },
      { category: "Completed, unpaid", visits: 5, value: 200, detail: "Invoice sent, not yet paid" },
      { category: "Payment hold", visits: 1, value: 15, detail: "Open visits held for payment" },
    ]);
    expect(out.totals).toEqual({ category: "Total at stake", visits: 16, value: 430.5, detail: null });
    expect(out.dateRange).toEqual({ from: "2026-11-01", to: "2026-11-10", label: "1 to 10 Nov 2026" });
    expect(out.truncated).toBe(false);
    const held = calls.filter((c) => c.path === "visit.aggregate").map((c) => c.args as { where: Where }).find((a) => a.where.paymentHold);
    expect(held?.where).toMatchObject({ carryoverCount: 0, status: { in: ["SCHEDULED", "IN_PROGRESS"] } });
  });

  it("returns zero rows for an empty business and rejects a bad range", async () => {
    const { tp } = fakePrisma();
    const out = await revenueLeakage.run({ from: "2026-10-01", to: "2026-10-31" }, ctxFor(tp));
    expect(out.rows).toHaveLength(6);
    expect(out.rows.every((r) => r.value === 0 && r.visits === 0)).toBe(true);
    expect(out.rows[0].detail).toBeNull();
    expect(out.totals).toMatchObject({ visits: 0, value: 0 });
    await expect(revenueLeakage.run({ from: "2026-11-05", to: "2026-11-01" }, ctxFor(tp))).rejects.toThrow(/must not be after/);
  });

  it("never writes and exposes no secret-looking keys", async () => {
    const { tp, calls } = fakePrisma(HANDLERS);
    const out = await revenueLeakage.run({}, ctxFor(tp));
    expect(calls.filter((c) => (WRITE_METHODS as readonly string[]).some((m) => c.path.endsWith(`.${m}`)))).toEqual([]);
    expect(JSON.stringify(calls.map((c) => c.args))).not.toMatch(/notes|stripe|gocardless|token|secret/i);
    expect([...Object.keys(out.rows[0]), ...Object.keys(out.totals ?? {})].filter((k) => /bank|token|secret|password|webhook|mandate|stripe|note|body/i.test(k))).toEqual([]);
  });
});
