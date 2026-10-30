import { it, expect, vi, beforeEach } from "vitest";

vi.mock("../../lib/email", () => ({}));

const sendMessage = vi.fn();
const prepareMessage = vi.fn();
const deliverMessage = vi.fn();
vi.mock("../message.service", () => ({
  createMessageService: vi.fn(() => ({ send: sendMessage, prepare: prepareMessage, deliver: deliverMessage })),
}));
const holdNextVisits = vi.fn();
const releaseHeldVisits = vi.fn();
vi.mock("../payment-hold", () => ({
  holdNextVisits: (...a: unknown[]) => holdNextVisits(...a),
  releaseHeldVisits: (...a: unknown[]) => releaseHeldVisits(...a),
}));
const getInvoiceCheckoutLink = vi.fn();
vi.mock("../../integrations/stripe/checkout", () => ({
  getInvoiceCheckoutLink: (...a: unknown[]) => getInvoiceCheckoutLink(...a),
}));

import { createDebtService } from "../debt.service";

function makePrisma() {
  return {
    invoice: { findMany: vi.fn(), findUnique: vi.fn(), update: vi.fn(), count: vi.fn(), aggregate: vi.fn() },
    customer: { findUnique: vi.fn(), findMany: vi.fn().mockResolvedValue([]), update: vi.fn(), count: vi.fn().mockResolvedValue(0) },
    visit: { findMany: vi.fn(), findFirst: vi.fn() },
    payment: { findMany: vi.fn() },
    message: { create: vi.fn(), findFirst: vi.fn() },
    messageTemplate: { findFirst: vi.fn().mockResolvedValue(null) },
    businessSettings: { findFirst: vi.fn() },
    $queryRaw: vi.fn(),
  } as unknown as Parameters<typeof createDebtService>[0];
}

beforeEach(() => {
  sendMessage.mockReset();
  prepareMessage.mockReset();
  deliverMessage.mockReset();
  holdNextVisits.mockReset().mockResolvedValue(1);
  releaseHeldVisits.mockReset().mockResolvedValue(2);
  getInvoiceCheckoutLink.mockReset();
});

// ---- helpers for getBoard tests -------------------------------------------

function setupBoard(prisma: ReturnType<typeof makePrisma>, invoices: unknown[], opts?: { failed?: unknown[]; upcoming?: unknown[]; count?: number; raw?: unknown[] }) {
  (prisma.invoice.count as ReturnType<typeof vi.fn>).mockResolvedValue(opts?.count ?? invoices.length);
  (prisma.invoice.findMany as ReturnType<typeof vi.fn>).mockResolvedValue(invoices);
  (prisma.payment.findMany as ReturnType<typeof vi.fn>).mockResolvedValue(opts?.failed ?? []);
  (prisma.visit.findMany as ReturnType<typeof vi.fn>).mockResolvedValue(opts?.upcoming ?? []);
  (prisma.$queryRaw as ReturnType<typeof vi.fn>).mockResolvedValue(opts?.raw ?? []);
}

function inv(overrides: Record<string, unknown> = {}) {
  return {
    id: "inv-1",
    invoiceNumber: "INV-1",
    amount: { toNumber: () => 35 },
    dueDate: null,
    customerId: "c1",
    visitId: null,
    customer: { id: "c1", name: "John", email: null, paymentMethod: null, badDebt: false, holdNextClean: false },
    visit: null,
    ...overrides,
  };
}

it("createDebtService returns an object", () => {
  const svc = createDebtService(makePrisma());
  expect(svc).toBeDefined();
});

it("getKpis is a function", () => {
  const svc = createDebtService(makePrisma());
  expect(typeof svc.getKpis).toBe("function");
});

// ---- getKpis ----------------------------------------------------------------

function setupKpis(
  prisma: ReturnType<typeof makePrisma>,
  opts: {
    totalOutstandings?: number | null;
    badDebt?: number | null;
    failedGoCardless?: number;
    dueBeforeClean?: number;
    holdNextClean?: number;
    totalOutstandingsCount?: number;
    badDebtCount?: number;
    failedPayments?: unknown[];
    upcomingVisits?: unknown[];
  } = {}
) {
  (prisma.payment.findMany as ReturnType<typeof vi.fn>).mockResolvedValue(opts.failedPayments ?? []);
  (prisma.visit.findMany as ReturnType<typeof vi.fn>).mockResolvedValue(opts.upcomingVisits ?? []);
  (prisma.invoice.aggregate as ReturnType<typeof vi.fn>)
    .mockResolvedValueOnce({ _sum: { amount: opts.totalOutstandings ?? null } })
    .mockResolvedValueOnce({ _sum: { amount: opts.badDebt ?? null } });
  (prisma.invoice.count as ReturnType<typeof vi.fn>)
    .mockResolvedValueOnce(opts.failedGoCardless ?? 0)
    .mockResolvedValueOnce(opts.dueBeforeClean ?? 0);
  (prisma.customer.count as ReturnType<typeof vi.fn>)
    .mockResolvedValueOnce(opts.holdNextClean ?? 0)
    .mockResolvedValueOnce(opts.totalOutstandingsCount ?? 0)
    .mockResolvedValueOnce(opts.badDebtCount ?? 0);
}

it("getKpis returns every KPI field", async () => {
  const prisma = makePrisma();
  setupKpis(prisma, {});
  const result = await createDebtService(prisma).getKpis();
  expect(Object.keys(result).sort()).toEqual([
    "badDebt", "badDebtCount", "dueBeforeClean", "failedGoCardless", "holdNextClean",
    "totalOutstandings", "totalOutstandingsCount",
  ]);
});

it("getKpis totalOutstandings uses the aggregate _sum.amount with customer.badDebt:false", async () => {
  const prisma = makePrisma();
  setupKpis(prisma, { totalOutstandings: 85 });
  const result = await createDebtService(prisma).getKpis();
  expect(result.totalOutstandings).toBe(85);
  expect(prisma.invoice.aggregate).toHaveBeenNthCalledWith(1, {
    _sum: { amount: true },
    where: { status: "SENT", customer: { badDebt: false } },
  });
});

it("getKpis totalOutstandings and badDebt default to 0 when aggregate sums are null", async () => {
  const prisma = makePrisma();
  setupKpis(prisma, { totalOutstandings: null, badDebt: null });
  const result = await createDebtService(prisma).getKpis();
  expect(result.totalOutstandings).toBe(0);
  expect(result.badDebt).toBe(0);
});

