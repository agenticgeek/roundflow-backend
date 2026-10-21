import { it, expect, vi } from "vitest";
import { createSetupService } from "../setup.service";
import { RoundStatus } from "../../generated/tenant-client";

function makePrisma() {
  return {
    businessSettings: { findFirst: vi.fn(), findMany: vi.fn(), upsert: vi.fn() },
    service: { findMany: vi.fn(), deleteMany: vi.fn(), createMany: vi.fn(), count: vi.fn().mockResolvedValue(0) },
    messageTemplate: { findMany: vi.fn(), deleteMany: vi.fn(), createMany: vi.fn(), count: vi.fn().mockResolvedValue(0) },
    technician: { findMany: vi.fn(), deleteMany: vi.fn(), createMany: vi.fn(), count: vi.fn().mockResolvedValue(0) },
    serviceArea: { findMany: vi.fn(), findUnique: vi.fn(), deleteMany: vi.fn(), createMany: vi.fn(), count: vi.fn().mockResolvedValue(0) },
    round: {
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      count: vi.fn().mockResolvedValue(0),
    },
    roundTechnician: { deleteMany: vi.fn(), createMany: vi.fn() },
    // findMany defaults to echoing back a bare { id } record per id in a
    // `where: { id: { in: [...] } }` query — bulkAddSetupProperties refetches
    // createMany'd rows this way to build its response shape.
    customer: {
      findMany: vi.fn((args: any) => Promise.resolve((args?.where?.id?.in ?? []).map((id: string) => ({ id })))),
      create: vi.fn(),
      createMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    property: {
      findMany: vi.fn((args: any) => Promise.resolve((args?.where?.id?.in ?? []).map((id: string) => ({ id })))),
      create: vi.fn(),
      createMany: vi.fn().mockResolvedValue({ count: 0 }),
      count: vi.fn().mockResolvedValue(0),
    },
    servicePlan: {
      findMany: vi.fn((args: any) => Promise.resolve((args?.where?.id?.in ?? []).map((id: string) => ({ id })))),
      create: vi.fn(),
      createMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    visit: { findMany: vi.fn(), createMany: vi.fn(), count: vi.fn().mockResolvedValue(0) },
    // Supports both the interactive callback form ($transaction(cb)) used by
    // other steps and the array/batched form ($transaction([...])) used by
    // bulkAddSetupProperties.
    $transaction: vi.fn((arg: any) => (Array.isArray(arg) ? Promise.all(arg) : arg(makePrisma()))),
  } as unknown as Parameters<typeof createSetupService>[0];
}

function makeServiceArea(id: string) {
  return { id };
}

function makeRound(id: string, status: RoundStatus = RoundStatus.ACTIVE) {
  return { id, status, name: "Round A", frequency: "FOUR_WEEKLY", defaultDay: null };
}

function makeInput(overrides: Partial<{
  customerName: string; fullAddress: string; postcode: string;
  serviceAreaId: string; roundId: string; price: number;
}> = {}) {
  return {
    customerName: "Test Customer",
    fullAddress: "1 Test Lane",
    postcode: "T1 1TT",
    serviceAreaId: "area1",
    roundId: "round1",
    price: 35,
    ...overrides,
  };
}

// ── bulkAddSetupProperties ─────────────────────────────────────────────────

it("bulkAddSetupProperties: empty input returns { created: 0, results: [] }", async () => {
  const prisma = makePrisma();
  const result = await createSetupService(prisma).bulkAddSetupProperties([]);
  expect(result).toEqual({ created: 0, results: [] });
});

it("bulkAddSetupProperties: 3 valid rows returns created: 3", async () => {
  const prisma = makePrisma();
  (prisma.serviceArea.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([makeServiceArea("area1")]);
  (prisma.round.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([makeRound("round1")]);

  const inputs = [makeInput(), makeInput(), makeInput()];
  const result = await createSetupService(prisma).bulkAddSetupProperties(inputs);

  expect(result.created).toBe(3);
  expect(result.results).toHaveLength(3);
  expect(prisma.customer.createMany).toHaveBeenCalledTimes(1);
  expect(prisma.property.createMany).toHaveBeenCalledTimes(1);
  expect(prisma.servicePlan.createMany).toHaveBeenCalledTimes(1);
});

it("bulkAddSetupProperties: unknown serviceAreaId throws 400 before any insert", async () => {
  const prisma = makePrisma();
  (prisma.serviceArea.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]); // no areas found
  (prisma.round.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([makeRound("round1")]);

  await expect(
    createSetupService(prisma).bulkAddSetupProperties([makeInput()])
  ).rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining("area1") });

  expect(prisma.$transaction).not.toHaveBeenCalled();
});

it("bulkAddSetupProperties: unknown roundId throws 400 before any insert", async () => {
  const prisma = makePrisma();
  (prisma.serviceArea.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([makeServiceArea("area1")]);
  (prisma.round.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]); // no rounds found

  await expect(
    createSetupService(prisma).bulkAddSetupProperties([makeInput()])
  ).rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining("round1") });

  expect(prisma.$transaction).not.toHaveBeenCalled();
});

