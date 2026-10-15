import { it, expect, vi } from "vitest";
import { createSetupService } from "../setup.service";
import { RoundStatus } from "../../generated/tenant-client";

function makePrisma() {
  return {
    businessSettings: { findFirst: vi.fn(), findMany: vi.fn(), upsert: vi.fn() },
    service: { findMany: vi.fn(), deleteMany: vi.fn(), createMany: vi.fn() },
    messageTemplate: { findMany: vi.fn(), deleteMany: vi.fn(), createMany: vi.fn() },
    technician: { findMany: vi.fn(), deleteMany: vi.fn(), createMany: vi.fn() },
    serviceArea: { findMany: vi.fn(), findUnique: vi.fn(), deleteMany: vi.fn(), createMany: vi.fn() },
    round: { findMany: vi.fn(), findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
    roundTechnician: { deleteMany: vi.fn(), createMany: vi.fn() },
    customer: { findMany: vi.fn(), create: vi.fn() },
    property: { findMany: vi.fn(), create: vi.fn() },
    servicePlan: { findMany: vi.fn(), create: vi.fn() },
    visit: { findMany: vi.fn(), createMany: vi.fn() },
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
