import { describe, expect, it } from "vitest";
import { listAtRiskCustomers } from "../list-at-risk-customers";
import { ctxFor, dec, fakePrisma, WRITE_METHODS } from "./fake-prisma";

const v = (propertyId: string, customer: string, date: string, status: string, skipReason: string | null = null, customerId?: string) => ({
  propertyId, date: new Date(`${date}T00:00:00Z`), status, skipReason, property: { customerId, addressLine: `${propertyId} High St`, customer: { name: customer } },
});

const base = (skips: number) => ({ riskScore: skips * 15, signals: `${skips} skips in a row`, openComplaints: 0, balanceOwed: 0, daysOverdue: 0, failedDirectDebits: 0 });

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

const ALL_COLUMNS = ["customer", "address", "skips", "lastSkipped", "reason", "riskScore", "signals", "openComplaints", "balanceOwed", "daysOverdue", "failedDirectDebits"];
type IdQuery = { where: { id?: { in: string[] } } };

describe("list_at_risk_customers", () => {
  it("validates input", () => {
    expect(listAtRiskCustomers.parse({})).toEqual({ minConsecutiveSkips: 2, since: undefined, limit: 50 });
    expect(listAtRiskCustomers.parse({ minConsecutiveSkips: 3, since: "2026-06-01" })).toMatchObject({ minConsecutiveSkips: 3, since: "2026-06-01" });
    expect(listAtRiskCustomers.parse({ minScore: 40 })).toMatchObject({ minScore: 40 });
    expect(() => listAtRiskCustomers.parse({ minScore: 101 })).toThrow(/0 to 100/);
    expect(() => listAtRiskCustomers.parse({ minScore: 1.5 })).toThrow(/0 to 100/);
    expect(() => listAtRiskCustomers.parse({ minConsecutiveSkips: 1 })).toThrow(/2 to 10/);
    expect(() => listAtRiskCustomers.parse({ minConsecutiveSkips: 11 })).toThrow(/2 to 10/);
    expect(() => listAtRiskCustomers.parse({ since: "soon" })).toThrow(/YYYY-MM-DD/);
  });

  it("finds properties whose latest visits were skipped N times in a row", async () => {
    const { tp, calls } = fakePrisma({ "visit.findMany": VISITS });
    const out = await listAtRiskCustomers.run({ minConsecutiveSkips: 2, limit: 50 }, ctxFor(tp));
    expect(out.rows).toEqual([
      { customer: "Cara", address: "P3 High St", skips: 3, lastSkipped: "2026-11-01", reason: null, ...base(3) },
      { customer: "Aaron", address: "P5 High St", skips: 2, lastSkipped: "2026-11-05", reason: null, ...base(2) },
      { customer: "Alice", address: "P1 High St", skips: 2, lastSkipped: "2026-11-05", reason: "No access", ...base(2) },
      { customer: "Zed", address: "P6 High St", skips: 2, lastSkipped: "2026-09-10", reason: null, ...base(2) },
    ]);
    expect(out.totals).toEqual({ customer: "Total", customers: 4 });
    expect(out.dateRange).toEqual({ from: "2026-05-14", to: "2026-11-10", label: "14 May to 10 Nov 2026" });
    expect(out.truncated).toBe(false);
    const q = calls.find((c) => c.path === "visit.findMany")!.args as { where: { status: { in: string[] }; date: { gte: Date; lt: Date } } };
    expect(q.where.status.in).toEqual(["COMPLETED", "SKIPPED"]);
    expect(q.where.date.gte).toEqual(new Date("2026-05-14T00:00:00Z"));
  });

  it("keeps every original column and adds the composite ones", async () => {
    const { tp } = fakePrisma({ "visit.findMany": VISITS });
    const out = await listAtRiskCustomers.run({ minConsecutiveSkips: 2, limit: 50 }, ctxFor(tp));
    expect(out.columns.map((c) => c.key)).toEqual(ALL_COLUMNS);
    for (const r of out.rows) expect(Object.keys(r)).toEqual(ALL_COLUMNS);
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
    const many = Array.from({ length: 20_001 }, (_, i) => v(`Q${i}`, "X", "2026-11-01", "COMPLETED", null, `c${i}`));
    const big = fakePrisma({ "visit.findMany": many });
    expect((await listAtRiskCustomers.run({ minConsecutiveSkips: 2, limit: 50 }, ctxFor(big.tp))).truncated).toBe(true);
  });

  it("combines skips, complaints, debt, failed direct debit and contact problems into a capped score with readable signals", async () => {
    const visits = [
      v("P1", "Alice", "2026-11-05", "SKIPPED", "No access", "cA"), v("P1", "Alice", "2026-10-20", "SKIPPED", null, "cA"),
      v("P1b", "Alice", "2026-11-06", "SKIPPED", "Gate", "cA"), v("P1b", "Alice", "2026-10-01", "COMPLETED", null, "cA"),
      v("P2", "Bob", "2026-11-04", "SKIPPED", null, "cB"), v("P2", "Bob", "2026-10-20", "SKIPPED", null, "cB"),
    ];
    const { tp, calls } = fakePrisma({
      "visit.findMany": visits,
      "complaint.groupBy": [{ customerId: "cA", _count: { _all: 3 } }, { customerId: "cB", _count: 1 }],
      "invoice.groupBy": [
        { customerId: "cA", _sum: { amount: dec(120) }, _min: { dueDate: new Date("2026-08-01T00:00:00Z") } },
        { customerId: "cB", _sum: { amount: dec(40) }, _min: { dueDate: new Date("2026-11-05T00:00:00Z") } },
      ],
      "payment.groupBy": [{ customerId: "cA", _count: { _all: 1 } }],
      "customer.findMany": [{ id: "cA", messagesOptOut: true, emailInvalidAt: new Date("2026-10-01T00:00:00Z") }, { id: "cB", messagesOptOut: false, emailInvalidAt: null }],
    });
    const out = await listAtRiskCustomers.run({ minConsecutiveSkips: 2, limit: 50 }, ctxFor(tp));
    expect(out.rows).toEqual([
      {
        customer: "Alice", address: "P1 High St", skips: 2, lastSkipped: "2026-11-05", reason: "No access", riskScore: 100,
        signals: "2 skips in a row; 3 open complaints; £120.00 owed, 101 days overdue; failed direct debit; messages opted out; email address invalid",
        openComplaints: 3, balanceOwed: 120, daysOverdue: 101, failedDirectDebits: 1,
      },
      {
        customer: "Bob", address: "P2 High St", skips: 2, lastSkipped: "2026-11-04", reason: null, riskScore: 50,
        signals: "2 skips in a row; 1 open complaint; £40.00 owed, 5 days overdue", openComplaints: 1, balanceOwed: 40, daysOverdue: 5, failedDirectDebits: 0,
      },
    ]);
    expect(out.totals).toEqual({ customer: "Total", customers: 2 });
    expect(calls.find((c) => c.path === "complaint.groupBy")!.args).toMatchObject({ where: { status: { not: "RESOLVED" } } });
    expect(calls.find((c) => c.path === "invoice.groupBy")!.args).toMatchObject({ where: { status: "SENT" } });
    expect(calls.find((c) => c.path === "payment.groupBy")!.args).toMatchObject({ where: { status: "FAILED", method: "GOCARDLESS" } });
  });

  it("scores each debt tier and ignores debt that is not yet due or has no balance", async () => {
    const days = (n: number) => new Date(Date.parse("2026-11-10T00:00:00Z") - n * 86_400_000);
    const mk = (id: string, n: number | null, amount = 10) => ({ customerId: id, _sum: { amount: dec(amount) }, _min: { dueDate: n === null ? null : days(n) } });
    const { tp } = fakePrisma({
      "invoice.groupBy": [mk("c1", 61), mk("c2", 31), mk("c3", 8), mk("c4", 1), mk("c5", 0), mk("c6", -5), mk("c7", null), mk("c8", 90, 0)],
      "customer.findMany": (a: IdQuery) => (a.where.id ? a.where.id.in.map((id) => ({ id, name: `N-${id}`, properties: [] })) : []),
    });
    const out = await listAtRiskCustomers.run({ minConsecutiveSkips: 2, minScore: 5, limit: 50 }, ctxFor(tp));
    expect(out.rows.map((r) => [r.customer, r.riskScore])).toEqual([["N-c1", 20], ["N-c2", 15], ["N-c3", 10], ["N-c4", 5]]);
    expect(out.rows[0]).toMatchObject({ address: "", skips: 0, lastSkipped: null, reason: null, signals: "£10.00 owed, 61 days overdue" });
  });

  it("minScore lists customers by score whatever their skips, looks up names for non-skippers, and minScore 0 includes quiet customers", async () => {
    const visits = [
      v("P1", "Alice", "2026-11-05", "SKIPPED", "No access", "cA"), v("P1", "Alice", "2026-10-20", "SKIPPED", null, "cA"),
      v("P9", "Quiet", "2026-11-05", "COMPLETED", null, "cQ"), v("P9b", "Quiet", "2026-11-04", "COMPLETED", null, "cQ"),
    ];
    const { tp, calls } = fakePrisma({
      "visit.findMany": visits,
      "complaint.groupBy": [{ customerId: "cZ", _count: { _all: 2 } }, { customerId: "cY", _count: { _all: 2 } }],
      "customer.findMany": (a: IdQuery) => (a.where.id ? [{ id: "cZ", name: "Zoe", properties: [{ addressLine: "9 Elm Rd" }] }, { id: "cY", name: "Yan", properties: [] }] : []),
    });
    const out = await listAtRiskCustomers.run({ minConsecutiveSkips: 2, minScore: 30, limit: 50 }, ctxFor(tp));
    expect(out.rows.map((r) => [r.customer, r.riskScore, r.signals])).toEqual([["Alice", 30, "2 skips in a row"], ["Yan", 30, "2 open complaints"], ["Zoe", 30, "2 open complaints"]]);
    expect(out.rows[2]).toMatchObject({ address: "9 Elm Rd", skips: 0, openComplaints: 2 });
    const lookups = calls.filter((c) => c.path === "customer.findMany").map((c) => (c.args as IdQuery).where.id?.in);
    expect(lookups.flat()).not.toContain("cQ");
    const zero = await listAtRiskCustomers.run({ minConsecutiveSkips: 2, minScore: 0, limit: 50 }, ctxFor(tp));
    expect(zero.rows.map((r) => r.customer)).toEqual(["Alice", "Yan", "Zoe", "Quiet"]);
    expect(zero.rows[3]).toMatchObject({ riskScore: 0, signals: "No risk signals", skips: 0, lastSkipped: null, reason: null });
  });

  it("describes a single skip in the singular", async () => {
    const { tp } = fakePrisma({ "visit.findMany": [v("P4", "Dan", "2026-11-02", "SKIPPED", null, "cD")] });
    const out = await listAtRiskCustomers.run({ minConsecutiveSkips: 2, minScore: 10, limit: 50 }, ctxFor(tp));
    expect(out.rows[0]).toMatchObject({ customer: "Dan", riskScore: 15, signals: "1 skip in a row" });
  });

  it("a customer with several properties is one row, represented by the longest (then latest) streak", async () => {
    const visits = [
      v("P1", "Multi", "2026-11-01", "SKIPPED", "old", "cM"), v("P1", "Multi", "2026-10-01", "SKIPPED", null, "cM"),
      v("P2", "Multi", "2026-11-08", "SKIPPED", "newer", "cM"), v("P2", "Multi", "2026-10-08", "SKIPPED", null, "cM"),
      v("P5", "Multi", "2026-10-30", "SKIPPED", "oldest", "cM"), v("P5", "Multi", "2026-10-01", "SKIPPED", null, "cM"),
      v("P3", "Multi", "2026-11-09", "SKIPPED", null, "cM"), v("P3", "Multi", "2026-10-09", "COMPLETED", null, "cM"),
      v("P4", "Multi", "2026-11-09", "COMPLETED", null, "cM"),
    ];
    const { tp } = fakePrisma({ "visit.findMany": visits });
    const out = await listAtRiskCustomers.run({ minConsecutiveSkips: 2, limit: 50 }, ctxFor(tp));
    expect(out.rows).toHaveLength(1);
    expect(out.rows[0]).toMatchObject({ customer: "Multi", address: "P2 High St", skips: 2, lastSkipped: "2026-11-08", reason: "newer" });
  });

  it("never writes, queries no secret or note fields and returns no secret-looking keys", async () => {
    const { tp, calls } = fakePrisma({ "visit.findMany": VISITS, "complaint.groupBy": [{ customerId: "P1", _count: 1 }] });
    const out = await listAtRiskCustomers.run({ minConsecutiveSkips: 2, minScore: 0, limit: 50 }, ctxFor(tp));
    expect(calls.filter((c) => (WRITE_METHODS as readonly string[]).some((m) => c.path.endsWith(`.${m}`)))).toEqual([]);
    expect(JSON.stringify(calls.map((c) => c.args))).not.toMatch(/notes|riskNotes|accessNotes|body|stripe|gocardlessMandate|token|secret/i);
    expect([...Object.keys(out.rows[0]), ...Object.keys(out.totals ?? {})].filter((k) => /bank|token|secret|password|webhook|mandate|stripe|note|body/i.test(k))).toEqual([]);
  });
});