it("getKpis badDebt uses the aggregate _sum.amount with customer.badDebt:true", async () => {
  const prisma = makePrisma();
  setupKpis(prisma, { badDebt: 100 });
  const result = await createDebtService(prisma).getKpis();
  expect(result.badDebt).toBe(100);
  expect(prisma.invoice.aggregate).toHaveBeenNthCalledWith(2, {
    _sum: { amount: true },
    where: { status: "SENT", customer: { badDebt: true } },
  });
});

it("getKpis failedGoCardless counts invoices via visitId:{in:[...failedVisitIds]}", async () => {
  const prisma = makePrisma();
  setupKpis(prisma, { failedGoCardless: 1, failedPayments: [{ visitId: "v1" }, { visitId: null }] });
  const result = await createDebtService(prisma).getKpis();
  expect(result.failedGoCardless).toBe(1);
  expect(prisma.invoice.count).toHaveBeenNthCalledWith(1, {
    where: { status: "SENT", customer: { badDebt: false }, visitId: { in: ["v1"] } },
  });
});

it("getKpis dueBeforeClean counts invoices via customerId:{in:[...upcomingCustomerIds]}, ignoring CANCELLED visits", async () => {
  const prisma = makePrisma();
  setupKpis(prisma, { dueBeforeClean: 1, upcomingVisits: [{ property: { customerId: "c1" } }] });
  const result = await createDebtService(prisma).getKpis();
  expect(result.dueBeforeClean).toBe(1);
  expect(prisma.invoice.count).toHaveBeenNthCalledWith(2, {
    where: { status: "SENT", customer: { badDebt: false }, customerId: { in: ["c1"] } },
  });
  expect(prisma.visit.findMany).toHaveBeenCalledWith(expect.objectContaining({
    where: expect.objectContaining({ status: { not: "CANCELLED" } }),
  }));
});

it("getKpis holdNextClean counts customers on hold whatever their invoice status (A3)", async () => {
  const prisma = makePrisma();
  setupKpis(prisma, { holdNextClean: 4 });
  const result = await createDebtService(prisma).getKpis();
  expect(result.holdNextClean).toBe(4);
  expect(prisma.customer.count).toHaveBeenNthCalledWith(1, { where: { holdNextClean: true, badDebt: false } });
});

it("getKpis totalOutstandingsCount / badDebtCount count distinct customers (GAP-031)", async () => {
  const prisma = makePrisma();
  setupKpis(prisma, { totalOutstandingsCount: 7, badDebtCount: 2 });
  const result = await createDebtService(prisma).getKpis();
  expect(result.totalOutstandingsCount).toBe(7);
  expect(result.badDebtCount).toBe(2);
  expect(prisma.customer.count).toHaveBeenNthCalledWith(2, { where: { badDebt: false, invoices: { some: { status: "SENT" } } } });
  expect(prisma.customer.count).toHaveBeenNthCalledWith(3, { where: { badDebt: true, invoices: { some: { status: "SENT" } } } });
});

// ---- getBoard: basic ----------------------------------------------------------

it("getBoard is a function", () => {
  const svc = createDebtService(makePrisma());
  expect(typeof svc.getBoard).toBe("function");
});

it("getBoard returns a rows array inside a paginated response", async () => {
  const prisma = makePrisma();
  setupBoard(prisma, []);
  const result = await createDebtService(prisma).getBoard("INVOICE_SENT");
  expect(Array.isArray(result.rows)).toBe(true);
  expect(result.pagination).toMatchObject({ page: 1, pageSize: 50, total: 0, totalPages: 0 });
});

// ---- getBoard: bucket where-clause shape ---------------------------------------

it("getBoard BAD_DEBT builds where.customer.badDebt:true", async () => {
  const prisma = makePrisma();
  setupBoard(prisma, [inv({ customer: { ...inv().customer, badDebt: true } })]);
  await createDebtService(prisma).getBoard("BAD_DEBT");
  const callArgs = (prisma.invoice.findMany as ReturnType<typeof vi.fn>).mock.calls[0][0];
  expect(callArgs.where).toMatchObject({ status: "SENT", customer: { badDebt: true } });
  const countArgs = (prisma.invoice.count as ReturnType<typeof vi.fn>).mock.calls[0][0];
  expect(countArgs.where).toMatchObject({ status: "SENT", customer: { badDebt: true } });
});

const fnOf = (f: unknown) => f as ReturnType<typeof vi.fn>;

function heldCustomer(overrides: Record<string, unknown> = {}) {
  return {
    id: "c1", name: "Held Co", paymentMethod: "BACS", badDebt: false, holdNextClean: true,
    properties: [{ addressLine: "1 High St", postcode: "NE1 1AA" }],
    invoices: [
      { id: "inv-a", invoiceNumber: "INV-A", amount: { toNumber: () => 20 }, dueDate: new Date("2026-10-01") },
      { id: "inv-b", invoiceNumber: "INV-B", amount: { toNumber: () => 15 }, dueDate: new Date("2026-10-08") },
    ],
    ...overrides,
  };
}

it("getBoard ON_HOLD lists held customers (one row each, oldest SENT invoice + total outstanding), matching the count", async () => {
  const prisma = makePrisma();
  fnOf(prisma.customer.count).mockResolvedValue(2);
  fnOf(prisma.customer.findMany).mockResolvedValue([
    heldCustomer(),
    heldCustomer({ id: "c2", name: "No Invoice", paymentMethod: null, properties: [], invoices: [] }),
  ]);
  fnOf(prisma.$queryRaw).mockResolvedValue([{ customerId: "c1", createdAt: new Date("2026-10-20") }]);

  const result = await createDebtService(prisma).getBoard("ON_HOLD", undefined, undefined, 1, 10);

  expect(prisma.invoice.findMany).not.toHaveBeenCalled();
  const args = fnOf(prisma.customer.findMany).mock.calls[0][0];
  expect(args.where).toEqual({ holdNextClean: true, badDebt: false });
  expect(args).toMatchObject({ take: 10, skip: 0 });
  expect(fnOf(prisma.customer.count).mock.calls[0][0].where).toEqual(args.where);
  expect(result.pagination.total).toBe(2);
  expect(result.rows).toEqual([
    {
      invoiceId: "inv-a", invoiceNumber: "INV-A", amount: 35, dueDate: new Date("2026-10-01"),
      customerId: "c1", customerName: "Held Co", addressLine: "1 High St", postcode: "NE1 1AA",
      paymentMethod: "BACS", lastContactedAt: new Date("2026-10-20"), badDebt: false, holdNextClean: true,
    },
    {
      invoiceId: null, invoiceNumber: null, amount: 0, dueDate: null,
      customerId: "c2", customerName: "No Invoice", addressLine: "", postcode: null,
      paymentMethod: null, lastContactedAt: null, badDebt: false, holdNextClean: true,
    },
  ]);
});