it("bulkAddSetupProperties: inactive round throws 400 before any insert", async () => {
  const prisma = makePrisma();
  (prisma.serviceArea.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([makeServiceArea("area1")]);
  (prisma.round.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([makeRound("round1", RoundStatus.DRAFT)]);

  await expect(
    createSetupService(prisma).bulkAddSetupProperties([makeInput()])
  ).rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining("ACTIVE") });

  expect(prisma.$transaction).not.toHaveBeenCalled();
});

it("bulkAddSetupProperties: 150 rows fires two transactions", async () => {
  const prisma = makePrisma();
  (prisma.serviceArea.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([makeServiceArea("area1")]);
  (prisma.round.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([makeRound("round1")]);

  const inputs = Array.from({ length: 150 }, () => makeInput());
  const result = await createSetupService(prisma).bulkAddSetupProperties(inputs);

  expect(result.created).toBe(150);
  expect(prisma.$transaction).toHaveBeenCalledTimes(2); // batch 1: 100, batch 2: 50
});

it("bulkAddSetupProperties: invalid propertyType throws 400 before FK checks", async () => {
  const prisma = makePrisma();
  const input = { ...makeInput(), propertyType: "IGLOO" };

  await expect(
    createSetupService(prisma).bulkAddSetupProperties([input])
  ).rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining("propertyType") });

  expect(prisma.serviceArea.findMany).not.toHaveBeenCalled();
});

// ── getStatus: step 10 "all active rounds assigned" ────────────────────────
// These also guard the perf refactor that folded round.findMany into the
// getStatus() Promise.all — round.findMany must still be called exactly
// once and allRoundsAssigned must still be computed correctly.

it("getStatus: no active rounds → step 10 incomplete, round.findMany called once", async () => {
  const prisma = makePrisma();
  (prisma.round.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);

  const status = await createSetupService(prisma).getStatus();

  expect(status.steps.find((s) => s.step === 10)?.complete).toBe(false);
  expect(prisma.round.findMany).toHaveBeenCalledTimes(1);
});

it("getStatus: active round with no technicians → step 10 incomplete", async () => {
  const prisma = makePrisma();
  (prisma.round.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
    { id: "round1", roundTechnicians: [] },
  ]);

  const status = await createSetupService(prisma).getStatus();

  expect(status.steps.find((s) => s.step === 10)?.complete).toBe(false);
  expect(prisma.round.findMany).toHaveBeenCalledTimes(1);
});

it("getStatus: every active round has ≥1 technician → step 10 complete", async () => {
  const prisma = makePrisma();
  (prisma.round.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
    { id: "round1", roundTechnicians: [{ technicianId: "t1" }] },
    { id: "round2", roundTechnicians: [{ technicianId: "t2" }] },
  ]);

  const status = await createSetupService(prisma).getStatus();

  expect(status.steps.find((s) => s.step === 10)?.complete).toBe(true);
  expect(prisma.round.findMany).toHaveBeenCalledTimes(1);
});

// ── getSettings() memoization & upsertSettings() cache refresh ─────────────
// A SetupService instance is created fresh per request (createSetupService),
// so these assert request-scoped behavior, not cross-request caching.

it("getSettings is memoized within one service instance: assertSetupIncomplete then a read hits the DB only once", async () => {
  const prisma = makePrisma();
  (prisma.businessSettings.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
    uniqueId: "singleton",
    setupCompleted: false,
    businessName: "Acme Cleaning",
  });

  const svc = createSetupService(prisma);
  await svc.assertSetupIncomplete();
  const settings = await svc.getBusinessSettings();

  expect(settings?.businessName).toBe("Acme Cleaning");
  expect(prisma.businessSettings.findFirst).toHaveBeenCalledTimes(1);
});

