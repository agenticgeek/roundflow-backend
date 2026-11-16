import { describe, expect, it } from "vitest";
import { listPayments } from "../list-payments";
import { ctxFor, dec, fakePrisma } from "./fake-prisma";

const p = (createdAt: string, name: string, amount: number, method: string, status: string) => ({
  createdAt: new Date(createdAt), amount: dec(amount), method, status, customer: { name },
});

describe("list_payments", () => {
  it("validates input", () => {
    expect(listPayments.parse({})).toEqual({ status: undefined, method: undefined, from: undefined, to: undefined, limit: 50 });
    expect(listPayments.parse({ status: "FAILED", method: "STRIPE" })).toMatchObject({ status: "FAILED", method: "STRIPE" });
    expect(() => listPayments.parse({ status: "BROKEN" })).toThrow(/must be one of/);
    expect(() => listPayments.parse({ method: "CRYPTO" })).toThrow(/must be one of/);
    expect(() => listPayments.parse({ from: "2026-02-31" })).toThrow(/calendar date/);
    expect(() => listPayments.parse({ to: "x" })).toThrow(/YYYY-MM-DD/);
  });

  it("rejects ranges over 366 days", async () => {
    const { tp } = fakePrisma();
    await expect(listPayments.run({ from: "2025-01-01", to: "2026-11-10", limit: 50 }, ctxFor(tp))).rejects.toThrow(/366 days/);
  });

  it("lists payments newest first with tenant-local dates, totals over every match, and a month-to-date default", async () => {
    const { tp, calls } = fakePrisma({
      "payment.findMany": [p("2026-07-14T23:30:00Z", "Alice", 20.5, "GOCARDLESS", "FAILED"), p("2026-07-10T10:00:00Z", "Bob", 15, "CASH", "PAID")],
      "payment.groupBy": [
        { status: "FAILED", method: "GOCARDLESS", _count: 3, _sum: { amount: dec(61.5) } },
        { status: "PAID", method: "CASH", _count: 1, _sum: { amount: null } },
      ],
    });
    const out = await listPayments.run({ status: "FAILED", method: "GOCARDLESS", limit: 50 }, ctxFor(tp, "2026-07-20T12:00:00Z"));
    expect(out.dateRange).toEqual({ from: "2026-07-01", to: "2026-07-20", label: "1 to 20 Jul 2026" });
    expect(out.rows).toEqual([
      { date: "2026-07-15", customer: "Alice", amount: 20.5, method: "GOCARDLESS", status: "FAILED" },
      { date: "2026-07-10", customer: "Bob", amount: 15, method: "CASH", status: "PAID" },
    ]);
    expect(out.totals).toEqual({
      date: null, customer: "Total", amount: 61.5, method: null, status: null, payments: 4,
      paidAmount: 0, paidCount: 1, failedAmount: 61.5, failedCount: 3, dueAmount: 61.5, collectionRate: 0,
      gocardlessAmount: 61.5, gocardlessCount: 3, stripeAmount: 0, stripeCount: 0, cashAmount: 0, cashCount: 1, chequeAmount: 0, chequeCount: 0, bacsAmount: 0, bacsCount: 0,
    });
    expect((calls.find((c) => c.path === "payment.groupBy")!.args as { by: string[] }).by).toEqual(["status", "method"]);
    expect(out.truncated).toBe(false);
    const fm = calls.find((c) => c.path === "payment.findMany")!.args as { where: Record<string, unknown>; select: Record<string, unknown>; take: number };
    expect(fm.where).toEqual({
      createdAt: { gte: new Date("2026-06-30T23:00:00Z"), lt: new Date("2026-07-20T23:00:00Z") },
      status: "FAILED",
      method: "GOCARDLESS",
    });
    // Only the fixed fields are selected: no provider ids, receipt URLs or references.
    expect(Object.keys(fm.select).sort()).toEqual(["amount", "createdAt", "customer", "method", "status"]);
  });

  it("omits status/method filters when not given and marks truncated beyond the limit", async () => {
    const { tp, calls } = fakePrisma({
      "payment.findMany": [p("2026-11-02T10:00:00Z", "A", 1, "CASH", "PAID"), p("2026-11-01T10:00:00Z", "B", 2, "CASH", "PAID")],
      "payment.groupBy": [{ status: "PAID", method: "CASH", _count: 2, _sum: { amount: dec(3) } }],
    });
    const out = await listPayments.run({ limit: 1 }, ctxFor(tp));
    expect(out.rows).toHaveLength(1);
    expect(out.truncated).toBe(true);
    expect(Object.keys((calls.find((c) => c.path === "payment.findMany")!.args as { where: object }).where)).toEqual(["createdAt"]);
  });

  it("returns null totals when nothing matches", async () => {
    const { tp } = fakePrisma();
    expect(await listPayments.run({ limit: 50 }, ctxFor(tp))).toMatchObject({ rows: [], totals: null, truncated: false });
  });

  it("computes the collection rate over due money only (paid / (all except not-due and cancelled)) and splits by method", async () => {
    const g = (status: string, method: string, n: number, amount: number) => ({ status, method, _count: n, _sum: { amount: dec(amount) } });
    const { tp } = fakePrisma({
      "payment.groupBy": [
        g("PAID", "GOCARDLESS", 10, 300), g("PAID", "STRIPE", 5, 100), g("FAILED", "GOCARDLESS", 2, 40), g("OVERDUE", "BACS", 1, 60),
        g("PENDING", "GOCARDLESS", 4, 100), g("NOT_DUE", "CASH", 3, 999), g("CANCELLED", "CHEQUE", 1, 500),
      ],
    });
    const out = await listPayments.run({ limit: 50 }, ctxFor(tp));
    expect(out.totals).toMatchObject({
      payments: 26, amount: 2099, paidAmount: 400, paidCount: 15, failedAmount: 40, failedCount: 2, dueAmount: 600, collectionRate: 66.67,
      gocardlessAmount: 440, gocardlessCount: 16, stripeAmount: 100, stripeCount: 5, bacsAmount: 60, bacsCount: 1, cashAmount: 999, chequeAmount: 500,
    });
  });

  it("gives a null collection rate (not NaN) when nothing is due yet", async () => {
    const { tp } = fakePrisma({ "payment.groupBy": [{ status: "NOT_DUE", method: "CASH", _count: 2, _sum: { amount: dec(30) } }] });
    const out = await listPayments.run({ limit: 50 }, ctxFor(tp));
    expect(out.totals).toMatchObject({ dueAmount: 0, collectionRate: null, paidAmount: 0 });
  });

  it("describes when not to use it, an example and the output fields", () => {
    expect(listPayments.description).toMatch(/Do NOT use/);
    expect(listPayments.description).toMatch(/Example: \{/);
    expect(listPayments.description).toMatch(/collectionRate/);
  });
});
