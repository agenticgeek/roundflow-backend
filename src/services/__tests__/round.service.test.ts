import { it, expect, vi } from "vitest";
import { createRoundService } from "../round.service";
import { CleaningFrequency, RoundStatus } from "../../generated/tenant-client";

function makePrisma() {
  return {
    round: { findMany: vi.fn(), findUnique: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
    serviceArea: { findUnique: vi.fn() },
    technician: { findUnique: vi.fn() },
    visit: { findMany: vi.fn(), updateMany: vi.fn() },
    roundTechnician: { findMany: vi.fn(), deleteMany: vi.fn(), createMany: vi.fn() },
  } as unknown as Parameters<typeof createRoundService>[0];
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
