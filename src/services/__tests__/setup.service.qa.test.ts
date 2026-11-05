import { it, expect, vi } from "vitest";
import { createSetupService } from "../setup.service";

// BUG-05 / BUG-06 / C5 / BUG-04 / BUG-01 coverage for the setup wizard.

function makePrisma(over: Record<string, unknown> = {}) {
  const prisma: any = {
    businessSettings: { findFirst: vi.fn().mockResolvedValue({ defaultPaymentMethod: "BACS", completedSteps: [], preCleanReminders: null, reminderMode: "EVENING_BEFORE", reminderTime: "19:00" }), upsert: vi.fn().mockResolvedValue({}) },
    service: {
      findMany: vi.fn((args: any) =>
        Promise.resolve(
          (args?.where?.id?.in ?? []).filter((id: string) => id !== "ghost").map((id: string) => ({ id, defaultPrice: id === "off" ? 5 : 12.5, active: id !== "off" }))
        )
      ),
    },
    serviceArea: { findUnique: vi.fn().mockResolvedValue({ id: "area1", name: "Wirral", postcodeSector: "CH41" }), findMany: vi.fn().mockResolvedValue([{ id: "area1" }]) },
    round: {
      findUnique: vi.fn().mockResolvedValue({ id: "r1", status: "ACTIVE", frequency: "FOUR_WEEKLY", defaultDay: null }),
      findMany: vi.fn().mockResolvedValue([{ id: "r1", status: "ACTIVE", frequency: "FOUR_WEEKLY", defaultDay: null }]),
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ id: "r1" }),
      update: vi.fn(),
    },
    customer: {
      findUnique: vi.fn(),
      findMany: vi.fn((args: any) => Promise.resolve((args?.where?.id?.in ?? []).map((id: string) => ({ id })))),
      create: vi.fn().mockResolvedValue({ id: "c1" }),
      createMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    property: {
      create: vi.fn().mockResolvedValue({ id: "p1" }),
      createMany: vi.fn().mockResolvedValue({ count: 1 }),
      findMany: vi.fn((args: any) => Promise.resolve((args?.where?.id?.in ?? []).map((id: string) => ({ id })))),
    },
    servicePlan: {
      create: vi.fn().mockImplementation(({ data }: any) => Promise.resolve({ id: "sp", ...data })),
      createMany: vi.fn().mockResolvedValue({ count: 1 }),
      findMany: vi.fn((args: any) => Promise.resolve((args?.where?.id?.in ?? []).map((id: string) => ({ id })))),
    },
    bulkImportAttempt: { findUnique: vi.fn().mockResolvedValue(null), create: vi.fn() },
    $transaction: vi.fn((arg: any) => (Array.isArray(arg) ? Promise.all(arg) : arg(prisma))),
    ...over,
  };
  return prisma;
}

const input = (extra: Record<string, unknown> = {}) => ({
  customerName: "Jo", fullAddress: "1 High St", postcode: "CH41 1AA", serviceAreaId: "area1", roundId: "r1", price: 99, ...extra,
});

it("BUG-06 multi-service: each plan takes its catalogue price, the client price is ignored", async () => {
  const prisma = makePrisma();
  const out = await createSetupService(prisma).addSetupProperty(input({ serviceIds: ["a", "b", "a"] }) as never);
  expect(prisma.servicePlan.create.mock.calls.map((c: any) => [c[0].data.serviceId, c[0].data.price])).toEqual([
    ["a", 12.5],
    ["b", 12.5],
  ]);
  expect(out.servicePlans).toHaveLength(2);
});

it("C5 rejects unknown and inactive services, single or multi", async () => {
  const prisma = makePrisma({ service: { findMany: vi.fn().mockResolvedValue([{ id: "off", defaultPrice: 5, active: false }]) } });
  const svc = createSetupService(prisma);
  await expect(svc.addSetupProperty(input({ serviceIds: ["off"] }) as never)).rejects.toMatchObject({ statusCode: 400, code: "SERVICE_INACTIVE" });
  await expect(svc.addSetupProperty(input({ serviceId: "off" }) as never)).rejects.toMatchObject({ statusCode: 400 });
  await expect(svc.addSetupProperty(input({ serviceIds: ["ghost"] }) as never)).rejects.toMatchObject({ statusCode: 404 });
  expect(prisma.customer.create).not.toHaveBeenCalled();
});

