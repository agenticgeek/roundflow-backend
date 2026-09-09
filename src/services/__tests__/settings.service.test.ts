import { it, expect, vi } from "vitest";
import { createSettingsService } from "../settings.service";

function makePrisma() {
  return {
    businessSettings: { findFirst: vi.fn(), upsert: vi.fn(), update: vi.fn() },
    service: { findMany: vi.fn(), findUnique: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
    serviceArea: { findMany: vi.fn(), findUnique: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn(), count: vi.fn() },
    technician: { findMany: vi.fn(), findUnique: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
    messageTemplate: { findMany: vi.fn(), deleteMany: vi.fn(), createMany: vi.fn() },
    round: { count: vi.fn() },
    property: { count: vi.fn() },
    profile: { findUnique: vi.fn() },
  } as unknown as Parameters<typeof createSettingsService>[0];
}

it("createSettingsService returns an object", () => {
  expect(createSettingsService(makePrisma())).toBeDefined();
});

it("updateRoundSettings is a function", () => {
  expect(typeof createSettingsService(makePrisma()).updateRoundSettings).toBe("function");
});

it("updateRoundSettings does not write preCleanReminderTimings when omitted", async () => {
  const prisma = makePrisma();
  (prisma.businessSettings.upsert as ReturnType<typeof vi.fn>).mockResolvedValue({});
  await createSettingsService(prisma).updateRoundSettings("user-1", { defaultCycleLength: 28 });
  const written = (prisma.businessSettings.upsert as ReturnType<typeof vi.fn>).mock.calls[0][0];
  expect(written.update.preCleanReminderTimings).toBeUndefined();
});

it("updateRoundSettings writes preCleanReminderTimings to the database", async () => {
  const prisma = makePrisma();
  const timings = ["EVENING_BEFORE", "TWO_HOURS_BEFORE"];
  (prisma.businessSettings.upsert as ReturnType<typeof vi.fn>).mockResolvedValue({});
  await createSettingsService(prisma).updateRoundSettings("user-1", {
    preCleanReminderTimings: timings,
  });
  const written = (prisma.businessSettings.upsert as ReturnType<typeof vi.fn>).mock.calls[0][0];
  expect(written.update.preCleanReminderTimings).toEqual(timings);
});
