import { it, expect, vi } from "vitest";

vi.mock("../../lib/prisma", () => ({ prisma: { tenant: { findMany: vi.fn() } } }));
vi.mock("../../lib/tenant-prisma-manager", () => ({ getTenantPrismaForSchema: vi.fn() }));

import { runTenantPreCleanReminders } from "../preCleanReminders";

const d = (s: string) => new Date(`${s}T00:00:00.000Z`);

function makeTp(settings: Record<string, unknown>, visits: unknown[] = []) {
  const tx = {
    visit: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    integrationOutbox: { create: vi.fn().mockResolvedValue({}) },
  };
  return {
    businessSettings: { findFirst: vi.fn().mockResolvedValue(settings) },
    visit: { findMany: vi.fn().mockResolvedValue(visits) },
    messageTemplate: { findFirst: vi.fn().mockResolvedValue(null) },
    $transaction: vi.fn((fn: (t: typeof tx) => unknown) => fn(tx)),
    tx,
  };
}

const visit = (id: string) => ({
  id,
  date: d("2026-10-30"),
  property: { addressLine: "1 High St", customer: { id: `c-${id}`, name: "Jo", phone: "07700900201", email: null } },
});

const base = { setupCompleted: true, reminderMode: "EVENING_BEFORE", reminderTime: "19:00", timezone: null, businessName: "Coates" };

it("BUG-01 sends one message per enabled reminder entry with a per-type marker", async () => {
  const tp = makeTp(
    {
      ...base,
      preCleanReminders: [
        { type: "EVENING_BEFORE", time: "19:00" },
        { type: "MORNING_OF", time: "07:00" },
      ],
    },
    [visit("v1")]
  );
  // 19:05 GMT on Fri 30 Oct: evening reminder targets Sat 31st, morning reminder (07:00 passed) targets Fri 30th
  await expect(runTenantPreCleanReminders(tp as never, new Date("2026-10-30T19:05:00Z"))).resolves.toBe(2);
  expect(tp.tx.visit.updateMany.mock.calls.map((c) => c[0].data.reminderSentTypes.push)).toEqual([
    "EVENING_BEFORE",
    "MORNING_OF",
  ]);
  expect(tp.visit.findMany.mock.calls[0][0].where.date).toEqual({ gte: d("2026-10-31"), lt: d("2026-11-01") });
  expect(tp.visit.findMany.mock.calls[1][0].where.date).toEqual({ gte: d("2026-10-30"), lt: d("2026-10-31") });
  expect(tp.visit.findMany.mock.calls[1][0].where.NOT).toEqual({ reminderSentTypes: { has: "MORNING_OF" } });
  expect(tp.messageTemplate.findFirst).toHaveBeenCalledTimes(1);
  const payloads = tp.tx.integrationOutbox.create.mock.calls.map((c) => c[0].data.payload.reminderType);
  expect(payloads).toEqual(["EVENING_BEFORE", "MORNING_OF"]);
});

it("BUG-01 an empty list sends nothing; a legacy row falls back to mode/time", async () => {
  const none = makeTp({ ...base, preCleanReminders: [] });
  await expect(runTenantPreCleanReminders(none as never, new Date("2026-10-30T20:00:00Z"))).resolves.toBe(0);
  expect(none.visit.findMany).not.toHaveBeenCalled();

  const legacy = makeTp(
    { ...base, reminderMode: "MORNING_OF", reminderTime: "07:00", preCleanReminders: null },
    [visit("v1")]
  );
  await expect(runTenantPreCleanReminders(legacy as never, new Date("2026-10-30T08:00:00Z"))).resolves.toBe(1);
});