it("BUG-05 a property without a payment method takes the business default (customer and plan)", async () => {
  const prisma = makePrisma();
  await createSetupService(prisma).addSetupProperty(input() as never);
  expect(prisma.customer.create.mock.calls[0][0].data.paymentMethod).toBe("BACS");
  expect(prisma.servicePlan.create.mock.calls[0][0].data.paymentMethod).toBe("BACS");
  await createSetupService(prisma).addSetupProperty(input({ paymentMethod: "CASH" }) as never);
  expect(prisma.servicePlan.create.mock.calls[1][0].data.paymentMethod).toBe("CASH");
});

it("BUG-05 / BUG-06 bulk import: default payment method, catalogue prices, bad service rows reported", async () => {
  const prisma = makePrisma();
  const res = await createSetupService(prisma).bulkAddSetupProperties([
    input({ serviceIds: ["a", "b"] }),
    input({ serviceIds: ["off"] }),
    input({ serviceId: "ghost" }),
  ] as never);
  expect(res.errors.map((e: any) => [e.row, e.field])).toEqual([[1, "serviceIds"], [2, "serviceId"]]);
  expect(prisma.customer.createMany.mock.calls[0][0].data[0].paymentMethod).toBe("BACS");
  const plans = prisma.servicePlan.createMany.mock.calls[0][0].data;
  expect(plans.map((p: any) => [p.price, p.paymentMethod])).toEqual([[12.5, "BACS"], [12.5, "BACS"]]);
});

it("BUG-04 step 8 stores postcode sectors and rejects ones outside the service area", async () => {
  const prisma = makePrisma();
  const svc = createSetupService(prisma);
  await svc.saveFirstRound({ name: "R", serviceAreaId: "area1", postcodeSectors: ["CH41"] });
  expect(prisma.round.create.mock.calls[0][0].data.postcodeSectors).toEqual(["CH41"]);
  await expect(svc.saveFirstRound({ name: "R", serviceAreaId: "area1", postcodeSectors: ["L1"] })).rejects.toMatchObject({ statusCode: 400 });
  // no area: nothing to validate against
  await svc.saveFirstRound({ name: "R", postcodeSectors: ["L1"] });
});

it("BUG-01 setup step 4 resolves reminders into the list and legacy columns", async () => {
  const prisma = makePrisma();
  const svc = createSetupService(prisma);
  await svc.saveRoundSettings({ defaultCycleLength: 28, preCleanReminders: [{ type: "MORNING_OF", time: "06:30" }] });
  expect(prisma.businessSettings.upsert.mock.calls[0][0].update).toMatchObject({
    preCleanReminders: [{ type: "MORNING_OF", time: "06:30" }],
    reminderMode: "MORNING_OF",
    reminderTime: "06:30",
  });
  await svc.saveRoundSettings({ defaultCycleLength: 28, preCleanReminders: [] });
  expect(prisma.businessSettings.upsert.mock.calls[1][0].update).toMatchObject({ preCleanReminders: [], reminderMode: "NONE" });
  await svc.saveRoundSettings({ defaultCycleLength: 28 });
  expect(prisma.businessSettings.upsert.mock.calls[2][0].update.preCleanReminders).toBeUndefined();
});

it("BUG-05 setup step 2 validates the default against the accepted list", async () => {
  const prisma = makePrisma();
  const svc = createSetupService(prisma);
  await svc.savePaymentSetup({ acceptedPaymentMethods: ["GOCARDLESS", "STRIPE"], defaultPaymentMethod: "STRIPE" });
  expect(prisma.businessSettings.upsert.mock.calls[0][0].update).toMatchObject({
    acceptedPaymentMethods: ["GOCARDLESS", "STRIPE"],
    defaultPaymentMethod: "STRIPE",
  });
  await expect(svc.savePaymentSetup({ acceptedPaymentMethods: ["CASH"], defaultPaymentMethod: "CHEQUE" })).rejects.toMatchObject({ statusCode: 400 });
});