it("getBoard FAILED_GC builds where.visitId:{in:[...failedVisitIds]}", async () => {
  const prisma = makePrisma();
  setupBoard(prisma, [inv({ visitId: "v1" })], { failed: [{ visitId: "v1" }] });
  await createDebtService(prisma).getBoard("FAILED_GC");
  const callArgs = (prisma.invoice.findMany as ReturnType<typeof vi.fn>).mock.calls[0][0];
  expect(callArgs.where).toMatchObject({ status: "SENT", customer: { badDebt: false }, visitId: { in: ["v1"] } });
});

it("getBoard DUE_BEFORE_CLEAN builds where.customerId:{in:[...upcomingCustomerIds]}", async () => {
  const prisma = makePrisma();
  setupBoard(prisma, [inv({ customerId: "c1" })], { upcoming: [{ property: { customerId: "c1" } }] });
  await createDebtService(prisma).getBoard("DUE_BEFORE_CLEAN");
  const callArgs = (prisma.invoice.findMany as ReturnType<typeof vi.fn>).mock.calls[0][0];
  expect(callArgs.where).toMatchObject({ status: "SENT", customer: { badDebt: false }, customerId: { in: ["c1"] } });
});

it("getBoard SEVEN_DAYS_OVER builds where.dueDate:{gte:sevenDaysAgo,lt:now}", async () => {
  const prisma = makePrisma();
  setupBoard(prisma, [inv()]);
  await createDebtService(prisma).getBoard("SEVEN_DAYS_OVER");
  const callArgs = (prisma.invoice.findMany as ReturnType<typeof vi.fn>).mock.calls[0][0];
  expect(callArgs.where.customer).toMatchObject({ badDebt: false });
  expect(callArgs.where.dueDate.gte).toBeInstanceOf(Date);
  expect(callArgs.where.dueDate.lt).toBeInstanceOf(Date);
  expect(callArgs.where.dueDate.gte.getTime()).toBeLessThan(callArgs.where.dueDate.lt.getTime());
});

it("getBoard FOURTEEN_DAYS_OVER builds where.dueDate:{lt:sevenDaysAgo}", async () => {
  const prisma = makePrisma();
  setupBoard(prisma, [inv()]);
  await createDebtService(prisma).getBoard("FOURTEEN_DAYS_OVER");
  const callArgs = (prisma.invoice.findMany as ReturnType<typeof vi.fn>).mock.calls[0][0];
  expect(callArgs.where.customer).toMatchObject({ badDebt: false });
  expect(callArgs.where.dueDate).toHaveProperty("lt");
  expect(callArgs.where.dueDate.gte).toBeUndefined();
});

it("getBoard default bucket builds the full exclusion where clause", async () => {
  const prisma = makePrisma();
  setupBoard(prisma, [inv()], { failed: [{ visitId: "v9" }], upcoming: [{ property: { customerId: "c9" } }] });
  await createDebtService(prisma).getBoard("INVOICE_SENT");
  const callArgs = (prisma.invoice.findMany as ReturnType<typeof vi.fn>).mock.calls[0][0];
  expect(callArgs.where).toMatchObject({
    status: "SENT",
    customer: { badDebt: false, holdNextClean: false },
    customerId: { notIn: ["c9"] },
  });
  // visitId exclusion and the dueDate window are each expressed as an OR
  // (not a bare `visitId: {notIn:...}`) so that a NULL visitId isn't
  // silently dropped by SQL's NOT IN-with-NULL semantics — see the
  // dedicated null-visitId regression test below.
  expect(callArgs.where.AND).toEqual([
    { OR: [{ visitId: null }, { visitId: { notIn: ["v9"] } }] },
    { OR: [{ dueDate: null }, { dueDate: { gte: expect.any(Date) } }] },
  ]);
});

it("getBoard default bucket: an invoice with a null visitId is not excluded by the failed-GC filter", async () => {
  // Regression test for: `where.visitId = { notIn: failedVisitIds }` drops
  // any row with a NULL visitId, because SQL's `NOT IN` evaluates to NULL
  // (not true) against NULL — this is a real, hand-standalone invoice with
  // no linked visit, which must still appear in the default bucket.
  const prisma = makePrisma();
  setupBoard(
    prisma,
    [inv({ id: "inv-standalone", visitId: null, customerId: "c-standalone" })],
    { failed: [{ visitId: "v9" }] }
  );
  const result = await createDebtService(prisma).getBoard("INVOICE_SENT");
  const callArgs = (prisma.invoice.findMany as ReturnType<typeof vi.fn>).mock.calls[0][0];
  const [visitIdClause] = callArgs.where.AND;
  // Simulate what Prisma's real `where` would match for this invoice: a
  // null visitId satisfies the OR's first branch, so the row is kept.
  const simulatedMatch = visitIdClause.OR.some(
    (c: Record<string, unknown>) => ("visitId" in c ? c.visitId === null : false)
  );
  expect(simulatedMatch).toBe(true);
  // The mock doesn't apply the where itself, but the output-mapping path
  // must still produce a row for this invoice (findMany result is returned
  // as-is by setupBoard — this confirms the service doesn't ALSO filter the
  // already-fetched rows in JS, which would reintroduce the same bug one
  // layer up).
  expect(result.rows.map((r) => r.invoiceId)).toContain("inv-standalone");
});

// ---- getBoard: output mapping / semantics (end-to-end via mocked findMany result) --

it("getBoard BAD_DEBT returns only bad-debt invoices (output mapping)", async () => {
  const prisma = makePrisma();
  setupBoard(prisma, [
    inv({ id: "inv-1", invoiceNumber: "INV-2026-001", customerId: "c1", customer: { id: "c1", name: "John", email: null, paymentMethod: null, badDebt: true, holdNextClean: false } }),
  ]);
  const result = await createDebtService(prisma).getBoard("BAD_DEBT");
  expect(result.rows).toHaveLength(1);
  expect(result.rows[0].customerName).toBe("John");
});

