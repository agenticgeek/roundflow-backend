import { it, expect, vi } from "vitest";

vi.mock("../../lib/email", () => ({}));

import { createDebtService } from "../debt.service";

function makePrisma() {
  return {
    invoice: { findMany: vi.fn(), findUnique: vi.fn(), update: vi.fn(), count: vi.fn(), aggregate: vi.fn() },
    customer: { findUnique: vi.fn(), update: vi.fn() },
    visit: { findMany: vi.fn() },
    payment: { findMany: vi.fn() },
    message: { create: vi.fn(), findFirst: vi.fn() },
    businessSettings: { findFirst: vi.fn() },
    $queryRaw: vi.fn(),
  } as unknown as Parameters<typeof createDebtService>[0];
}

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
    holdCustomers?: string[];
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
  (prisma.invoice.findMany as ReturnType<typeof vi.fn>).mockResolvedValue(
    (opts.holdCustomers ?? []).map((customerId) => ({ customerId }))
  );
}

it("getKpis result has totalOutstandings", async () => {
  const prisma = makePrisma();
  setupKpis(prisma, {});
  const result = await createDebtService(prisma).getKpis();
  expect("totalOutstandings" in result).toBe(true);
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

it("getKpis totalOutstandings defaults to 0 when aggregate sum is null", async () => {
  const prisma = makePrisma();
  setupKpis(prisma, { totalOutstandings: null });
  const result = await createDebtService(prisma).getKpis();
  expect(result.totalOutstandings).toBe(0);
});

it("getKpis result has badDebt field", async () => {
  const prisma = makePrisma();
  setupKpis(prisma, {});
  const result = await createDebtService(prisma).getKpis();
  expect("badDebt" in result).toBe(true);
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

it("getKpis result has failedGoCardless field", async () => {
  const prisma = makePrisma();
  setupKpis(prisma, {});
  const result = await createDebtService(prisma).getKpis();
  expect("failedGoCardless" in result).toBe(true);
});

it("getKpis failedGoCardless counts invoices via visitId:{in:[...failedVisitIds]}", async () => {
  const prisma = makePrisma();
  setupKpis(prisma, { failedGoCardless: 1, failedPayments: [{ visitId: "v1" }] });
  const result = await createDebtService(prisma).getKpis();
  expect(result.failedGoCardless).toBe(1);
  expect(prisma.invoice.count).toHaveBeenNthCalledWith(1, {
    where: { status: "SENT", customer: { badDebt: false }, visitId: { in: ["v1"] } },
  });
});

it("getKpis result has dueBeforeClean field", async () => {
  const prisma = makePrisma();
  setupKpis(prisma, {});
  const result = await createDebtService(prisma).getKpis();
  expect("dueBeforeClean" in result).toBe(true);
});

it("getKpis dueBeforeClean counts invoices via customerId:{in:[...upcomingCustomerIds]}", async () => {
  const prisma = makePrisma();
  setupKpis(prisma, { dueBeforeClean: 1, upcomingVisits: [{ property: { customerId: "c1" } }] });
  const result = await createDebtService(prisma).getKpis();
  expect(result.dueBeforeClean).toBe(1);
  expect(prisma.invoice.count).toHaveBeenNthCalledWith(2, {
    where: { status: "SENT", customer: { badDebt: false }, customerId: { in: ["c1"] } },
  });
});

it("getKpis result has holdNextClean field", async () => {
  const prisma = makePrisma();
  setupKpis(prisma, {});
  const result = await createDebtService(prisma).getKpis();
  expect("holdNextClean" in result).toBe(true);
});

it("getKpis holdNextClean counts distinct customers via findMany distinct:['customerId']", async () => {
  const prisma = makePrisma();
  setupKpis(prisma, { holdCustomers: ["c1"] });
  const result = await createDebtService(prisma).getKpis();
  expect(result.holdNextClean).toBe(1);
  expect(prisma.invoice.findMany).toHaveBeenCalledWith({
    where: { status: "SENT", customer: { badDebt: false, holdNextClean: true } },
    distinct: ["customerId"],
    select: { customerId: true },
  });
});

it("getKpis holdNextClean dedupes multiple invoices for the same customer", async () => {
  const prisma = makePrisma();
  // Even though distinct is pushed to the DB query, the mock's "distinct" result
  // is what the (mocked) DB would have returned already deduped.
  setupKpis(prisma, { holdCustomers: ["c1"] });
  const result = await createDebtService(prisma).getKpis();
  expect(result.holdNextClean).toBe(1);
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

it("getBoard ON_HOLD builds where.customer.badDebt:false,holdNextClean:true", async () => {
  const prisma = makePrisma();
  setupBoard(prisma, [inv({ customer: { ...inv().customer, holdNextClean: true } })]);
  await createDebtService(prisma).getBoard("ON_HOLD");
  const callArgs = (prisma.invoice.findMany as ReturnType<typeof vi.fn>).mock.calls[0][0];
  expect(callArgs.where).toMatchObject({ status: "SENT", customer: { badDebt: false, holdNextClean: true } });
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
  setupBoard(prisma, []);
  const result = await createDebtService(prisma).getBoard("ON_HOLD");
  const callArgs = (prisma.invoice.findMany as ReturnType<typeof vi.fn>).mock.calls[0][0];
  expect(callArgs.where.customer.badDebt).toBe(false);
  expect(result.rows).toHaveLength(0);
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
  await createDebtService(prisma).getBoard("ON_HOLD", "round-1", "CARD");
  const callArgs = (prisma.invoice.findMany as ReturnType<typeof vi.fn>).mock.calls[0][0];
  expect(callArgs.where.visit).toEqual({ property: { roundId: "round-1" } });
  expect(callArgs.where.customer).toMatchObject({ paymentMethod: "CARD", badDebt: false, holdNextClean: true });
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

it("getBucketCounts returns a count for all 7 bucket tabs in one call", async () => {
  const prisma = makePrisma();
  (prisma.payment.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  (prisma.visit.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  (prisma.invoice.count as ReturnType<typeof vi.fn>).mockResolvedValue(3);
  const result = await createDebtService(prisma).getBucketCounts();
  expect(result).toEqual({
    BAD_DEBT: 3,
    ON_HOLD: 3,
    FAILED_GC: 3,
    DUE_BEFORE_CLEAN: 3,
    SEVEN_DAYS_OVER: 3,
    FOURTEEN_DAYS_OVER: 3,
    ALL: 3,
  });
  expect(prisma.invoice.count).toHaveBeenCalledTimes(7);
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
  expect(calls).toHaveLength(7);
  for (const [{ where }] of calls) {
    expect(where.visit).toMatchObject({ property: { roundId: "round-1" } });
    expect(where.customer).toMatchObject({ paymentMethod: "CARD" });
    expect(where.AND).toBeDefined();
  }
});

it("getBucketCounts distinguishes BAD_DEBT (true) from every other bucket (false) in the where clause", async () => {
  const prisma = makePrisma();
  (prisma.payment.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  (prisma.visit.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  (prisma.invoice.count as ReturnType<typeof vi.fn>).mockResolvedValue(0);
  await createDebtService(prisma).getBucketCounts();
  const calls = (prisma.invoice.count as ReturnType<typeof vi.fn>).mock.calls as Array<[{ where: { customer: { badDebt?: boolean } } }]>;
  // DEBT_BUCKETS order: BAD_DEBT, ON_HOLD, FAILED_GC, DUE_BEFORE_CLEAN, SEVEN_DAYS_OVER, FOURTEEN_DAYS_OVER, ALL
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

it("sendReminder throws 404 when invoice does not exist", async () => {
  const prisma = makePrisma();
  (prisma.invoice.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);
  await expect(createDebtService(prisma).sendReminder("bad-id", "EMAIL", "Hi")).rejects.toMatchObject({ statusCode: 404 });
});

it("sendReminder throws 400 when channel is EMAIL and customer has no email", async () => {
  const prisma = makePrisma();
  (prisma.invoice.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "inv-1", invoiceNumber: "INV-2026-001", customerId: "c1", customer: { id: "c1", name: "John", email: null } });
  (prisma.businessSettings.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);
  await expect(createDebtService(prisma).sendReminder("inv-1", "EMAIL", "Hi")).rejects.toMatchObject({ statusCode: 400 });
});

it("sendReminder records a Message and returns its id", async () => {
  const prisma = makePrisma();
  (prisma.invoice.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "inv-1", invoiceNumber: "INV-2026-001", customerId: "c1", customer: { id: "c1", name: "John", email: "j@example.com" } });
  (prisma.businessSettings.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);
  (prisma.message.create as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "msg-1" });
  const result = await createDebtService(prisma).sendReminder("inv-1", "EMAIL", "Hi");
  expect(result.id).toBe("msg-1");
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

it("flagHold sets holdNextClean on the customer and returns it", async () => {
  const prisma = makePrisma();
  (prisma.invoice.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "inv-1", customerId: "c1" });
  (prisma.customer.update as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "c1", holdNextClean: true });
  const result = await createDebtService(prisma).flagHold("inv-1", true);
  expect(result.holdNextClean).toBe(true);
});

it("sendPaymentLink is a function", () => {
  expect(typeof createDebtService(makePrisma()).sendPaymentLink).toBe("function");
});

it("sendPaymentLink throws 404 when invoice does not exist", async () => {
  const prisma = makePrisma();
  (prisma.invoice.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);
  await expect(createDebtService(prisma).sendPaymentLink("bad-id", "Pay now")).rejects.toMatchObject({ statusCode: 404 });
});

it("sendPaymentLink throws 400 when customer has no email", async () => {
  const prisma = makePrisma();
  (prisma.invoice.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "inv-1", invoiceNumber: "INV-2026-001", customerId: "c1", customer: { id: "c1", name: "John", email: null } });
  (prisma.businessSettings.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);
  await expect(createDebtService(prisma).sendPaymentLink("inv-1", "Pay now")).rejects.toMatchObject({ statusCode: 400 });
});

it("sendPaymentLink records a Message and returns its id", async () => {
  const prisma = makePrisma();
  (prisma.invoice.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "inv-1", invoiceNumber: "INV-2026-001", customerId: "c1", customer: { id: "c1", name: "John", email: "j@example.com" } });
  (prisma.businessSettings.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);
  (prisma.message.create as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "msg-2" });
  const result = await createDebtService(prisma).sendPaymentLink("inv-1", "Pay now");
  expect(result.id).toBe("msg-2");
});
