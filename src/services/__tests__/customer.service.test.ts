import { it, expect, vi } from "vitest";
import { createCustomerService } from "../customer.service";
import { LifecycleStatus, VisitStatus, PaymentStatus } from "../../generated/tenant-client";
import { UserRole } from "@prisma/client";

function makePrisma() {
  return {
    customer: { findMany: vi.fn(), findUnique: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn(), count: vi.fn() },
    property: { findMany: vi.fn(), findUnique: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn(), count: vi.fn() },
    servicePlan: { findMany: vi.fn(), findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
    round: { findMany: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
    serviceArea: { findUnique: vi.fn() },
    visit: { findMany: vi.fn(), updateMany: vi.fn(), createMany: vi.fn() },
    payment: { findMany: vi.fn(), aggregate: vi.fn() },
    propertyNote: { findMany: vi.fn(), create: vi.fn() },
    photo: { findMany: vi.fn() },
    issue: { findMany: vi.fn(), count: vi.fn().mockResolvedValue(0) },
    invoice: { findMany: vi.fn() },
    businessSettings: { findFirst: vi.fn() },
    $transaction: vi.fn((cb: any) => cb(makePrisma())),
  } as unknown as Parameters<typeof createCustomerService>[0];
}

it("createCustomerService returns an object", () => {
  expect(createCustomerService(makePrisma())).toBeDefined();
});

it("createProperty writes landline to the customer", async () => {
  const prisma = makePrisma();
  (prisma.serviceArea.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "sa1" });
  (prisma.$transaction as ReturnType<typeof vi.fn>).mockImplementation((cb: any) => cb(makePrisma()));
  const _innerPrisma = (prisma.$transaction as ReturnType<typeof vi.fn>).mock.calls;
  // Capture what was written to customer.create inside the transaction
  let capturedCreate: any;
  const txPrisma = {
    ...makePrisma(),
    customer: {
      ...makePrisma().customer,
      create: vi.fn().mockImplementation((args: any) => {
        capturedCreate = args;
        return Promise.resolve({ id: "c1" });
      }),
    },
    serviceArea: { findUnique: vi.fn().mockResolvedValue({ id: "sa1" }) },
    property: { create: vi.fn().mockResolvedValue({ id: "p1" }) },
    servicePlan: { create: vi.fn().mockResolvedValue({ id: "sp1" }) },
    round: { findUnique: vi.fn().mockResolvedValue(null) },
  };
  (prisma.$transaction as ReturnType<typeof vi.fn>).mockImplementation((cb: any) => cb(txPrisma));
  await createCustomerService(prisma).createProperty({
    customerName: "John Smith",
    phone: "+44 7700 900111",
    landline: "+44 1665 000111",
    addressLine: "12 Market St",
    postcode: "NE66 1SS",
    serviceAreaId: "sa1",
    price: 35,
  });
  expect(capturedCreate.data.landline).toBe("+44 1665 000111");
});

it("updateCustomer writes landline when provided", async () => {
  const prisma = makePrisma();
  (prisma.customer.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
    id: "c1", name: "John", phone: null, landline: null, email: null,
    properties: [{ id: "p1", roundId: null, servicePlans: [{ id: "sp1" }] }],
  });
  let capturedUpdate: any;
  const txPrisma = {
    ...makePrisma(),
    customer: {
      ...makePrisma().customer,
      update: vi.fn().mockImplementation((args: any) => {
        capturedUpdate = args;
        return Promise.resolve({ id: "c1" });
      }),
    },
    property: { update: vi.fn().mockResolvedValue({ id: "p1" }) },
    servicePlan: { update: vi.fn().mockResolvedValue({ id: "sp1" }) },
    round: { findUnique: vi.fn().mockResolvedValue(null) },
  };
  (prisma.$transaction as ReturnType<typeof vi.fn>).mockImplementation((cb: any) => cb(txPrisma));
  await createCustomerService(prisma).updateCustomer("c1", {
    landline: "+44 1665 000111",
  });
  expect(capturedUpdate.data.landline).toBe("+44 1665 000111");
});

// ── getCustomerDetail: servicePlans array ──────────────────────────────────