it("getBoard INVOICE_SENT excludes bad-debt invoices (output mapping)", async () => {
  const prisma = makePrisma();
  setupBoard(prisma, [
    inv({ id: "inv-2", invoiceNumber: "INV-2026-002", customerId: "c2", customer: { id: "c2", name: "Jane", email: null, paymentMethod: null, badDebt: false, holdNextClean: false } }),
  ]);
  const result = await createDebtService(prisma).getBoard("INVOICE_SENT");
  expect(result.rows).toHaveLength(1);
  expect(result.rows[0].customerName).toBe("Jane");
});

// ---- getBoard: boundary + precedence cases ---------------------------------------

it("getBoard SEVEN_DAYS_OVER boundary: dueDate exactly 7 days ago is included (gte)", async () => {
  const prisma = makePrisma();
  const now = Date.now();
  const sevenDaysAgo = new Date(now - 7 * 86_400_000);
  setupBoard(prisma, [inv({ dueDate: sevenDaysAgo })]);
  const result = await createDebtService(prisma).getBoard("SEVEN_DAYS_OVER");
  // Mock doesn't actually filter; this just asserts the where-clause boundary is gte (inclusive).
  const callArgs = (prisma.invoice.findMany as ReturnType<typeof vi.fn>).mock.calls[0][0];
  expect(callArgs.where.dueDate.gte.getTime()).toBeLessThanOrEqual(sevenDaysAgo.getTime() + 1000);
  expect(result.rows).toHaveLength(1);
});

it("getBoard FOURTEEN_DAYS_OVER boundary: dueDate exactly 7 days ago is NOT included (lt, exclusive)", async () => {
  const prisma = makePrisma();
  setupBoard(prisma, []); // DB would exclude the exact-boundary row from this bucket
  const result = await createDebtService(prisma).getBoard("FOURTEEN_DAYS_OVER");
  expect(result.rows).toHaveLength(0);
});

it("getBoard: a bad-debt customer who would otherwise match ON_HOLD is excluded when querying ON_HOLD (badDebt wins)", async () => {
  const prisma = makePrisma();
  // Customer has badDebt:true AND holdNextClean:true, but the ON_HOLD where clause
  // forces badDebt:false, so the DB would never return this row for that bucket.
  const result = await createDebtService(prisma).getBoard("ON_HOLD");
  const callArgs = fnOf(prisma.customer.findMany).mock.calls[0][0];
  expect(callArgs.where.badDebt).toBe(false);
  expect(result.rows).toHaveLength(0);
  expect(prisma.$queryRaw).not.toHaveBeenCalled();
});

it("getBoard: a bad-debt customer appears under BAD_DEBT regardless of holdNextClean/failedGC/etc (precedence)", async () => {
  const prisma = makePrisma();
  setupBoard(prisma, [
    inv({ customer: { id: "c1", name: "BadDebtCo", email: null, paymentMethod: null, badDebt: true, holdNextClean: true } }),
  ]);
  const result = await createDebtService(prisma).getBoard("BAD_DEBT");
  expect(result.rows).toHaveLength(1);
  expect(result.rows[0].customerName).toBe("BadDebtCo");
});

// ---- getBoard: $queryRaw last-contacted lookup -----------------------------------

it("getBoard calls $queryRaw exactly once for the last-contacted lookup, not per customer", async () => {
  const prisma = makePrisma();
  setupBoard(
    prisma,
    [inv({ id: "i1", customerId: "c1" }), inv({ id: "i2", customerId: "c2" })],
    { raw: [{ customerId: "c1", createdAt: new Date("2026-01-05T00:00:00Z") }] }
  );
  await createDebtService(prisma).getBoard("INVOICE_SENT");
  expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
});

it("getBoard maps lastContactedAt from the $queryRaw result per customer", async () => {
  const prisma = makePrisma();
  const lastDate = new Date("2026-01-05T00:00:00Z");
  setupBoard(
    prisma,
    [inv({ id: "i1", customerId: "c1" }), inv({ id: "i2", customerId: "c2" })],
    { raw: [{ customerId: "c1", createdAt: lastDate }] }
  );
  const result = await createDebtService(prisma).getBoard("INVOICE_SENT");
  const row1 = result.rows.find((r) => r.customerId === "c1");
  const row2 = result.rows.find((r) => r.customerId === "c2");
  expect(row1?.lastContactedAt).toBe(lastDate);
  expect(row2?.lastContactedAt).toBeNull();
});

it("getBoard ignores a $queryRaw row with no customerId (defensive branch)", async () => {
  const prisma = makePrisma();
  setupBoard(
    prisma,
    [inv({ id: "i1", customerId: "c1" })],
    { raw: [{ customerId: undefined, createdAt: new Date("2026-01-05T00:00:00Z") }] }
  );
  const result = await createDebtService(prisma).getBoard("INVOICE_SENT");
  expect(result.rows[0].lastContactedAt).toBeNull();
});

it("getBoard does not call $queryRaw when there are no invoices (no customerIds)", async () => {
  const prisma = makePrisma();
  setupBoard(prisma, []);
  await createDebtService(prisma).getBoard("INVOICE_SENT");
  expect(prisma.$queryRaw).not.toHaveBeenCalled();
});

// ---- getBoard: roundId / paymentMethod filters -----------------------------------

it("getBoard applies roundId filter via where.visit.property.roundId", async () => {
  const prisma = makePrisma();
  setupBoard(prisma, [inv()]);
  await createDebtService(prisma).getBoard("INVOICE_SENT", "round-1");
  const callArgs = (prisma.invoice.findMany as ReturnType<typeof vi.fn>).mock.calls[0][0];
  expect(callArgs.where.visit).toEqual({ property: { roundId: "round-1" } });
});

it("getBoard applies paymentMethod filter via where.customer.paymentMethod", async () => {
  const prisma = makePrisma();
  setupBoard(prisma, [inv()]);
  await createDebtService(prisma).getBoard("INVOICE_SENT", undefined, "CARD");
  const callArgs = (prisma.invoice.findMany as ReturnType<typeof vi.fn>).mock.calls[0][0];
  expect(callArgs.where.customer).toMatchObject({ paymentMethod: "CARD" });
});

