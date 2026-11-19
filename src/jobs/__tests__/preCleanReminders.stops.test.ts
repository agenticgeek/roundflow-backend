import { beforeEach, expect, it, vi } from "vitest";

// One pre-clean reminder per stop (property + day + technician), naming the services.
// docs/PROPERTY_STOPS_PLAN_2026-11-19.md §7.6

vi.mock("../../lib/prisma", () => ({ prisma: { tenant: { findMany: vi.fn() } } }));
vi.mock("../../lib/tenant-prisma-manager", () => ({ getTenantPrismaForSchema: vi.fn() }));

import { DEFAULT_REMINDER_BODY, renderReminder, runTenantPreCleanReminders } from "../preCleanReminders";

const DAY = new Date("2026-10-31T00:00:00.000Z");

function makeTp(visits: unknown[]) {
  const tx = {
    visit: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    integrationOutbox: { create: vi.fn().mockResolvedValue({}) },
  };
  return {
    businessSettings: {
      findFirst: vi.fn().mockResolvedValue({ setupCompleted: true, reminderMode: "EVENING_BEFORE", reminderTime: "19:00", timezone: null, businessName: "Coates" }),
    },
    visit: { findMany: vi.fn().mockResolvedValue(visits) },
    messageTemplate: { findFirst: vi.fn().mockResolvedValue(null) },
    $transaction: vi.fn((fn: (t: typeof tx) => unknown) => fn(tx)),
    tx,
  };
}

const visit = (id: string, propertyId: string, service: string | null, technicianId = "t1") => ({
  id,
  date: DAY,
  createdAt: new Date(`2026-10-01T00:00:0${id.slice(-1)}.000Z`),
  propertyId,
  technicianId,
  service: service ? { name: service } : null,
  property: {
    addressLine: `${propertyId} High St`,
    customer: { id: `c-${propertyId}`, name: "Jo Bloggs", phone: "07700900201", email: null },
  },
});

const NOW = new Date("2026-10-30T19:30:00Z"); // after 19:00 local, targets 31 Oct

beforeEach(() => vi.clearAllMocks());

it("the default reminder names the services", () => {
  expect(DEFAULT_REMINDER_BODY).toContain("{{services}}");
  expect(
    renderReminder(DEFAULT_REMINDER_BODY, { customerName: "Jo", date: "Saturday 31 October", address: "1 High St", businessName: "Coates", services: "window clean and gutter clear" }),
  ).toBe("Hi Jo, this is a reminder that your window clean and gutter clear is booked for Saturday 31 October.");
});

it("{{services}} reads \"window clean\" when the caller names none", () => {
  expect(renderReminder("your {{services}}", { customerName: "Jo", date: "x", address: "y", businessName: "z" })).toBe("your window clean");
});

it("queues one reminder per stop, stamps every visit in it and lists the visit ids", async () => {
  const tp = makeTp([
    visit("v1", "p1", "Window clean"),
    visit("v2", "p1", "Gutter clear"),
    visit("v3", "p2", null),
  ]);
  const queued = await runTenantPreCleanReminders(tp as any, NOW);
  expect(queued).toBe(2);

  expect(tp.tx.visit.updateMany).toHaveBeenNthCalledWith(1, {
    where: { id: { in: ["v1", "v2"] }, NOT: { reminderSentTypes: { has: "EVENING_BEFORE" } } },
    data: { reminderSentAt: NOW, reminderSentTypes: { push: "EVENING_BEFORE" } },
  });
  const rows = tp.tx.integrationOutbox.create.mock.calls.map((c) => c[0].data.payload);
  expect(rows[0]).toMatchObject({ customerId: "c-p1", visitId: "v1", visitIds: ["v1", "v2"], reason: "PRE_CLEAN_REMINDER" });
  expect(rows[0].body).toContain("your window clean and gutter clear is booked");
  expect(rows[1]).toMatchObject({ customerId: "c-p2", visitId: "v3", visitIds: ["v3"] });
  expect(rows[1].body).toContain("your window clean is booked");
});

it("two technicians at one property are two stops", async () => {
  const tp = makeTp([visit("v1", "p1", "Window clean", "t1"), visit("v2", "p1", "Gutter clear", "t2")]);
  await expect(runTenantPreCleanReminders(tp as any, NOW)).resolves.toBe(2);
});

it("a stop already claimed by an overlapping run is not queued twice", async () => {
  const tp = makeTp([visit("v1", "p1", "Window clean"), visit("v2", "p1", "Gutter clear")]);
  tp.tx.visit.updateMany.mockResolvedValue({ count: 0 });
  await expect(runTenantPreCleanReminders(tp as any, NOW)).resolves.toBe(0);
  expect(tp.tx.integrationOutbox.create).not.toHaveBeenCalled();
});
