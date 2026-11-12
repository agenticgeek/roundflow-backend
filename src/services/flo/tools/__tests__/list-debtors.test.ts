import { describe, expect, it } from "vitest";
import { listDebtors } from "../list-debtors";
import { ctxFor, dec, fakePrisma } from "./fake-prisma";

const inv = (id: string, customerId: string, name: string, amount: number, due: string | null, extra: Record<string, unknown> = {}) => ({
  id, invoiceNumber: `INV-${id}`, customerId, amount: dec(amount), dueDate: due ? new Date(`${due}T00:00:00Z`) : null,
  customer: { id: customerId, name, email: null, paymentMethod: "GOCARDLESS", badDebt: false, holdNextClean: false, ...extra },
  visit: { date: new Date(), property: { addressLine: `1 ${name} Road`, postcode: "AB1", roundId: "r", customerId } },
});

const INVOICES = [
  inv("1", "cA", "Alice", 60, "2026-10-01"),
  inv("2", "cA", "Alice", 10, "2026-10-20"),
  inv("3", "cB", "Bob", 30, "2026-11-09", { badDebt: true, paymentMethod: null }),
  { ...inv("4", "cC", "Cara", 15, null), visit: null },
];

describe("list_debtors", () => {
  it("validates input", () => {
    expect(listDebtors.parse({})).toEqual({ minBalance: undefined, minDaysOverdue: undefined, bucket: undefined, limit: 50 });
    expect(listDebtors.parse({ minBalance: 50, minDaysOverdue: 14, bucket: "BAD_DEBT", limit: 5 })).toMatchObject({ minBalance: 50, minDaysOverdue: 14, bucket: "BAD_DEBT" });
    expect(() => listDebtors.parse({ bucket: "EVERYONE" })).toThrow(/must be one of/);
    expect(() => listDebtors.parse({ minBalance: -1 })).toThrow(/number from 0/);
    expect(() => listDebtors.parse({ minDaysOverdue: 1.5 })).toThrow(/whole number/);
    expect(() => listDebtors.parse({ limit: 0 })).toThrow();
  });

  it("scans every invoice bucket, de-duplicates by invoice and sums per customer with days overdue from tenant-local today", async () => {
    const { tp, calls } = fakePrisma({ "invoice.findMany": INVOICES, "invoice.count": 4 });
    const out = await listDebtors.run({ limit: 50 }, ctxFor(tp));
    expect(out.rows).toEqual([
      { customer: "Alice", address: "1 Alice Road", balance: 70, invoices: 2, daysOverdue: 40, oldestDueDate: "2026-10-01", paymentMethod: "GOCARDLESS", flag: null },
      { customer: "Bob", address: "1 Bob Road", balance: 30, invoices: 1, daysOverdue: 1, oldestDueDate: "2026-11-09", paymentMethod: null, flag: "Bad debt" },
      { customer: "Cara", address: "", balance: 15, invoices: 1, daysOverdue: 0, oldestDueDate: null, paymentMethod: "GOCARDLESS", flag: null },
    ]);
    expect(out.totals).toEqual({ customer: "Total", customers: 3, address: null, balance: 115, invoices: 4, daysOverdue: null, oldestDueDate: null, paymentMethod: null, flag: null });
    expect(out).toMatchObject({ dateRange: null, truncated: false });
    expect(calls.filter((c) => c.path === "invoice.findMany")).toHaveLength(6);
  });

  it("filters by minBalance and minDaysOverdue", async () => {
    const { tp } = fakePrisma({ "invoice.findMany": INVOICES, "invoice.count": 4 });
    expect((await listDebtors.run({ minBalance: 50, limit: 50 }, ctxFor(tp))).rows.map((r) => r.customer)).toEqual(["Alice"]);
    expect((await listDebtors.run({ minDaysOverdue: 20, limit: 50 }, ctxFor(tp))).rows.map((r) => r.customer)).toEqual(["Alice"]);
    expect((await listDebtors.run({ minBalance: 20, minDaysOverdue: 1, limit: 50 }, ctxFor(tp))).rows.map((r) => r.customer)).toEqual(["Alice", "Bob"]);
    const none = await listDebtors.run({ minBalance: 5000, limit: 50 }, ctxFor(tp));
    expect(none).toMatchObject({ rows: [], totals: null, truncated: false });
  });

  it("uses a single bucket when asked and marks truncated when the board has more than two pages", async () => {
    const { tp, calls } = fakePrisma({ "invoice.findMany": INVOICES, "invoice.count": 450 });
    const out = await listDebtors.run({ bucket: "SEVEN_DAYS_OVER", limit: 50 }, ctxFor(tp));
    expect(out.truncated).toBe(true);
    expect(calls.filter((c) => c.path === "invoice.findMany")).toHaveLength(2);
  });

  it("orders equal balances by customer name", async () => {
    const { tp } = fakePrisma({ "invoice.findMany": [inv("7", "cZ", "Zed", 20, null), inv("8", "cA", "Abe", 20, null)], "invoice.count": 2 });
    expect((await listDebtors.run({ limit: 50, bucket: "ALL" }, ctxFor(tp))).rows.map((r) => r.customer)).toEqual(["Abe", "Zed"]);
  });

  it("caps rows at the limit; totals cover all matches", async () => {
    const { tp } = fakePrisma({ "invoice.findMany": INVOICES, "invoice.count": 4 });
    const out = await listDebtors.run({ limit: 1, bucket: "ALL" }, ctxFor(tp));
    expect(out.rows).toHaveLength(1);
    expect(out.truncated).toBe(true);
    expect(out.totals).toMatchObject({ customers: 3, balance: 115 });
  });

  it("lists held customers (customer-level rows, including one with no invoice)", async () => {
    const held = [
      { id: "cH", name: "Hal", paymentMethod: "CASH", badDebt: false, holdNextClean: true, properties: [{ addressLine: "9 Hold St", postcode: "H1" }],
        invoices: [{ id: "i9", invoiceNumber: "INV-9", amount: dec(40), dueDate: new Date("2026-11-01T00:00:00Z") }, { id: "i10", invoiceNumber: "INV-10", amount: dec(5), dueDate: null }] },
      { id: "cZ", name: "Zoe", paymentMethod: null, badDebt: false, holdNextClean: true, properties: [], invoices: [] },
    ];
    const { tp } = fakePrisma({ "customer.findMany": held, "customer.count": 2 });
    const out = await listDebtors.run({ bucket: "ON_HOLD", limit: 50 }, ctxFor(tp));
    expect(out.rows).toEqual([
      { customer: "Hal", address: "9 Hold St", balance: 45, invoices: 1, daysOverdue: 9, oldestDueDate: "2026-11-01", paymentMethod: "CASH", flag: "On hold" },
      { customer: "Zoe", address: "", balance: 0, invoices: 0, daysOverdue: 0, oldestDueDate: null, paymentMethod: null, flag: "On hold" },
    ]);
  });
});
