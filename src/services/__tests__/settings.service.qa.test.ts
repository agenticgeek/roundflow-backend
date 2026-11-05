import { it, expect, vi } from "vitest";
import { createSettingsService } from "../settings.service";

function makePrisma(current: Record<string, unknown> | null) {
  return {
    businessSettings: {
      findFirst: vi.fn().mockResolvedValue(current),
      upsert: vi.fn().mockImplementation(({ update }: any) => Promise.resolve({ ...update })),
    },
  } as any;
}

it("BUG-01 round settings: list wins, legacy mode converts, bare time re-times the first entry, nothing leaves reminders alone", async () => {
  const prisma = makePrisma({ preCleanReminders: [{ type: "EVENING_BEFORE", time: "19:00" }, { type: "MORNING_OF", time: "07:00" }], reminderMode: "EVENING_BEFORE", reminderTime: "19:00" });
  const svc = createSettingsService(prisma, "t_x");
  await svc.updateRoundSettings({ preCleanReminders: [{ type: "MORNING_OF", time: "06:30" }] });
  expect(prisma.businessSettings.upsert.mock.calls[0][0].update).toMatchObject({ preCleanReminders: [{ type: "MORNING_OF", time: "06:30" }], reminderMode: "MORNING_OF", reminderTime: "06:30" });

  const p2 = makePrisma({ preCleanReminders: [{ type: "EVENING_BEFORE", time: "19:00" }, { type: "MORNING_OF", time: "07:00" }] });
  await createSettingsService(p2, "t_x").updateRoundSettings({ reminderTime: "18:15" });
  expect(p2.businessSettings.upsert.mock.calls[0][0].update.preCleanReminders).toEqual([{ type: "EVENING_BEFORE", time: "18:15" }, { type: "MORNING_OF", time: "07:00" }]);

  const p3 = makePrisma(null);
  await createSettingsService(p3, "t_x").updateRoundSettings({ reminderMode: "NONE" });
  expect(p3.businessSettings.upsert.mock.calls[0][0].update).toMatchObject({ preCleanReminders: [], reminderMode: "NONE" });

  const p4 = makePrisma(null);
  await createSettingsService(p4, "t_x").updateRoundSettings({ defaultCycleLength: 28 });
  expect(p4.businessSettings.upsert.mock.calls[0][0].update.preCleanReminders).toBeUndefined();
});

it("BUG-05 payment rules: default must be accepted; accepted list is saved", async () => {
  const prisma = makePrisma({ acceptedPaymentMethods: ["CASH", "BACS"], defaultPaymentMethod: "CASH" });
  const svc = createSettingsService(prisma, "t_x");
  await svc.updatePaymentRules({ acceptedPaymentMethods: ["CASH", "BACS", "STRIPE"], defaultPaymentMethod: "STRIPE" });
  expect(prisma.businessSettings.upsert.mock.calls[0][0].update).toMatchObject({ acceptedPaymentMethods: ["CASH", "BACS", "STRIPE"], defaultPaymentMethod: "STRIPE" });
  await expect(svc.updatePaymentRules({ defaultPaymentMethod: "CHEQUE" })).rejects.toMatchObject({ statusCode: 400 });
  await svc.updatePaymentRules({ invoiceDueDays: 14 });
  expect(prisma.businessSettings.upsert.mock.calls[1][0].update.acceptedPaymentMethods).toBeUndefined();
});