it("a new service instance does not share the memoized settings of a prior instance", async () => {
  const prisma = makePrisma();
  (prisma.businessSettings.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
    uniqueId: "singleton",
    setupCompleted: false,
  });

  await createSetupService(prisma).getBusinessSettings();
  await createSetupService(prisma).getBusinessSettings();

  expect(prisma.businessSettings.findFirst).toHaveBeenCalledTimes(2);
});

it("saveBusinessProfile refreshes the memo: a subsequent read in the same request reflects the write without re-querying", async () => {
  const prisma = makePrisma();
  (prisma.businessSettings.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
    uniqueId: "singleton",
    setupCompleted: false,
    businessName: null,
  });
  (prisma.businessSettings.upsert as ReturnType<typeof vi.fn>).mockResolvedValue({
    uniqueId: "singleton",
    setupCompleted: false,
    businessName: "Acme Cleaning",
  });

  const svc = createSetupService(prisma);
  await svc.getBusinessSettings(); // primes the memo with businessName: null
  await svc.saveBusinessProfile({ businessName: "Acme Cleaning" });
  const settings = await svc.getBusinessSettings();

  expect(settings?.businessName).toBe("Acme Cleaning");
  // One priming read + one post-write read that must be served from the
  // refreshed memo, not a second findFirst.
  expect(prisma.businessSettings.findFirst).toHaveBeenCalledTimes(1);
});

// ---- payment setup (wizard step 2) -------------------------------------------

it("getPaymentSetup returns the BusinessSettings singleton", async () => {
  const prisma = makePrisma();
  (prisma.businessSettings.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
    uniqueId: "singleton",
    paymentRule: "COLLECT_AFTER_VISIT",
    gocardlessConnected: true,
    stripeConnected: false,
  });

  const result = await createSetupService(prisma).getPaymentSetup();

  expect(result?.paymentRule).toBe("COLLECT_AFTER_VISIT");
});

it("getPaymentSetup returns null before setup has started", async () => {
  const prisma = makePrisma();
  (prisma.businessSettings.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);

  const result = await createSetupService(prisma).getPaymentSetup();

  expect(result).toBeNull();
});

it("savePaymentSetup persists paymentRule/debtHoldEnabled/vatInInvoices and the connect flags", async () => {
  const prisma = makePrisma();
  (prisma.businessSettings.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);
  (prisma.businessSettings.upsert as ReturnType<typeof vi.fn>).mockResolvedValue({
    uniqueId: "singleton",
    paymentRule: "COLLECT_BEFORE_VISIT",
    debtHoldEnabled: true,
    vatInInvoices: true,
    gocardlessConnected: true,
    stripeConnected: true,
  });

  const result = await createSetupService(prisma).savePaymentSetup({
    paymentRule: "COLLECT_BEFORE_VISIT",
    debtHoldEnabled: true,
    vatInInvoices: true,
    gocardlessConnected: true,
    stripeConnected: true,
  });

  expect(prisma.businessSettings.upsert).toHaveBeenCalledWith({
    where: { uniqueId: "singleton" },
    update: {
      paymentRule: "COLLECT_BEFORE_VISIT",
      debtHoldEnabled: true,
      vatInInvoices: true,
      gocardlessConnected: true,
      stripeConnected: true,
    },
    create: {
      paymentRule: "COLLECT_BEFORE_VISIT",
      debtHoldEnabled: true,
      vatInInvoices: true,
      gocardlessConnected: true,
      stripeConnected: true,
    },
  });
  expect(result.gocardlessConnected).toBe(true);
});

it("savePaymentSetup passes through undefined fields untouched (partial update)", async () => {
  const prisma = makePrisma();
  (prisma.businessSettings.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);
  (prisma.businessSettings.upsert as ReturnType<typeof vi.fn>).mockResolvedValue({ uniqueId: "singleton" });

  await createSetupService(prisma).savePaymentSetup({ stripeConnected: true });

  expect(prisma.businessSettings.upsert).toHaveBeenCalledWith(
    expect.objectContaining({
      update: {
        paymentRule: undefined,
        debtHoldEnabled: undefined,
        vatInInvoices: undefined,
        gocardlessConnected: undefined,
        stripeConnected: true,
      },
    })
  );
});
