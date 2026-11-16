import { describe, expect, it } from "vitest";
import { getBusinessSnapshot } from "../get-business-snapshot";
import { ctxFor, dec, fakePrisma, WRITE_METHODS } from "./fake-prisma";

const sv = (propertyId: string, customerId: string, status: string, date: string) => ({
  propertyId, date: new Date(`${date}T00:00:00Z`), status, skipReason: null, property: { customerId, addressLine: "1 Road", customer: { name: customerId } },
});

const HANDLERS = {
  "visit.groupBy": [
    { status: "COMPLETED", _count: { _all: 6 } },
    { status: "SKIPPED", _count: { _all: 1 } },
    { status: "SCHEDULED", _count: { _all: 2 } },
    { status: "IN_PROGRESS", _count: 1 },
    { status: "CANCELLED", _count: 4 },
  ],
  "visit.aggregate": (a: { where: { date: { gte: Date } } }) => ({ _sum: { price: dec(a.where.date.gte.getUTCMonth() === 10 ? 1500 : 1200) } }),
  "invoice.aggregate": (a: { where: { dueDate?: unknown } }) => ({ _sum: { amount: dec(a.where.dueDate ? 100 : 400) } }),
  "invoice.groupBy": [{ customerId: "a" }, { customerId: "b" }, { customerId: "c" }],
  "complaint.groupBy": [{ severity: "HIGH", _count: { _all: 1 } }, { severity: "LOW", _count: 2 }],
  "payment.aggregate": { _sum: { amount: dec(45.5) }, _count: { _all: 3 } },
  "visit.findMany": [
    sv("p1", "c1", "SKIPPED", "2026-11-05"), sv("p1", "c1", "SKIPPED", "2026-10-20"),
    sv("p2", "c1", "SKIPPED", "2026-11-04"), sv("p2", "c1", "SKIPPED", "2026-11-01"), // same customer, still one
    sv("p3", "c2", "SKIPPED", "2026-11-04"), sv("p3", "c2", "COMPLETED", "2026-10-04"),
  ],
  "visit.count": 7,
};

describe("get_business_snapshot", () => {
  it("takes no arguments", () => {
    expect(getBusinessSnapshot.parse(undefined)).toEqual({});
    expect(() => getBusinessSnapshot.parse({ x: 1 })).toThrow(/Unknown argument/);
    expect(getBusinessSnapshot.name).toBe("get_business_snapshot");
    expect(getBusinessSnapshot.readOnly).toBe(true);
  });

  it("returns one wide row of headline figures, repeated in totals", async () => {
    const { tp, calls } = fakePrisma(HANDLERS);
    const out = await getBusinessSnapshot.run({}, ctxFor(tp));
    expect(out.rows).toHaveLength(1);
    expect(out.rows[0]).toEqual({
      todayStops: 10, todayCompleted: 6, todaySkipped: 1, todayRemaining: 3, todayCompletionRate: 60,
      monthRevenue: 1500, previousMonthRevenue: 1200, revenueChange: 300, revenueChangePercent: 25,
      totalOwed: 400, customersOwing: 3, owedOver30Days: 100, shareOver30Days: 25,
      openComplaintsHigh: 1, openComplaintsMedium: 0, openComplaintsLow: 2, openComplaintsTotal: 3,
      failedPaymentsCount: 3, failedPaymentsAmount: 45.5, customersSkippedTwice: 1, visitsCarriedOver: 7,
    });
    expect(out.totals).toEqual(out.rows[0]);
    expect(Object.keys(out.rows[0])).toEqual(out.columns.map((c) => c.key));
    expect(out.dateRange).toEqual({ from: "2026-11-01", to: "2026-11-10", label: "1 to 10 Nov 2026" });
    expect(out.truncated).toBe(false);
    const prev = calls.filter((c) => c.path === "visit.aggregate")[1].args as { where: { date: { gte: Date; lt: Date } } };
    expect(prev.where.date.gte).toEqual(new Date("2026-10-01T00:00:00Z"));
    expect(prev.where.date.lt).toEqual(new Date("2026-10-11T00:00:00Z"));
  });

  it("handles an empty business without dividing by zero", async () => {
    const { tp } = fakePrisma();
    const out = await getBusinessSnapshot.run({}, ctxFor(tp));
    expect(out.rows[0]).toMatchObject({ todayStops: 0, todayCompletionRate: null, monthRevenue: 0, revenueChangePercent: null, totalOwed: 0, shareOver30Days: null, customersOwing: 0, openComplaintsTotal: 0, failedPaymentsCount: 0 });
  });

  it("flags a truncated skip scan", async () => {
    const many = Array.from({ length: 20_001 }, (_, i) => sv(`q${i}`, `c${i}`, "COMPLETED", "2026-11-01"));
    const { tp } = fakePrisma({ "visit.findMany": many });
    expect((await getBusinessSnapshot.run({}, ctxFor(tp))).truncated).toBe(true);
  });

  it("never writes and exposes no secret-looking keys", async () => {
    const { tp, calls } = fakePrisma(HANDLERS);
    const out = await getBusinessSnapshot.run({}, ctxFor(tp));
    expect(calls.filter((c) => (WRITE_METHODS as readonly string[]).some((m) => c.path.endsWith(`.${m}`)))).toEqual([]);
    expect(Object.keys(out.rows[0]).filter((k) => /bank|token|secret|password|webhook|mandate|stripe|note|body/i.test(k))).toEqual([]);
  });

  it("a write attempt would be blocked by the fake client", () => {
    const { tp } = fakePrisma();
    expect(() => (tp as unknown as { visit: { update: () => void } }).visit.update()).toThrow(/WRITE BLOCKED/);
  });
});