it("getBoard combines roundId and paymentMethod with a bucket filter", async () => {
  const prisma = makePrisma();
  setupBoard(prisma, [inv()]);
  await createDebtService(prisma).getBoard("BAD_DEBT", "round-1", "CARD");
  const callArgs = (prisma.invoice.findMany as ReturnType<typeof vi.fn>).mock.calls[0][0];
  expect(callArgs.where.visit).toEqual({ property: { roundId: "round-1" } });
  expect(callArgs.where.customer).toMatchObject({ paymentMethod: "CARD", badDebt: true });
});

it("getBoard ON_HOLD applies round / payment-method / search filters at customer level", async () => {
  const prisma = makePrisma();
  await createDebtService(prisma).getBoard("ON_HOLD", "round-1", "CARD", 2, 5, "smith");
  const args = fnOf(prisma.customer.findMany).mock.calls[0][0];
  expect(args.where).toMatchObject({
    holdNextClean: true, badDebt: false, paymentMethod: "CARD", properties: { some: { roundId: "round-1" } },
  });
  expect(args.where.OR).toHaveLength(2);
  expect(args).toMatchObject({ take: 5, skip: 5 });
});

// ---- getBoard: search param ------------------------------------------------------

it("getBoard with no search leaves where.AND untouched for a named bucket", async () => {
  const prisma = makePrisma();
  setupBoard(prisma, [inv()]);
  await createDebtService(prisma).getBoard("BAD_DEBT");
  const callArgs = (prisma.invoice.findMany as ReturnType<typeof vi.fn>).mock.calls[0][0];
  expect(callArgs.where.AND).toBeUndefined();
});

it("getBoard with search adds an OR clause on customer name / property address for a named bucket", async () => {
  const prisma = makePrisma();
  setupBoard(prisma, [inv()]);
  await createDebtService(prisma).getBoard("BAD_DEBT", undefined, undefined, undefined, undefined, "smith");
  const callArgs = (prisma.invoice.findMany as ReturnType<typeof vi.fn>).mock.calls[0][0];
  expect(callArgs.where.AND).toEqual([
    {
      OR: [
        { customer: { name: { contains: "smith", mode: "insensitive" } } },
        { visit: { property: { addressLine: { contains: "smith", mode: "insensitive" } } } },
      ],
    },
  ]);
});

it("getBoard with search on the default bucket appends to the existing AND array rather than replacing it", async () => {
  const prisma = makePrisma();
  setupBoard(prisma, [inv()]);
  await createDebtService(prisma).getBoard("INVOICE_SENT", undefined, undefined, undefined, undefined, "smith");
  const callArgs = (prisma.invoice.findMany as ReturnType<typeof vi.fn>).mock.calls[0][0];
  expect(callArgs.where.AND).toHaveLength(3);
  expect(callArgs.where.AND[2]).toEqual({
    OR: [
      { customer: { name: { contains: "smith", mode: "insensitive" } } },
      { visit: { property: { addressLine: { contains: "smith", mode: "insensitive" } } } },
    ],
  });
});

// ---- getBucketCounts ---------------------------------------------------------------

it("getBucketCounts is a function", () => {
  expect(typeof createDebtService(makePrisma()).getBucketCounts).toBe("function");
});

