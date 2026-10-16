import { it, expect, vi } from "vitest";
import { createRoundService } from "../round.service";
import { CleaningFrequency, RoundStatus } from "../../generated/tenant-client";

function makePrisma() {
  const prisma = {
    round: { findMany: vi.fn(), findUnique: vi.fn(), findUniqueOrThrow: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
    serviceArea: { findUnique: vi.fn() },
    technician: { findUnique: vi.fn(), findMany: vi.fn() },
    visit: { findMany: vi.fn(), updateMany: vi.fn() },
    roundTechnician: { findMany: vi.fn(), deleteMany: vi.fn(), createMany: vi.fn() },
    $transaction: vi.fn(),
  } as unknown as Parameters<typeof createRoundService>[0];
  // Default: $transaction runs the callback immediately with the same client
  (prisma.$transaction as ReturnType<typeof vi.fn>).mockImplementation(
    (fn: (tx: typeof prisma) => Promise<unknown>) => fn(prisma)
  );
  return prisma;
}

it("createRoundService returns an object", () => {
  expect(createRoundService(makePrisma())).toBeDefined();
});

it("createRound stores TWELVE_WEEKLY frequency", async () => {
  const prisma = makePrisma();
  (prisma.serviceArea.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "sa1" });
  (prisma.round.create as ReturnType<typeof vi.fn>).mockResolvedValue({
    id: "r1", name: "Round A", frequency: CleaningFrequency.TWELVE_WEEKLY,
    status: RoundStatus.ACTIVE, defaultDay: null, description: null, serviceAreaId: "sa1",
    serviceArea: null, roundTechnicians: [], _count: { properties: 0 },
  });
  const result = await createRoundService(prisma).createRound({
    name: "Round A",
    frequency: CleaningFrequency.TWELVE_WEEKLY,
    serviceAreaId: "sa1",
  });
  expect(result.frequency).toBe(CleaningFrequency.TWELVE_WEEKLY);
});

it("setTechnicians throws 400 when a technician has not accepted their invite", async () => {
  const prisma = makePrisma();
  // Round exists
  (prisma.round.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "r1" });
  // Technician found but profileId is null — invite still pending
  (prisma.technician.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
    { id: "t1", active: true, profileId: null },
  ]);

  await expect(
    createRoundService(prisma).setTechnicians("r1", ["t1"])
  ).rejects.toMatchObject({ statusCode: 400 });
});

it("reassignTechnician throws 400 when target technician has not accepted their invite", async () => {
  const prisma = makePrisma();
  (prisma.round.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "r1" });
  (prisma.technician.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
    id: "t2", active: true, profileId: null,
  });

  await expect(
    createRoundService(prisma).reassignTechnician("r1", {
      fromTechnicianId: "t1",
      toTechnicianId: "t2",
      scope: "remaining",
      notify: false,
    })
  ).rejects.toMatchObject({ statusCode: 400 });
});

// ---- listOccurrencesForRounds -------------------------------------------

function makeVisit(overrides: Partial<{
  roundId: string | null;
  date: Date;
  status: string;
  paymentHold: boolean;
  price: { toNumber: () => number };
  _count: { issues: number };
}> = {}) {
  return {
    roundId: "r1",
    date: new Date("2026-01-01T00:00:00.000Z"),
    status: "SCHEDULED",
    paymentHold: false,
    price: { toNumber: () => 0 },
    _count: { issues: 0 },
    ...overrides,
  };
}

