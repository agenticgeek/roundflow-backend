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
    customer: { findMany: vi.fn(), create: vi.fn() },
    property: { findMany: vi.fn(), create: vi.fn(), count: vi.fn().mockResolvedValue(0) },
    servicePlan: { findMany: vi.fn(), create: vi.fn() },
    visit: { findMany: vi.fn(), createMany: vi.fn(), count: vi.fn().mockResolvedValue(0) },
    $transaction: vi.fn((cb: any) => cb(makePrisma())),
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

  const txPrisma = {
    ...makePrisma(),
    customer: { create: vi.fn().mockResolvedValue({ id: "c1" }) },
    property: { create: vi.fn().mockResolvedValue({ id: "p1" }) },
    servicePlan: { create: vi.fn().mockResolvedValue({ id: "sp1" }) },
  };
  (prisma.$transaction as ReturnType<typeof vi.fn>).mockImplementation((cb: any) => cb(txPrisma));

  const inputs = [makeInput(), makeInput(), makeInput()];
  const result = await createSetupService(prisma).bulkAddSetupProperties(inputs);

  expect(result.created).toBe(3);
  expect(result.results).toHaveLength(3);
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

  let rowCounter = 0;
  (prisma.$transaction as ReturnType<typeof vi.fn>).mockImplementation(async (cb: any) => {
    const tx = {
      customer: { create: vi.fn().mockImplementation(() => Promise.resolve({ id: `c${++rowCounter}` })) },
      property: { create: vi.fn().mockResolvedValue({ id: "p1" }) },
      servicePlan: { create: vi.fn().mockResolvedValue({ id: "sp1" }) },
    };
    return cb(tx);
  });

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