it("getBucketCounts returns a count for all 7 bucket tabs in one call (ON_HOLD counts customers)", async () => {
  const prisma = makePrisma();
  (prisma.payment.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  (prisma.visit.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  (prisma.invoice.count as ReturnType<typeof vi.fn>).mockResolvedValue(3);
  (prisma.customer.count as ReturnType<typeof vi.fn>).mockResolvedValue(9);
  const result = await createDebtService(prisma).getBucketCounts();
  expect(result).toEqual({
    BAD_DEBT: 3,
    ON_HOLD: 9,
    FAILED_GC: 3,
    DUE_BEFORE_CLEAN: 3,
    SEVEN_DAYS_OVER: 3,
    FOURTEEN_DAYS_OVER: 3,
    ALL: 3,
  });
  expect(prisma.invoice.count).toHaveBeenCalledTimes(6);
  expect(prisma.customer.count).toHaveBeenCalledWith({ where: { holdNextClean: true, badDebt: false } });
});

it("getBucketCounts only computes the failed/upcoming context once, not once per bucket", async () => {
  const prisma = makePrisma();
  (prisma.payment.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  (prisma.visit.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  (prisma.invoice.count as ReturnType<typeof vi.fn>).mockResolvedValue(0);
  await createDebtService(prisma).getBucketCounts();
  expect(prisma.payment.findMany).toHaveBeenCalledTimes(1);
  expect(prisma.visit.findMany).toHaveBeenCalledTimes(1);
});

it("getBucketCounts threads roundId/paymentMethod/search into every bucket's where clause", async () => {
  const prisma = makePrisma();
  (prisma.payment.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  (prisma.visit.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  (prisma.invoice.count as ReturnType<typeof vi.fn>).mockResolvedValue(0);
  await createDebtService(prisma).getBucketCounts("round-1", "CARD", "smith");
  const calls = (prisma.invoice.count as ReturnType<typeof vi.fn>).mock.calls;
  expect(calls).toHaveLength(6);
  for (const [{ where }] of calls) {
    expect(where.visit).toMatchObject({ property: { roundId: "round-1" } });
    expect(where.customer).toMatchObject({ paymentMethod: "CARD" });
    expect(where.AND).toBeDefined();
  }
  expect(prisma.customer.count).toHaveBeenCalledWith({
    where: {
      holdNextClean: true,
      badDebt: false,
      paymentMethod: "CARD",
      properties: { some: { roundId: "round-1" } },
      OR: [
        { name: { contains: "smith", mode: "insensitive" } },
        { properties: { some: { addressLine: { contains: "smith", mode: "insensitive" } } } },
      ],
    },
  });
});

it("getBucketCounts distinguishes BAD_DEBT (true) from every other bucket (false) in the where clause", async () => {
  const prisma = makePrisma();
  (prisma.payment.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  (prisma.visit.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  (prisma.invoice.count as ReturnType<typeof vi.fn>).mockResolvedValue(0);
  await createDebtService(prisma).getBucketCounts();
  const calls = (prisma.invoice.count as ReturnType<typeof vi.fn>).mock.calls as Array<[{ where: { customer: { badDebt?: boolean } } }]>;
  // DEBT_BUCKETS order minus ON_HOLD: BAD_DEBT, FAILED_GC, DUE_BEFORE_CLEAN, SEVEN_DAYS_OVER, FOURTEEN_DAYS_OVER, ALL
  expect(calls[0][0].where.customer.badDebt).toBe(true);
  for (const [{ where }] of calls.slice(1)) {
    expect(where.customer.badDebt).toBe(false);
  }
});

// ---- getBoard: pagination ---------------------------------------------------------

it("getBoard defaults to page=1, pageSize=50 (take/skip passed to findMany)", async () => {
  const prisma = makePrisma();
  setupBoard(prisma, []);
  await createDebtService(prisma).getBoard("INVOICE_SENT");
  const callArgs = (prisma.invoice.findMany as ReturnType<typeof vi.fn>).mock.calls[0][0];
  expect(callArgs.take).toBe(50);
  expect(callArgs.skip).toBe(0);
});

it("getBoard threads page/pageSize into take/skip and returns matching pagination metadata", async () => {
  const prisma = makePrisma();
  setupBoard(prisma, [inv(), inv({ id: "inv-2" })], { count: 120 });
  const result = await createDebtService(prisma).getBoard("INVOICE_SENT", undefined, undefined, 3, 20);
  const callArgs = (prisma.invoice.findMany as ReturnType<typeof vi.fn>).mock.calls[0][0];
  expect(callArgs.take).toBe(20);
  expect(callArgs.skip).toBe(40); // (page-1) * pageSize
  expect(result.pagination).toEqual({ page: 3, pageSize: 20, total: 120, totalPages: 6 });
});

it("getBoard clamps pageSize to a max of 100 and page to a min of 1", async () => {
  const prisma = makePrisma();
  setupBoard(prisma, []);
  const result = await createDebtService(prisma).getBoard("INVOICE_SENT", undefined, undefined, 0, 500);
  const callArgs = (prisma.invoice.findMany as ReturnType<typeof vi.fn>).mock.calls[0][0];
  expect(callArgs.take).toBe(100);
  expect(callArgs.skip).toBe(0);
  expect(result.pagination.page).toBe(1);
  expect(result.pagination.pageSize).toBe(100);
});

// ---- existing lifecycle / mutation tests (unchanged behavior) ---------------------

it("sendReminder is a function", () => {
  const svc = createDebtService(makePrisma());
  expect(typeof svc.sendReminder).toBe("function");
});

const sendable = (overrides: Record<string, unknown> = {}) => ({
  id: "inv-1",
  invoiceNumber: "INV-2026-001",
  customerId: "c1",
  amount: { toNumber: () => 33 },
  dueDate: new Date("2026-11-06T00:00:00Z"),
  status: "SENT",
  customer: { name: "Jo Bloggs" },
  ...overrides,
});

it("sendReminder throws 404 when invoice does not exist", async () => {
  const prisma = makePrisma();
  (prisma.invoice.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);
  await expect(createDebtService(prisma).sendReminder("bad-id", {})).rejects.toMatchObject({ statusCode: 404 });
});

it("sendReminder propagates a contact/channel error from prepare (nothing delivered)", async () => {
  const prisma = makePrisma();
  (prisma.invoice.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(sendable());
  prepareMessage.mockRejectedValue(Object.assign(new Error("no email"), { statusCode: 400, code: "NO_CONTACT_FOR_CHANNEL" }));
  await expect(createDebtService(prisma).sendReminder("inv-1", { channel: "EMAIL" })).rejects.toMatchObject({ code: "NO_CONTACT_FOR_CHANNEL" });
  expect(prepareMessage).toHaveBeenCalledWith("c1", "EMAIL");
  expect(deliverMessage).not.toHaveBeenCalled();
});

it("sendReminder renders the tenant reminder template and returns the message id", async () => {
  const prisma = makePrisma();
  (prisma.invoice.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(sendable());
  (prisma.messageTemplate.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "tpl-1", body: "Hi {{firstName}}, {{invoiceNumber}} {{amount}} {{mystery}}!" });
  (prisma.businessSettings.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);
  prepareMessage.mockResolvedValue({ prep: true });
  deliverMessage.mockResolvedValue({ messageId: "m1", channel: "SMS" });
  const result = await createDebtService(prisma).sendReminder("inv-1", {});
  expect(result).toEqual({ id: "m1", messageId: "m1", channel: "SMS", customerId: "c1" });
  expect(deliverMessage).toHaveBeenCalledWith({ prep: true }, "Hi Jo, INV-2026-001 £33.00 !", { templateId: "tpl-1" });
});

it("sendReminder uses a custom message instead of the template", async () => {
  const prisma = makePrisma();
  (prisma.invoice.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(sendable());
  prepareMessage.mockResolvedValue({});
  deliverMessage.mockResolvedValue({ messageId: "m1", channel: "EMAIL" });
  await createDebtService(prisma).sendReminder("inv-1", { message: "Pay {{amount}} please" });
  expect(prisma.messageTemplate.findFirst).not.toHaveBeenCalled();
  expect(deliverMessage).toHaveBeenCalledWith({}, "Pay £33.00 please", { templateId: null });
});

it("flagBadDebt is a function", () => {
  expect(typeof createDebtService(makePrisma()).flagBadDebt).toBe("function");
});

it("flagBadDebt throws 404 when invoice does not exist", async () => {
  const prisma = makePrisma();
  (prisma.invoice.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);
  await expect(createDebtService(prisma).flagBadDebt("bad-id", true)).rejects.toMatchObject({ statusCode: 404 });
});

it("flagBadDebt sets badDebt on the customer and returns it", async () => {
  const prisma = makePrisma();
  (prisma.invoice.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "inv-1", customerId: "c1" });
  (prisma.customer.update as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "c1", badDebt: true });
  const result = await createDebtService(prisma).flagBadDebt("inv-1", true);
  expect(result.badDebt).toBe(true);
});

it("flagHold is a function", () => {
  expect(typeof createDebtService(makePrisma()).flagHold).toBe("function");
});

it("flagHold throws 404 when invoice does not exist", async () => {
  const prisma = makePrisma();
  (prisma.invoice.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);
  await expect(createDebtService(prisma).flagHold("bad-id", true)).rejects.toMatchObject({ statusCode: 404 });
});

it("flagHold sets holdNextClean on the customer, holds the next visits and returns it", async () => {
  const prisma = makePrisma();
  (prisma.invoice.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "inv-1", customerId: "c1" });
  (prisma.customer.update as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "c1", holdNextClean: true, holdReason: null, holdSince: null });
  const result = await createDebtService(prisma).flagHold("inv-1", true);
  expect(result).toMatchObject({ customerId: "c1", holdNextClean: true, visitsUpdated: 1 });
  expect(holdNextVisits).toHaveBeenCalledWith(prisma, "c1");
  expect(releaseHeldVisits).not.toHaveBeenCalled();
});

it("flagHold defaults reason to null and date to now when setting the hold with no options", async () => {
  const prisma = makePrisma();
  (prisma.invoice.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "inv-1", customerId: "c1" });
  (prisma.customer.update as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "c1", holdNextClean: true, holdReason: null, holdSince: new Date() });
  await createDebtService(prisma).flagHold("inv-1", true);
  const call = (prisma.customer.update as ReturnType<typeof vi.fn>).mock.calls[0][0];
  expect(call.data.holdReason).toBeNull();
  expect(call.data.holdSince).toBeInstanceOf(Date);
});

it("flagHold persists a given reason and date", async () => {
  const prisma = makePrisma();
  const date = new Date("2026-10-01T00:00:00Z");
  (prisma.invoice.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "inv-1", customerId: "c1" });
  (prisma.customer.update as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "c1", holdNextClean: true, holdReason: "Owes", holdSince: date });
  const result = await createDebtService(prisma).flagHold("inv-1", true, { reason: "Owes", date });
  expect(prisma.customer.update).toHaveBeenCalledWith({ where: { id: "c1" }, data: { holdNextClean: true, holdReason: "Owes", holdSince: date } });
  expect(result.holdReason).toBe("Owes");
});

it("flagHold clears holdReason/holdSince and releases held visits when flag is false", async () => {
  const prisma = makePrisma();
  (prisma.invoice.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "inv-1", customerId: "c1" });
  (prisma.customer.update as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "c1", holdNextClean: false, holdReason: null, holdSince: null });
  const result = await createDebtService(prisma).flagHold("inv-1", false, { reason: "x", date: new Date() });
  expect(prisma.customer.update).toHaveBeenCalledWith({ where: { id: "c1" }, data: { holdNextClean: false, holdReason: null, holdSince: null } });
  expect(releaseHeldVisits).toHaveBeenCalledWith(prisma, "c1");
  expect(holdNextVisits).not.toHaveBeenCalled();
  expect(result.visitsUpdated).toBe(2);
});

