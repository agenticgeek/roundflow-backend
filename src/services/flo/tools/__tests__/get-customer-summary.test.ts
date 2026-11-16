import { describe, expect, it } from "vitest";
import { getCustomerSummary } from "../get-customer-summary";
import { ctxFor, dec, fakePrisma } from "./fake-prisma";

const cust = (id: string, name: string, address: string | null, extra: Record<string, unknown> = {}) => ({
  id, name, status: "ACTIVE", paymentMethod: null, gocardlessMandateStatus: null, holdNextClean: false, holdReason: null, properties: address ? [{ addressLine: address }] : [], ...extra,
});
const NEW_KEYS = ["planPrice", "planFrequency", "activePlans", "paymentMethod", "directDebitStatus", "holdReason", "openComplaints", "lastPaymentDate", "properties", "lifetimeValue"];

describe("get_customer_summary", () => {
  it("validates the query", () => {
    expect(getCustomerSummary.parse({ query: "  Mrs Smith " })).toEqual({ query: "Mrs Smith" });
    expect(() => getCustomerSummary.parse({})).toThrow(/"query" is required/);
    expect(() => getCustomerSummary.parse({ query: "   " })).toThrow(/is required/);
    expect(() => getCustomerSummary.parse({ query: "x".repeat(81) })).toThrow(/at most 80/);
    expect(() => getCustomerSummary.parse({ query: "a", extra: 1 })).toThrow(/Unknown argument/);
  });

  it("returns an empty list when nobody matches (0 matches)", async () => {
    const { tp } = fakePrisma();
    const out = await getCustomerSummary.run({ query: "Nobody" }, ctxFor(tp));
    expect(out).toMatchObject({ rows: [], totals: { customer: "Total", matches: 0 }, truncated: false });
    expect(out.columns.map((c) => c.key)).toEqual(["customer", "address", "id"]);
  });

  it("returns a disambiguation list instead of guessing (2+ matches)", async () => {
    const { tp, calls } = fakePrisma({ "customer.findMany": [cust("c1", "Ann Smith", "1 Oak Road"), cust("c2", "Bea Smith", null)] });
    const out = await getCustomerSummary.run({ query: "Mrs Smith" }, ctxFor(tp));
    expect(out.rows).toEqual([
      { customer: "Ann Smith", address: "1 Oak Road", id: "c1" },
      { customer: "Bea Smith", address: null, id: "c2" },
    ]);
    expect(out.totals).toEqual({ customer: "Total", matches: 2 });
    expect(out.truncated).toBe(false);
    // Only the invoice-free lookup ran: no balance or visit queries for an ambiguous name.
    expect(calls.map((c) => c.path).filter((p) => p !== "businessSettings.findFirst")).toEqual(["customer.findMany"]);
    const where = (calls.find((c) => c.path === "customer.findMany")!.args as { where: { OR: unknown[] }; take: number });
    expect(where.take).toBe(6);
    expect(where.where.OR[0]).toEqual({ AND: [{ name: { contains: "Smith", mode: "insensitive" } }] });
    expect(where.where.OR[1]).toEqual({ properties: { some: { addressLine: { contains: "Mrs Smith", mode: "insensitive" } } } });
  });

  it("caps the disambiguation list at 5 and says it is truncated", async () => {
    const six = ["a", "b", "c", "d", "e", "f"].map((x) => cust(x, `Smith ${x}`, "Road"));
    const { tp } = fakePrisma({ "customer.findMany": six });
    const out = await getCustomerSummary.run({ query: "Smith" }, ctxFor(tp));
    expect(out.rows).toHaveLength(5);
    expect(out.truncated).toBe(true);
  });

  it("summarises one customer: balance, days overdue, last and next clean, recent skips", async () => {
    const { tp, calls } = fakePrisma({
      "customer.findMany": [cust("c1", "Margaret Smith", "1 Oak Road")],
      "invoice.findMany": [
        { amount: dec(60), dueDate: new Date("2026-10-20T00:00:00Z") },
        { amount: dec(25.5), dueDate: new Date("2026-10-01T00:00:00Z") },
        { amount: dec(10), dueDate: null },
      ],
      "visit.findFirst": (a: { where: { status: string } }) => (a.where.status === "COMPLETED" ? { date: new Date("2026-10-15T00:00:00Z") } : { date: new Date("2026-11-20T00:00:00Z") }),
      "visit.count": 2,
    });
    const out = await getCustomerSummary.run({ query: "Mrs Smith" }, ctxFor(tp));
    expect(out.rows).toEqual([
      { customer: "Margaret Smith", address: "1 Oak Road", balance: 95.5, invoices: 3, daysOverdue: 40, lastClean: "2026-10-15", nextClean: "2026-11-20", recentSkips: 2, status: "ACTIVE",
        planPrice: null, planFrequency: null, activePlans: 0, paymentMethod: null, directDebitStatus: null, holdReason: null, openComplaints: 0, lastPaymentDate: null, properties: 0, lifetimeValue: 0 },
    ]);
    expect(out.columns.map((c) => c.key)).toEqual(["customer", "address", "balance", "invoices", "daysOverdue", "lastClean", "nextClean", "recentSkips", "status", ...NEW_KEYS]);
    expect(out).toMatchObject({ totals: null, truncated: false, dateRange: null });
    const inv = calls.find((c) => c.path === "invoice.findMany")!.args as { where: Record<string, unknown> };
    expect(inv.where).toMatchObject({ customerId: "c1", status: "SENT" });
    const cnt = calls.find((c) => c.path === "visit.count")!.args as { where: { status: string; date: { gte: Date } } };
    expect(cnt.where.status).toBe("SKIPPED");
    expect(cnt.where.date.gte).toEqual(new Date("2026-08-12T00:00:00Z"));
  });

  it("summarises a customer with no invoices, no visits and no property", async () => {
    const { tp } = fakePrisma({ "customer.findMany": [cust("c9", "New Person", null)] });
    const out = await getCustomerSummary.run({ query: "14 Elm Street" }, ctxFor(tp));
    expect(out.rows[0]).toEqual({ customer: "New Person", address: null, balance: 0, invoices: 0, daysOverdue: 0, lastClean: null, nextClean: null, recentSkips: 0, status: "ACTIVE",
      planPrice: null, planFrequency: null, activePlans: 0, paymentMethod: null, directDebitStatus: null, holdReason: null, openComplaints: 0, lastPaymentDate: null, properties: 0, lifetimeValue: 0 });
  });

  it("matches by address alone when the query is only an honorific", async () => {
    const { tp, calls } = fakePrisma();
    await getCustomerSummary.run({ query: "Mrs." }, ctxFor(tp));
    const where = (calls.find((c) => c.path === "customer.findMany")!.args as { where: { OR: unknown[] } }).where;
    expect(where.OR).toHaveLength(1);
  });

  it("adds plan price and frequency, payment method, direct debit status, hold reason, open complaints, last payment, property count and lifetime value", async () => {
    const { tp, calls } = fakePrisma({
      "customer.findMany": [cust("c1", "Margaret Smith", "1 Oak Road", { paymentMethod: "GOCARDLESS", gocardlessMandateStatus: "active", holdNextClean: true, holdReason: "Unpaid invoice" })],
      "servicePlan.findMany": [
        { price: dec(25.5), cleaningFrequency: "FOUR_WEEKLY" },
        { price: dec(30), cleaningFrequency: "EIGHT_WEEKLY" },
        { price: dec(10), cleaningFrequency: "FOUR_WEEKLY" },
        { price: dec(5), cleaningFrequency: null },
      ],
      "complaint.count": 2,
      "payment.findFirst": { paidAt: new Date("2026-07-14T23:30:00Z"), createdAt: new Date("2026-07-01T00:00:00Z") }, // 00:30 BST on the 15th
      "property.count": 3,
      "visit.aggregate": { _sum: { price: dec(1234.5) }, _count: 40 },
    });
    const out = await getCustomerSummary.run({ query: "Mrs Smith" }, ctxFor(tp));
    expect(out.rows[0]).toMatchObject({
      planPrice: 70.5, planFrequency: "EIGHT_WEEKLY, FOUR_WEEKLY", activePlans: 4, paymentMethod: "GOCARDLESS", directDebitStatus: "active",
      holdReason: "Unpaid invoice", openComplaints: 2, lastPaymentDate: "2026-07-15", properties: 3, lifetimeValue: 1234.5,
    });
    expect(Object.keys(out.rows[0])).toEqual(out.columns.map((c) => c.key));
    expect((calls.find((c) => c.path === "servicePlan.findMany")!.args as { where: unknown }).where).toEqual({ property: { customerId: "c1" }, status: "ACTIVE" });
    expect((calls.find((c) => c.path === "complaint.count")!.args as { where: unknown }).where).toEqual({ customerId: "c1", status: { not: "RESOLVED" } });
    expect((calls.find((c) => c.path === "payment.findFirst")!.args as { where: unknown }).where).toEqual({ customerId: "c1", status: "PAID" });
  });

  it("never exposes mandate or provider ids and never selects notes", async () => {
    const { tp, calls } = fakePrisma({ "customer.findMany": [cust("c1", "Margaret Smith", "1 Oak Road", { gocardlessMandateId: "MD-SECRET", stripeCustomerId: "cus_SECRET" })] });
    const out = await getCustomerSummary.run({ query: "Mrs Smith" }, ctxFor(tp));
    expect(JSON.stringify(out)).not.toMatch(/SECRET/);
    const selected = JSON.stringify(calls.map((c) => c.args));
    expect(selected).not.toMatch(/gocardlessMandateId|stripeCustomerId|accessNotes|riskNotes|"notes"/);
  });

  it("explains an unexplained hold, falls back to the payment's creation date and reports no hold otherwise", async () => {
    const held = fakePrisma({
      "customer.findMany": [cust("c1", "A B", null, { holdNextClean: true })],
      "payment.findFirst": { paidAt: null, createdAt: new Date("2026-10-02T10:00:00Z") },
    });
    const out = await getCustomerSummary.run({ query: "A B" }, ctxFor(held.tp));
    expect(out.rows[0]).toMatchObject({ holdReason: "On hold (no reason recorded)", lastPaymentDate: "2026-10-02" });
    const free = fakePrisma({ "customer.findMany": [cust("c2", "C D", null, { holdReason: "stale reason" })] });
    expect((await getCustomerSummary.run({ query: "C D" }, ctxFor(free.tp))).rows[0]).toMatchObject({ holdReason: null });
  });

  it("describes when not to use it, an example and the output fields", () => {
    expect(getCustomerSummary.description).toMatch(/Do NOT use/);
    expect(getCustomerSummary.description).toMatch(/Example: \{/);
    expect(getCustomerSummary.description).toMatch(/Fields:/);
  });
});
