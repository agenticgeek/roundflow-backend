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
  const result = await createRoundService(prisma).createRound("user-1", {
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
    createRoundService(prisma).setTechnicians("user-1", "r1", ["t1"])
  ).rejects.toMatchObject({ statusCode: 400 });
});

it("reassignTechnician throws 400 when target technician has not accepted their invite", async () => {
  const prisma = makePrisma();
  (prisma.round.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "r1" });
  (prisma.technician.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
    id: "t2", active: true, profileId: null,
  });

  await expect(
    createRoundService(prisma).reassignTechnician("user-1", "r1", {
      fromTechnicianId: "t1",
      toTechnicianId: "t2",
      scope: "remaining",
      notify: false,
    })
  ).rejects.toMatchObject({ statusCode: 400 });
});