function makeCustomerWithPlans(plans: object[]) {
  return {
    id: "c1",
    name: "Alice",
    phone: null,
    landline: null,
    email: null,
    status: LifecycleStatus.ACTIVE,
    ghlContactId: null,
    payments: [],
    properties: [
      {
        id: "p1",
        status: LifecycleStatus.ACTIVE,
        addressLine: "1 Test St",
        postcode: "T1 1TT",
        propertyType: null,
        accessNotes: null,
        riskNotes: null,
        roundId: null,
        serviceAreaId: null,
        round: null,
        serviceArea: null,
        notes: [],
        photos: [],
        visits: [],
        servicePlans: plans,
      },
    ],
  };
}

function makeSettings() {
  return { paymentRule: null };
}

it("getCustomerDetail returns servicePlans array with 2 items when property has 2 plans", async () => {
  const prisma = makePrisma();
  const plans = [
    { id: "sp1", serviceId: null, service: null, price: 40, cleanMethod: null, paymentMethod: null, cleaningFrequency: "FOUR_WEEKLY", status: LifecycleStatus.ACTIVE, nextDueDate: null, lastCompleted: null, pauseStartDate: null, pauseEndDate: null },
    { id: "sp2", serviceId: "svc1", service: { name: "Gutters" }, price: 80, cleanMethod: null, paymentMethod: null, cleaningFrequency: "TWELVE_WEEKLY", status: LifecycleStatus.ACTIVE, nextDueDate: null, lastCompleted: null, pauseStartDate: null, pauseEndDate: null },
  ];
  (prisma.customer.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(makeCustomerWithPlans(plans));
  (prisma.businessSettings.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(makeSettings());

  const result = await createCustomerService(prisma).getCustomerDetail("c1", UserRole.ADMIN);

  expect(result.servicePlans).toHaveLength(2);
  expect(result.servicePlans[0].id).toBe("sp1");
  expect(result.servicePlans[1].id).toBe("sp2");
  expect(result.servicePlans[1].serviceName).toBe("Gutters");
  expect(result.tabs.servicePlans).toHaveLength(2);
  // Both plans are ACTIVE; primaryPlan()'s rule picks the first one found.
  expect(result.servicePlans[0].isPrimary).toBe(true);
  expect(result.servicePlans[1].isPrimary).toBe(false);
});

it("getCustomerDetail marks exactly one servicePlan as isPrimary: true when a later plan is ACTIVE and an earlier one is CANCELLED", async () => {
  const prisma = makePrisma();
  const plans = [
    { id: "sp1", serviceId: null, service: null, price: 40, cleanMethod: null, paymentMethod: null, cleaningFrequency: "FOUR_WEEKLY", status: LifecycleStatus.CANCELLED, nextDueDate: null, lastCompleted: null, pauseStartDate: null, pauseEndDate: null },
    { id: "sp2", serviceId: null, service: null, price: 80, cleanMethod: null, paymentMethod: null, cleaningFrequency: "TWELVE_WEEKLY", status: LifecycleStatus.ACTIVE, nextDueDate: null, lastCompleted: null, pauseStartDate: null, pauseEndDate: null },
  ];
  (prisma.customer.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(makeCustomerWithPlans(plans));
  (prisma.businessSettings.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(makeSettings());

  const result = await createCustomerService(prisma).getCustomerDetail("c1", UserRole.ADMIN);

  expect(result.servicePlans.find((p) => p.id === "sp1")?.isPrimary).toBe(false);
  expect(result.servicePlans.find((p) => p.id === "sp2")?.isPrimary).toBe(true);
});

it("getCustomerDetail falls back the primary plan to servicePlans[0] when none are ACTIVE, marking only that one isPrimary", async () => {
  const prisma = makePrisma();
  const plans = [
    { id: "sp1", serviceId: null, service: null, price: 40, cleanMethod: null, paymentMethod: null, cleaningFrequency: "FOUR_WEEKLY", status: LifecycleStatus.CANCELLED, nextDueDate: null, lastCompleted: null, pauseStartDate: null, pauseEndDate: null },
    { id: "sp2", serviceId: null, service: null, price: 80, cleanMethod: null, paymentMethod: null, cleaningFrequency: "TWELVE_WEEKLY", status: LifecycleStatus.CANCELLED, nextDueDate: null, lastCompleted: null, pauseStartDate: null, pauseEndDate: null },
  ];
  (prisma.customer.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(makeCustomerWithPlans(plans));
  (prisma.businessSettings.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(makeSettings());

  const result = await createCustomerService(prisma).getCustomerDetail("c1", UserRole.ADMIN);

  expect(result.servicePlans.find((p) => p.id === "sp1")?.isPrimary).toBe(true);
  expect(result.servicePlans.find((p) => p.id === "sp2")?.isPrimary).toBe(false);
});

it("getCustomerDetail standingInfo uses active plan frequency when multiple plans exist", async () => {
  const prisma = makePrisma();
  const plans = [
    { id: "sp1", serviceId: null, service: null, price: 40, cleanMethod: null, paymentMethod: null, cleaningFrequency: "FOUR_WEEKLY", status: LifecycleStatus.ACTIVE, nextDueDate: null, lastCompleted: null, pauseStartDate: null, pauseEndDate: null },
    { id: "sp2", serviceId: null, service: null, price: 20, cleanMethod: null, paymentMethod: null, cleaningFrequency: "TWELVE_WEEKLY", status: LifecycleStatus.CANCELLED, nextDueDate: null, lastCompleted: null, pauseStartDate: null, pauseEndDate: null },
  ];
  (prisma.customer.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(makeCustomerWithPlans(plans));
  (prisma.businessSettings.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(makeSettings());

  const result = await createCustomerService(prisma).getCustomerDetail("c1", UserRole.ADMIN);

  expect(result.servicePlans).toHaveLength(2);
  expect(result.standingInfo.frequency).toBe("FOUR_WEEKLY");
});

it("getCustomerDetail returns empty servicePlans when property has no plans", async () => {
  const prisma = makePrisma();
  (prisma.customer.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(makeCustomerWithPlans([]));
  (prisma.businessSettings.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(makeSettings());

  const result = await createCustomerService(prisma).getCustomerDetail("c1", UserRole.ADMIN);

  expect(result.servicePlans).toEqual([]);
  expect(result.tabs.servicePlans).toEqual([]);
});

it("getCustomerDetail returns empty servicePlans when customer has no properties", async () => {
  const prisma = makePrisma();
  (prisma.customer.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
    id: "c1", name: "Bob", phone: null, landline: null, email: null,
    status: LifecycleStatus.ACTIVE, ghlContactId: null, payments: [], properties: [],
  });
  (prisma.businessSettings.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(makeSettings());

  const result = await createCustomerService(prisma).getCustomerDetail("c1", UserRole.ADMIN);

  expect(result.servicePlans).toEqual([]);
  expect(result.property).toBeNull();
});

// ── getCustomers: list filtering & pagination ──────────────────────────────

function makeListedCustomer(opts: {
  id: string;
  onHold?: boolean;
  paymentStatus?: PaymentStatus | null;
  amount?: number;
}) {
  const { id, onHold = false, paymentStatus = null, amount = 0 } = opts;
  return {
    id,
    name: `Customer ${id}`,
    status: LifecycleStatus.ACTIVE,
    payments: paymentStatus
      ? [{ status: paymentStatus, amount, createdAt: new Date("2026-01-01") }]
      : [],
    properties: [
      {
        id: `p-${id}`,
        status: LifecycleStatus.ACTIVE,
        addressLine: "1 Test St",
        postcode: "T1 1TT",
        roundId: null,
        round: null,
        servicePlans: [],
        visits: onHold
          ? [{ paymentHold: true, technicianId: null, technician: null }]
          : [],
      },
    ],
  };
}

function mockSummaryCounts(
  prisma: ReturnType<typeof makePrisma>,
  { total, active, holds }: { total: number; active: number; holds: number }
) {
  (prisma.customer.count as ReturnType<typeof vi.fn>)
    .mockResolvedValueOnce(total)
    .mockResolvedValueOnce(active)
    .mockResolvedValueOnce(holds);
  (prisma.payment.aggregate as ReturnType<typeof vi.fn>).mockResolvedValue({
    _sum: { amount: 0 },
  });
}

it("getCustomers({status:'HOLD'}) pushes the paymentHold semi-join into `where` and paginates at the DB level", async () => {
  const prisma = makePrisma();
  mockSummaryCounts(prisma, { total: 20, active: 13, holds: 7 });
  // 4th call to customer.count is the paginated HOLD-filtered count.
  (prisma.customer.count as ReturnType<typeof vi.fn>).mockResolvedValueOnce(7);
  const page2 = [
    makeListedCustomer({ id: "h3", onHold: true }),
    makeListedCustomer({ id: "h4", onHold: true }),
  ];
  (prisma.customer.findMany as ReturnType<typeof vi.fn>).mockResolvedValue(page2);

  const result = await createCustomerService(prisma).getCustomers(
    { status: "HOLD", page: 2, pageSize: 2 },
    UserRole.ADMIN
  );

  expect(result.customers).toHaveLength(2);
  expect(result.customers.map((c) => c.customerId)).toEqual(["h3", "h4"]);
  expect(result.pagination).toEqual({ page: 2, pageSize: 2, total: 7, totalPages: 4 });

  // Must NOT be a bare fetch-all: where.properties.some.visits.some carries the
  // paymentHold semi-join, and take/skip are passed straight to findMany.
  const findManyArgs = (prisma.customer.findMany as ReturnType<typeof vi.fn>).mock.calls[0][0];
  expect(findManyArgs.take).toBe(2);
  expect(findManyArgs.skip).toBe(2);
  expect(findManyArgs.where.properties.some.visits.some).toEqual({
    paymentHold: true,
    status: { in: [VisitStatus.SCHEDULED, VisitStatus.IN_PROGRESS] },
  });

  // Pagination count must use the same where (the HOLD semi-join), not count().
  const countCalls = (prisma.customer.count as ReturnType<typeof vi.fn>).mock.calls;
  const paginatedCountArgs = countCalls[countCalls.length - 1][0];
  expect(paginatedCountArgs.where.properties.some.visits.some.paymentHold).toBe(true);
});

it("getCustomers({status:'HOLD', roundId}) combines the roundId filter with the paymentHold semi-join", async () => {
  const prisma = makePrisma();
  mockSummaryCounts(prisma, { total: 5, active: 3, holds: 2 });
  (prisma.customer.count as ReturnType<typeof vi.fn>).mockResolvedValueOnce(2);
  (prisma.customer.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
    makeListedCustomer({ id: "h1", onHold: true }),
  ]);

  await createCustomerService(prisma).getCustomers(
    { status: "HOLD", roundId: "r1" },
    UserRole.ADMIN
  );

  const findManyArgs = (prisma.customer.findMany as ReturnType<typeof vi.fn>).mock.calls[0][0];
  expect(findManyArgs.where.properties.some.roundId).toBe("r1");
  expect(findManyArgs.where.properties.some.visits.some.paymentHold).toBe(true);
});

it.each(["ACTIVE", "PAUSED", "CANCELLED", undefined] as const)(
  "getCustomers(%s) uses plain status where and the standard count+findMany path",
  async (status) => {
    const prisma = makePrisma();
    mockSummaryCounts(prisma, { total: 10, active: 6, holds: 1 });
    (prisma.customer.count as ReturnType<typeof vi.fn>).mockResolvedValueOnce(1);
    const fixture = makeListedCustomer({
      id: "c1",
      paymentStatus: PaymentStatus.PENDING,
      amount: 50,
    });
    (prisma.customer.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([fixture]);

    const result = await createCustomerService(prisma).getCustomers(
      status ? { status } : {},
      UserRole.ADMIN
    );

    expect(result.customers).toHaveLength(1);
    expect(result.customers[0].customerId).toBe("c1");
    expect(result.customers[0].amountDue).toBe(50);
    expect(result.customers[0].paymentStatus).toBe("pending");
    expect(result.pagination.total).toBe(1);

    const findManyArgs = (prisma.customer.findMany as ReturnType<typeof vi.fn>).mock.calls[0][0];
    if (status) {
      expect(findManyArgs.where.status).toBe(status);
    } else {
      expect(findManyArgs.where.status).toBeUndefined();
    }
    // Regression guard: non-HOLD statuses never get the paymentHold semi-join.
    expect(findManyArgs.where.properties).toBeUndefined();
  }
);

it("getCustomers sums amountDue across ALL due-status payments, not just the latest", async () => {
  // Regression test for: `payments` include was briefly capped to `take: 1`
  // for an over-fetch "optimization", which silently undercounted amountDue
  // since toRow() sums every due-status payment, not just payments[0].
  const prisma = makePrisma();
  mockSummaryCounts(prisma, { total: 1, active: 1, holds: 0 });
  (prisma.customer.count as ReturnType<typeof vi.fn>).mockResolvedValueOnce(1);
  const fixture = makeListedCustomer({ id: "c1" });
  fixture.payments = [
    { status: PaymentStatus.PENDING, amount: 50, createdAt: new Date("2026-02-01") },
    { status: PaymentStatus.OVERDUE, amount: 30, createdAt: new Date("2026-01-01") },
  ];
  (prisma.customer.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([fixture]);

  const result = await createCustomerService(prisma).getCustomers({}, UserRole.ADMIN);

  expect(result.customers[0].amountDue).toBe(80);
  // The include must not cap payments — toRow() needs the full due-payment set.
  const findManyArgs = (prisma.customer.findMany as ReturnType<typeof vi.fn>).mock.calls[0][0];
  expect(findManyArgs.include.payments.take).toBeUndefined();
});

it("getCustomers({status:'HOLD'}) returns a multi-property customer whose onHold visit is on a non-primary property, with onHold=true", async () => {
  // Regression test for: the HOLD filter matches if ANY property has an
  // on-hold visit, but toRow() used to compute `onHold` only from the single
  // primary (active-or-first) property — a customer could match the filter
  // via a secondary property while its own `onHold` field stayed false.
  const prisma = makePrisma();
  mockSummaryCounts(prisma, { total: 1, active: 0, holds: 1 });
  (prisma.customer.count as ReturnType<typeof vi.fn>).mockResolvedValueOnce(1);
  const multiPropertyCustomer = {
    id: "c1",
    name: "Customer c1",
    status: LifecycleStatus.ACTIVE,
    payments: [],
    properties: [
      {
        // Primary (active, listed first): no on-hold visit.
        id: "p-primary",
        status: LifecycleStatus.ACTIVE,
        addressLine: "1 Primary St",
        postcode: "P1 1PP",
        roundId: null,
        round: null,
        servicePlans: [],
        visits: [],
      },
      {
        // Secondary (not active): has the on-hold visit.
        id: "p-secondary",
        status: LifecycleStatus.PAUSED,
        addressLine: "2 Secondary St",
        postcode: "S1 1SS",
        roundId: null,
        round: null,
        servicePlans: [],
        visits: [{ paymentHold: true, technicianId: null, technician: null }],
      },
    ],
  };
  (prisma.customer.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([multiPropertyCustomer]);

  const result = await createCustomerService(prisma).getCustomers(
    { status: "HOLD" },
    UserRole.ADMIN
  );

  expect(result.customers).toHaveLength(1);
  expect(result.customers[0].customerId).toBe("c1");
  expect(result.customers[0].onHold).toBe(true);
});

it("getCustomers hides amountDue for TECHNICIAN viewers", async () => {
  const prisma = makePrisma();
  mockSummaryCounts(prisma, { total: 1, active: 1, holds: 0 });
  (prisma.customer.count as ReturnType<typeof vi.fn>).mockResolvedValueOnce(1);
  (prisma.customer.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
    makeListedCustomer({ id: "c1" }),
  ]);

  const result = await createCustomerService(prisma).getCustomers({}, UserRole.TECHNICIAN);

  expect(result.customers[0].amountDue).toBeUndefined();
  expect(result.summary.amountDue).toBeUndefined();
});

it("getCustomers rejects an invalid status filter", async () => {
  const prisma = makePrisma();
  await expect(
    createCustomerService(prisma).getCustomers({ status: "BOGUS" }, UserRole.ADMIN)
  ).rejects.toMatchObject({ statusCode: 400 });
});

it("getCustomers skips customers with no properties", async () => {
  const prisma = makePrisma();
  mockSummaryCounts(prisma, { total: 1, active: 1, holds: 0 });
  (prisma.customer.count as ReturnType<typeof vi.fn>).mockResolvedValueOnce(1);
  (prisma.customer.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
    { id: "c1", name: "No Property", status: LifecycleStatus.ACTIVE, payments: [], properties: [] },
  ]);

  const result = await createCustomerService(prisma).getCustomers({}, UserRole.ADMIN);

  expect(result.customers).toEqual([]);
});

// ── getCustomerDetail: visit/payment caps ──────────────────────────────────

function makeVisit(opts: {
  id: string;
  date: Date;
  status?: VisitStatus;
  paymentHold?: boolean;
}) {
  const { id, date, status = VisitStatus.COMPLETED, paymentHold = false } = opts;
  return {
    id,
    date,
    status,
    paymentHold,
    notes: null,
    price: 35,
    round: null,
    technician: null,
    invoice: null,
    payment: null,
    issues: [],
  };
}

function makeCustomerWithVisitsAndPayments(opts: {
  visitCount: number;
  payments: Array<{ status: PaymentStatus; amount: number; paidAt: Date | null }>;
}) {
  const { visitCount, payments } = opts;
  // Simulate the DB already having applied `orderBy: { date: "desc" }, take: 50` —
  // the mock returns visits newest-first and capped, exactly as Prisma would.
  const visits = Array.from({ length: visitCount }, (_, i) =>
    makeVisit({
      id: `v${visitCount - i}`,
      date: new Date(2026, 0, visitCount - i),
    })
  );
  return {
    id: "c1",
    name: "Dana",
    phone: null,
    email: null,
    status: LifecycleStatus.ACTIVE,
    ghlContactId: null,
    payments,
    properties: [
      {
        id: "p1",
        status: LifecycleStatus.ACTIVE,
        addressLine: "1 Test St",
        postcode: "T1 1TT",
        propertyType: null,
        accessNotes: null,
        riskNotes: null,
        roundId: null,
        serviceAreaId: null,
        round: null,
        serviceArea: null,
        notes: [],
        photos: [],
        visits,
        servicePlans: [],
      },
    ],
  };
}

it("getCustomerDetail caps visitHistory/payments tabs at 50, newest-first, independent of the full payments history", async () => {
  const prisma = makePrisma();
  // 50 visits (already capped/ordered by the query, per the take:50/orderBy:desc fix).
  const customer = makeCustomerWithVisitsAndPayments({
    visitCount: 50,
    payments: [
      { status: PaymentStatus.PAID, amount: 100, paidAt: new Date("2026-01-01") },
      { status: PaymentStatus.OVERDUE, amount: 40, paidAt: null },
      { status: PaymentStatus.PENDING, amount: 60, paidAt: null },
      { status: PaymentStatus.PAID, amount: 20, paidAt: new Date("2026-03-01") },
    ],
  });
  (prisma.customer.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(customer);
  (prisma.businessSettings.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(makeSettings());

  const result = await createCustomerService(prisma).getCustomerDetail("c1", UserRole.ADMIN);

  expect(result.tabs.visitHistory).toHaveLength(50);
  expect(result.tabs.payments?.rows).toHaveLength(50);
  // newest-first
  expect(result.tabs.visitHistory[0].visitId).toBe("v50");
  expect(result.tabs.visitHistory[49].visitId).toBe("v1");

  // outstandingBalance/lastPaymentDate are derived from the FULL payments array
  // (not capped at 50, and unrelated to the visit cap): 40 + 60 = 100 outstanding.
  expect(result.standingInfo.outstandingBalance).toBe(100);
  expect(result.standingInfo.lastPaymentDate).toEqual(new Date("2026-03-01"));

  // The query itself must request the capped/ordered visits include.
  const includeArgs = (prisma.customer.findUnique as ReturnType<typeof vi.fn>).mock.calls[0][0];
  const visitsInclude = includeArgs.include.properties.include.visits;
  expect(visitsInclude.take).toBe(50);
  expect(visitsInclude.orderBy).toEqual({ date: "desc" });
});

it("getCustomerDetail counts issues from the FULL visit history, not just the 50-visit cap", async () => {
  // Regression test for: issuesCount used to sum `v.issues.length` over the
  // now-50-capped `visits` array, silently dropping issues logged on any
  // visit outside the most-recent 50 for a long-tenured customer.
  const prisma = makePrisma();
  const customer = makeCustomerWithVisitsAndPayments({ visitCount: 50, payments: [] });
  (prisma.customer.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(customer);
  (prisma.businessSettings.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(makeSettings());
  // The true count spans visits outside the 50-visit window the main query caps to.
  (prisma.issue.count as ReturnType<typeof vi.fn>).mockResolvedValue(7);

  const result = await createCustomerService(prisma).getCustomerDetail("c1", UserRole.ADMIN);

  expect(result.standingInfo.issuesCount).toBe(7);
  // Scoped to this customer's property, not a bare table-wide count.
  const countArgs = (prisma.issue.count as ReturnType<typeof vi.fn>).mock.calls[0][0];
  expect(countArgs.where.visit.propertyId).toBe("p1");
});

it("getCustomerDetail handles a customer with 0 visits and 0 payments (empty-state)", async () => {
  const prisma = makePrisma();
  const customer = makeCustomerWithVisitsAndPayments({ visitCount: 0, payments: [] });
  (prisma.customer.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(customer);
  (prisma.businessSettings.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(makeSettings());

  const result = await createCustomerService(prisma).getCustomerDetail("c1", UserRole.ADMIN);

  expect(result.tabs.visitHistory).toEqual([]);
  expect(result.tabs.payments?.rows).toEqual([]);
  expect(result.standingInfo.outstandingBalance).toBe(0);
  expect(result.standingInfo.lastPaymentDate).toBeNull();
  expect(result.standingInfo.issuesCount).toBe(0);
  expect(result.standingInfo.nextVisitStatus).toBeNull();
});

it("getCustomerDetail hides outstandingBalance for TECHNICIAN viewers", async () => {
  const prisma = makePrisma();
  const customer = makeCustomerWithVisitsAndPayments({
    visitCount: 1,
    payments: [{ status: PaymentStatus.OVERDUE, amount: 40, paidAt: null }],
  });
  (prisma.customer.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(customer);
  (prisma.businessSettings.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(makeSettings());

  const result = await createCustomerService(prisma).getCustomerDetail("c1", UserRole.TECHNICIAN);

  expect(result.standingInfo.outstandingBalance).toBeUndefined();
  expect(result.tabs.payments).toBeUndefined();
});

it("getCustomerDetail throws 404 for an unknown customer", async () => {
  const prisma = makePrisma();
  (prisma.customer.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);
  (prisma.businessSettings.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(makeSettings());

  await expect(
    createCustomerService(prisma).getCustomerDetail("missing", UserRole.ADMIN)
  ).rejects.toMatchObject({ statusCode: 404 });
});

// ── coverage closers: search filter, FAILED badge, servicePlans picking,
//    scheduled-visit sort, onHold short-circuit, notes mapping ────────────

it("getCustomers applies the search filter and resolves 'failed'/plan fields from a populated property", async () => {
  const prisma = makePrisma();
  mockSummaryCounts(prisma, { total: 1, active: 0, holds: 0 });
  (prisma.customer.count as ReturnType<typeof vi.fn>).mockResolvedValueOnce(1);
  const fixture = {
    id: "c1",
    name: "Searched Co",
    status: LifecycleStatus.ACTIVE,
    payments: [{ status: PaymentStatus.FAILED, amount: 10, createdAt: new Date("2026-01-01") }],
    properties: [
      {
        id: "p1",
        status: LifecycleStatus.ACTIVE,
        addressLine: "1 Search St",
        postcode: "S1 1SS",
        roundId: "r1",
        round: { name: "Round A", frequency: "FOUR_WEEKLY" },
        servicePlans: [
          { status: LifecycleStatus.CANCELLED, cleaningFrequency: "TWELVE_WEEKLY", price: 10, nextDueDate: null },
          { status: LifecycleStatus.ACTIVE, cleaningFrequency: "FOUR_WEEKLY", price: 45, nextDueDate: new Date("2026-02-01") },
        ],
        visits: [],
      },
    ],
  };
  (prisma.customer.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([fixture]);

  const result = await createCustomerService(prisma).getCustomers(
    { search: "Search" },
    UserRole.ADMIN
  );

  expect(result.customers).toHaveLength(1);
  expect(result.customers[0].paymentStatus).toBe("failed");
  expect(result.customers[0].price).toBe(45);
  expect(result.customers[0].frequency).toBe("FOUR_WEEKLY");

  const findManyArgs = (prisma.customer.findMany as ReturnType<typeof vi.fn>).mock.calls[0][0];
  expect(findManyArgs.where.OR).toEqual([
    { name: { contains: "Search", mode: "insensitive" } },
    { properties: { some: { addressLine: { contains: "Search", mode: "insensitive" } } } },
    { properties: { some: { postcode: { contains: "Search", mode: "insensitive" } } } },
  ]);
});

it("getCustomers falls back to 0 when the due-payment aggregate sum is null", async () => {
  const prisma = makePrisma();
  (prisma.customer.count as ReturnType<typeof vi.fn>)
    .mockResolvedValueOnce(0)
    .mockResolvedValueOnce(0)
    .mockResolvedValueOnce(0)
    .mockResolvedValueOnce(0);
  (prisma.payment.aggregate as ReturnType<typeof vi.fn>).mockResolvedValue({
    _sum: { amount: null },
  });
  (prisma.customer.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);

  const result = await createCustomerService(prisma).getCustomers({}, UserRole.ADMIN);

  expect(result.summary.amountDue).toBe(0);
});

it("getCustomerDetail sorts multiple scheduled visits, evaluates the paymentHold short-circuit, and maps property notes", async () => {
  const prisma = makePrisma();
  const customer = {
    id: "c1",
    name: "Dana",
    phone: null,
    email: null,
    status: LifecycleStatus.ACTIVE,
    ghlContactId: null,
    payments: [],
    properties: [
      {
        id: "p1",
        status: LifecycleStatus.ACTIVE,
        addressLine: "1 Test St",
        postcode: "T1 1TT",
        propertyType: null,
        accessNotes: null,
        riskNotes: null,
        roundId: null,
        serviceAreaId: null,
        round: null,
        serviceArea: null,
        notes: [{ id: "n1", propertyId: "p1", type: "GENERAL", body: "hello", authorProfileId: null, createdAt: new Date() }],
        photos: [],
        servicePlans: [],
        visits: [
          // Two OPEN_VISIT entries out of order, plus one on-hold-but-not-open visit
          // (exercises the paymentHold && OPEN_VISIT.includes(...) short-circuit).
          makeVisit({ id: "v-later", date: new Date("2026-05-10"), status: VisitStatus.SCHEDULED }),
          makeVisit({ id: "v-earlier", date: new Date("2026-05-05"), status: VisitStatus.IN_PROGRESS }),
          makeVisit({ id: "v-hold-completed", date: new Date("2026-01-01"), status: VisitStatus.COMPLETED, paymentHold: true }),
        ],
      },
    ],
  };
  (prisma.customer.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(customer);
  (prisma.businessSettings.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(makeSettings());

  const result = await createCustomerService(prisma).getCustomerDetail("c1", UserRole.ADMIN);

  // Scheduled visits sorted earliest-first for "next scheduled" selection.
  expect(result.standingInfo.nextVisitStatus).toBe(VisitStatus.IN_PROGRESS);
  // paymentHold is true on a COMPLETED visit only — not an open one — so onHold is false.
  expect(result.standingInfo.paymentStatus).not.toBe("hold");
  expect(result.tabs.notes).toEqual([{ ...customer.properties[0].notes[0], authorName: null }]);
});