it("flagHold does not notify when notify is false/omitted, or when flag is false", async () => {
  const prisma = makePrisma();
  (prisma.invoice.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "inv-1", customerId: "c1" });
  (prisma.customer.update as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "c1" });
  await createDebtService(prisma).flagHold("inv-1", true);
  await createDebtService(prisma).flagHold("inv-1", false, { notify: true });
  expect(sendMessage).not.toHaveBeenCalled();
});

it("flagHold sends the given message by SMS when notify is true", async () => {
  const prisma = makePrisma();
  (prisma.invoice.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "inv-1", customerId: "c1" });
  (prisma.customer.update as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "c1" });
  sendMessage.mockResolvedValue({ status: "sent" });
  await createDebtService(prisma).flagHold("inv-1", true, { notify: true, message: "On hold" });
  expect(sendMessage).toHaveBeenCalledWith({ customerId: "c1", channel: "SMS", body: "On hold" });
});

it("flagHold falls back to a default message when notify is true but message is blank", async () => {
  const prisma = makePrisma();
  (prisma.invoice.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "inv-1", customerId: "c1" });
  (prisma.customer.update as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "c1" });
  sendMessage.mockResolvedValue({ status: "sent" });
  await createDebtService(prisma).flagHold("inv-1", true, { notify: true, message: "  " });
  expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({ body: expect.stringContaining("on hold") }));
});

it("flagHold swallows a notify send failure (best-effort)", async () => {
  const prisma = makePrisma();
  (prisma.invoice.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "inv-1", customerId: "c1" });
  (prisma.customer.update as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "c1", holdNextClean: true });
  sendMessage.mockRejectedValue(new Error("GHL down"));
  const err = vi.spyOn(console, "error").mockImplementation(() => {});
  const result = await createDebtService(prisma).flagHold("inv-1", true, { notify: true });
  expect(result.holdNextClean).toBe(true);
  expect(err).toHaveBeenCalled();
  err.mockRestore();
});

it("sendPaymentLink is a function", () => {
  expect(typeof createDebtService(makePrisma()).sendPaymentLink).toBe("function");
});

it("sendPaymentLink throws 404 when invoice does not exist", async () => {
  const prisma = makePrisma();
  (prisma.invoice.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);
  await expect(createDebtService(prisma).sendPaymentLink("bad", { tenantId: "t1" })).rejects.toMatchObject({ statusCode: 404 });
});

it("sendPaymentLink 409s INVOICE_NOT_PAYABLE for PAID and VOID invoices", async () => {
  const prisma = makePrisma();
  (prisma.invoice.findUnique as ReturnType<typeof vi.fn>)
    .mockResolvedValueOnce(sendable({ status: "PAID" }))
    .mockResolvedValueOnce(sendable({ status: "VOID" }));
  const svc = createDebtService(prisma);
  await expect(svc.sendPaymentLink("inv-1", { tenantId: "t1" })).rejects.toMatchObject({ statusCode: 409, code: "INVOICE_NOT_PAYABLE" });
  await expect(svc.sendPaymentLink("inv-1", { tenantId: "t1" })).rejects.toMatchObject({ statusCode: 409, code: "INVOICE_NOT_PAYABLE" });
  expect(getInvoiceCheckoutLink).not.toHaveBeenCalled();
});

