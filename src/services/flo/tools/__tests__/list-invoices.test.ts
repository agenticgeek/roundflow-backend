import { describe, expect, it } from "vitest";
import { listInvoices } from "../list-invoices";
import { ctxFor, dec, fakePrisma, WRITE_METHODS } from "./fake-prisma";

const inv = (n: string, status: string, amount: number, due: string | null, extra: Record<string, unknown> = {}) => ({
  invoiceNumber: `INV-${n}`, amount: dec(amount), status, dueDate: due ? new Date(`${due}T00:00:00Z`) : null, sentToCustomer: status !== "DRAFT", paidAt: null, customer: { name: `Cust ${n}` }, ...extra,
});

const GROUPS = [
  { status: "DRAFT", _count: { _all: 2 }, _sum: { amount: dec(50) } },
  { status: "SENT", _count: 3, _sum: { amount: dec(200.5) } },
  { status: "PAID", _count: { _all: 10 }, _sum: { amount: dec(900) } },
];

describe("list_invoices", () => {
  it("validates input", () => {
    expect(listInvoices.parse({})).toEqual({ status: undefined, notSentToCustomer: false, overdueOnly: false, from: undefined, to: undefined, limit: 50 });
    expect(listInvoices.parse({ status: "SENT", overdueOnly: true, notSentToCustomer: true, from: "2026-10-01", to: "2026-10-31", limit: 5 })).toMatchObject({ status: "SENT", overdueOnly: true, limit: 5 });
    expect(() => listInvoices.parse({ status: "LOST" })).toThrow(/must be one of/);
    expect(() => listInvoices.parse({ overdueOnly: "yes" })).toThrow(/true or false/);
    expect(() => listInvoices.parse({ from: "x" })).toThrow(/YYYY-MM-DD/);
    expect(() => listInvoices.parse({ limit: 500 })).toThrow();
    expect(listInvoices.name).toBe("list_invoices");
  });

  it("lists invoices with days overdue and exact totals per status", async () => {
    const { tp, calls } = fakePrisma({
      "invoice.findMany": [
        inv("1", "SENT", 100, "2026-10-31"),
        inv("2", "SENT", 50.5, null),
        inv("3", "DRAFT", 50, "2026-12-01"),
        inv("4", "PAID", 75, "2026-10-01", { paidAt: new Date("2026-10-05T10:00:00Z") }),
      ],
      "invoice.groupBy": GROUPS,
    });
    const out = await listInvoices.run({ notSentToCustomer: false, overdueOnly: false, limit: 50 }, ctxFor(tp));
    expect(out.rows).toEqual([
      { invoiceNumber: "INV-1", customer: "Cust 1", amount: 100, status: "SENT", dueDate: "2026-10-31", daysOverdue: 10, sentToCustomer: "Yes", paidAt: null },
      { invoiceNumber: "INV-2", customer: "Cust 2", amount: 50.5, status: "SENT", dueDate: null, daysOverdue: null, sentToCustomer: "Yes", paidAt: null },
      { invoiceNumber: "INV-3", customer: "Cust 3", amount: 50, status: "DRAFT", dueDate: "2026-12-01", daysOverdue: null, sentToCustomer: "No", paidAt: null },
      { invoiceNumber: "INV-4", customer: "Cust 4", amount: 75, status: "PAID", dueDate: "2026-10-01", daysOverdue: null, sentToCustomer: "Yes", paidAt: "2026-10-05" },
    ]);
    expect(out.totals).toMatchObject({ invoiceNumber: "Total", amount: 1150.5, invoices: 15, draftCount: 2, draftAmount: 50, sentCount: 3, sentAmount: 200.5, paidCount: 10, paidAmount: 900, voidCount: 0, voidAmount: 0 });
    expect(out.truncated).toBe(false);
    expect(out.dateRange).toBeNull();
    expect(calls.find((c) => c.path === "invoice.findMany")!.args).toMatchObject({ take: 51 });
  });

  it("builds the where clause for overdue, not-sent, status and date filters, and flags truncation", async () => {
    const { tp, calls } = fakePrisma({ "invoice.findMany": [inv("1", "SENT", 1, "2026-10-01"), inv("2", "SENT", 1, "2026-10-02")], "invoice.groupBy": GROUPS });
    const out = await listInvoices.run({ notSentToCustomer: true, overdueOnly: true, from: "2026-10-01", limit: 1 }, ctxFor(tp));
    expect(out.rows).toHaveLength(1);
    expect(out.truncated).toBe(true);
    expect(out.dateRange).toMatchObject({ from: "2026-10-01", to: "2026-11-10" });
    const w = (calls.find((c) => c.path === "invoice.findMany")!.args as { where: Record<string, unknown> }).where;
    expect(w).toMatchObject({ status: "SENT", dueDate: { lt: new Date("2026-11-10T00:00:00Z") }, sentToCustomer: false });
    expect(w.createdAt).toBeDefined();
    const s = await listInvoices.run({ status: "PAID", notSentToCustomer: false, overdueOnly: false, limit: 5 }, ctxFor(tp));
    expect(s.rows.length).toBeGreaterThan(0);
    expect(calls.filter((c) => c.path === "invoice.findMany")[1].args).toMatchObject({ where: { status: "PAID" } });
  });

  it("defaults from to the first of the month of to", async () => {
    const { tp } = fakePrisma();
    expect((await listInvoices.run({ notSentToCustomer: false, overdueOnly: false, to: "2026-10-31", limit: 5 }, ctxFor(tp))).dateRange).toMatchObject({ from: "2026-10-01", to: "2026-10-31" });
  });

  it("overdueOnly with a non-SENT status matches nothing; empty database gives null totals", async () => {
    const { tp, calls } = fakePrisma();
    expect(await listInvoices.run({ status: "PAID", notSentToCustomer: false, overdueOnly: true, limit: 5 }, ctxFor(tp))).toMatchObject({ rows: [], totals: null });
    expect(calls.find((c) => c.path === "invoice.findMany")).toBeUndefined();
    expect(await listInvoices.run({ notSentToCustomer: false, overdueOnly: false, limit: 5 }, ctxFor(tp))).toMatchObject({ rows: [], totals: null, truncated: false });
    await expect(listInvoices.run({ notSentToCustomer: false, overdueOnly: false, from: "2024-01-01", limit: 5 }, ctxFor(tp))).rejects.toThrow(/366 days/);
  });

  it("never writes and exposes no secret-looking keys", async () => {
    const { tp, calls } = fakePrisma({ "invoice.findMany": [inv("1", "SENT", 1, "2026-10-01")], "invoice.groupBy": GROUPS });
    const out = await listInvoices.run({ notSentToCustomer: false, overdueOnly: false, limit: 5 }, ctxFor(tp));
    expect(calls.filter((c) => (WRITE_METHODS as readonly string[]).some((m) => c.path.endsWith(`.${m}`)))).toEqual([]);
    const keys = [...Object.keys(out.rows[0]), ...Object.keys(out.totals ?? {})];
    expect(keys.filter((k) => /bank|token|secret|password|webhook|mandate|stripe|note|body/i.test(k))).toEqual([]);
    expect(JSON.stringify(calls.map((c) => c.args))).not.toMatch(/notes|stripe|gocardless/i);
  });
});