it("listOccurrencesForRounds groups results by round then by date, issuing a single query", async () => {
  const prisma = makePrisma();
  const visits = [
    // round r1: two visits same date (2026-01-01), one visit different date (2026-01-02)
    makeVisit({ roundId: "r1", date: new Date("2026-01-01T00:00:00.000Z"), status: "COMPLETED", price: { toNumber: () => 100 } }),
    makeVisit({ roundId: "r1", date: new Date("2026-01-01T00:00:00.000Z"), status: "SCHEDULED", paymentHold: true, price: { toNumber: () => 50 }, _count: { issues: 2 } }),
    makeVisit({ roundId: "r1", date: new Date("2026-01-02T00:00:00.000Z"), status: "SCHEDULED", price: { toNumber: () => 75 } }),
    // round r2: one visit, non-overlapping date range with r1's second date
    makeVisit({ roundId: "r2", date: new Date("2026-01-03T00:00:00.000Z"), status: "COMPLETED", price: { toNumber: () => 200 } }),
    // round r3 (requested below) has zero matching visits
  ];
  (prisma.visit.findMany as ReturnType<typeof vi.fn>).mockResolvedValue(visits);

  const result = await createRoundService(prisma).listOccurrencesForRounds(
    ["r1", "r2", "r3"],
    new Date("2026-01-01T00:00:00.000Z"),
    new Date("2026-01-05T00:00:00.000Z"),
  );

  expect(prisma.visit.findMany).toHaveBeenCalledTimes(1);
  expect(result).toHaveLength(3);

  const r1 = result.find((r) => r.roundId === "r1")!;
  expect(r1.occurrences).toHaveLength(2);
  const r1Jan1 = r1.occurrences.find((o) => o.date === "2026-01-01")!;
  expect(r1Jan1).toMatchObject({
    stopCount: 2,
    totalValue: 150,
    completedCount: 1,
    completionPct: 50,
    holdCount: 1,
    issueCount: 2,
  });
  const r1Jan2 = r1.occurrences.find((o) => o.date === "2026-01-02")!;
  expect(r1Jan2).toMatchObject({ stopCount: 1, totalValue: 75, completedCount: 0, completionPct: 0 });

  const r2 = result.find((r) => r.roundId === "r2")!;
  expect(r2.occurrences).toHaveLength(1);
  expect(r2.occurrences[0]).toMatchObject({ date: "2026-01-03", stopCount: 1, totalValue: 200, completedCount: 1, completionPct: 100 });

  // round with zero matching visits still appears, with an empty array
  const r3 = result.find((r) => r.roundId === "r3")!;
  expect(r3.occurrences).toEqual([]);

  // no per-round assertRoundExists lookup for a batch call
  expect(prisma.round.findUnique).not.toHaveBeenCalled();
});

it("listOccurrencesForRounds skips a visit whose roundId is null (defensive, shouldn't happen given the where filter)", async () => {
  const prisma = makePrisma();
  (prisma.visit.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
    makeVisit({ roundId: null }),
    makeVisit({ roundId: "r1" }),
  ]);

  const result = await createRoundService(prisma).listOccurrencesForRounds(
    ["r1"],
    new Date("2026-01-01T00:00:00.000Z"),
    undefined,
  );

  expect(result).toHaveLength(1);
  expect(result[0].occurrences).toHaveLength(1);
  expect(result[0].occurrences[0].stopCount).toBe(1);
});

it("listOccurrencesForRounds queries with only 'to' bound when 'from' is omitted", async () => {
  const prisma = makePrisma();
  (prisma.visit.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
    makeVisit({ roundId: "r1", date: new Date("2026-01-01T00:00:00.000Z") }),
  ]);

  const result = await createRoundService(prisma).listOccurrencesForRounds(
    ["r1"],
    undefined,
    new Date("2026-01-05T00:00:00.000Z"),
  );

  expect(prisma.visit.findMany).toHaveBeenCalledWith(
    expect.objectContaining({
      where: expect.objectContaining({
        roundId: { in: ["r1"] },
        date: { lte: new Date("2026-01-05T00:00:00.000Z") },
      }),
    })
  );
  expect(result[0].occurrences).toHaveLength(1);
});

it("listOccurrencesForRounds throws 400 when neither from nor to is given", async () => {
  const prisma = makePrisma();
  await expect(
    createRoundService(prisma).listOccurrencesForRounds(["r1"])
  ).rejects.toMatchObject({ statusCode: 400 });
  expect(prisma.visit.findMany).not.toHaveBeenCalled();
});

it("listOccurrencesForRounds throws 400 when from is after to", async () => {
  const prisma = makePrisma();
  await expect(
    createRoundService(prisma).listOccurrencesForRounds(
      ["r1"],
      new Date("2026-02-01T00:00:00.000Z"),
      new Date("2026-01-01T00:00:00.000Z"),
    )
  ).rejects.toMatchObject({ statusCode: 400 });
});

it("listOccurrencesForRounds throws 400 when the date range exceeds 90 days", async () => {
  const prisma = makePrisma();
  await expect(
    createRoundService(prisma).listOccurrencesForRounds(
      ["r1"],
      new Date("2026-01-01T00:00:00.000Z"),
      new Date("2026-05-01T00:00:00.000Z"),
    )
  ).rejects.toMatchObject({ statusCode: 400 });
});