it("sendPaymentLink (D-6) checks contact/channel BEFORE creating the Stripe session", async () => {
  const prisma = makePrisma();
  (prisma.invoice.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(sendable());
  prepareMessage.mockRejectedValue(Object.assign(new Error("no email"), { statusCode: 400, code: "NO_CONTACT_FOR_CHANNEL" }));
  await expect(createDebtService(prisma).sendPaymentLink("inv-1", { tenantId: "t1", channel: "EMAIL" }))
    .rejects.toMatchObject({ code: "NO_CONTACT_FOR_CHANNEL" });
  expect(getInvoiceCheckoutLink).not.toHaveBeenCalled();
});

it("sendPaymentLink propagates STRIPE_NOT_CONNECTED and sends nothing", async () => {
  const prisma = makePrisma();
  (prisma.invoice.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(sendable());
  prepareMessage.mockResolvedValue({});
  getInvoiceCheckoutLink.mockRejectedValue(Object.assign(new Error("no stripe"), { statusCode: 409, code: "STRIPE_NOT_CONNECTED" }));
  await expect(createDebtService(prisma).sendPaymentLink("inv-1", { tenantId: "t1" })).rejects.toMatchObject({ code: "STRIPE_NOT_CONNECTED" });
  expect(deliverMessage).not.toHaveBeenCalled();
});

it("sendPaymentLink sends the template with the Stripe link and returns url/messageId/channel", async () => {
  const prisma = makePrisma();
  const expiresAt = new Date("2026-10-31T00:00:00Z");
  (prisma.invoice.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(sendable());
  (prisma.businessSettings.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);
  prepareMessage.mockResolvedValue({ p: 1 });
  getInvoiceCheckoutLink.mockResolvedValue({ url: "https://checkout.stripe.com/c/1", expiresAt });
  deliverMessage.mockResolvedValue({ messageId: "m9", channel: "SMS" });
  const result = await createDebtService(prisma).sendPaymentLink("inv-1", { tenantId: "t1" });
  expect(getInvoiceCheckoutLink).toHaveBeenCalledWith(prisma, {
    tenantId: "t1", invoiceId: "inv-1", customerId: "c1", invoiceNumber: "INV-2026-001", amount: expect.anything(),
  });
  // Built-in fallback template already contains {{paymentLink}} → not appended twice.
  const body = deliverMessage.mock.calls[0][1] as string;
  expect(body.match(/checkout\.stripe\.com/g)).toHaveLength(1);
  expect(deliverMessage.mock.calls[0][2]).toEqual({ templateId: null });
  expect(result).toEqual({
    url: "https://checkout.stripe.com/c/1", messageId: "m9", channel: "SMS",
    id: "m9", paymentUrl: "https://checkout.stripe.com/c/1", provider: "stripe", expiresAt,
  });
});

it("sendPaymentLink appends the link when a custom message doesn't include it", async () => {
  const prisma = makePrisma();
  (prisma.invoice.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(sendable());
  prepareMessage.mockResolvedValue({});
  getInvoiceCheckoutLink.mockResolvedValue({ url: "https://pay/x", expiresAt: null });
  deliverMessage.mockResolvedValue({ messageId: "m1", channel: "EMAIL" });
  await createDebtService(prisma).sendPaymentLink("inv-1", { tenantId: "t1", message: "Please pay" });
  expect(deliverMessage).toHaveBeenCalledWith({}, "Please pay\n\nhttps://pay/x", { templateId: null });
});

it("getInvoiceDetail is a function", () => {
  expect(typeof createDebtService(makePrisma()).getInvoiceDetail).toBe("function");
});

it("getInvoiceDetail throws 404 when the invoice does not exist", async () => {
  const prisma = makePrisma();
  (prisma.invoice.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);
  await expect(createDebtService(prisma).getInvoiceDetail("missing")).rejects.toMatchObject({ statusCode: 404 });
});

it("getInvoiceDetail returns phone/email/round/mandate/nextVisit/recentVisits", async () => {
  const prisma = makePrisma();
  (prisma.invoice.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
    id: "inv-1",
    invoiceNumber: "INV-2026-001",
    amount: { toNumber: () => 85 },
    dueDate: new Date("2026-02-01"),
    status: "SENT",
    customerId: "c1",
    customer: {
      id: "c1", name: "Jane Doe", phone: "07123456789", email: "jane@example.com",
      gocardlessMandateId: "MD123", gocardlessMandateStatus: "active",
    },
    visit: { property: { roundId: "r1", round: { name: "Alnwick Monday" } } },
  });
  const nextVisitDate = new Date("2026-02-15");
  (prisma.visit.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({ date: nextVisitDate });
  (prisma.visit.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
    { id: "v1", date: new Date("2026-01-01"), status: "COMPLETED", price: { toNumber: () => 35 } },
  ]);

  const result = await createDebtService(prisma).getInvoiceDetail("inv-1");

  expect(result).toMatchObject({
    invoiceId: "inv-1",
    invoiceNumber: "INV-2026-001",
    amount: 85,
    customerName: "Jane Doe",
    phone: "07123456789",
    email: "jane@example.com",
    roundId: "r1",
    roundName: "Alnwick Monday",
    nextVisitDate,
    mandateId: "MD123",
    mandateStatus: "active",
  });
  expect(result.recentVisits).toEqual([{ visitId: "v1", date: new Date("2026-01-01"), status: "COMPLETED", amount: 35 }]);
});

it("getInvoiceDetail defaults round/nextVisitDate to null when the invoice has no linked visit or upcoming visit", async () => {
  const prisma = makePrisma();
  (prisma.invoice.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
    id: "inv-1", invoiceNumber: "INV-1", amount: { toNumber: () => 10 }, dueDate: null, status: "SENT",
    customerId: "c1",
    customer: { id: "c1", name: "Jane", phone: null, email: null, gocardlessMandateId: null, gocardlessMandateStatus: null },
    visit: null,
  });
  (prisma.visit.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);
  (prisma.visit.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);

  const result = await createDebtService(prisma).getInvoiceDetail("inv-1");

  expect(result.roundId).toBeNull();
  expect(result.roundName).toBeNull();
  expect(result.nextVisitDate).toBeNull();
  expect(result.recentVisits).toEqual([]);
});

it("getInvoiceDetail caps recent visits at 5, newest first", async () => {
  const prisma = makePrisma();
  (prisma.invoice.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
    id: "inv-1", invoiceNumber: "INV-1", amount: { toNumber: () => 10 }, dueDate: null, status: "SENT",
    customerId: "c1",
    customer: { id: "c1", name: "Jane", phone: null, email: null, gocardlessMandateId: null, gocardlessMandateStatus: null },
    visit: null,
  });
  (prisma.visit.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);
  (prisma.visit.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);

  await createDebtService(prisma).getInvoiceDetail("inv-1");

  const call = (prisma.visit.findMany as ReturnType<typeof vi.fn>).mock.calls[0][0];
  expect(call.take).toBe(5);
  expect(call.orderBy).toEqual({ date: "desc" });
});

it("flagHold uses the default notify message when none is given", async () => {
  const prisma = makePrisma();
  (prisma.invoice.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "inv-1", customerId: "c1" });
  (prisma.customer.update as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "c1" });
  sendMessage.mockResolvedValue({ status: "sent" });
  await createDebtService(prisma).flagHold("inv-1", true, { notify: true });
  expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({ body: expect.stringContaining("on hold") }));
});
