import { it, expect, vi } from "vitest";
import { createCustomerService } from "../customer.service";
import { LifecycleStatus } from "../../generated/tenant-client";
import { UserRole } from "@prisma/client";

function makePrisma() {
  return {
    customer: { findMany: vi.fn(), findUnique: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
    property: { findMany: vi.fn(), findUnique: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn(), count: vi.fn() },
    servicePlan: { findMany: vi.fn(), findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
    round: { findMany: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
    serviceArea: { findUnique: vi.fn() },
    visit: { findMany: vi.fn(), updateMany: vi.fn(), createMany: vi.fn() },
    payment: { findMany: vi.fn() },
    propertyNote: { findMany: vi.fn(), create: vi.fn() },
    photo: { findMany: vi.fn() },
    issue: { findMany: vi.fn() },
    invoice: { findMany: vi.fn() },
    businessSettings: { findFirst: vi.fn() },
    $transaction: vi.fn((cb: any) => cb(makePrisma())),
  } as unknown as Parameters<typeof createCustomerService>[0];
}

it("createCustomerService returns an object", () => {
  expect(createCustomerService(makePrisma())).toBeDefined();
});

it("createProperty writes landline to the customer", async () => {
  const prisma = makePrisma();
  (prisma.serviceArea.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "sa1" });
  (prisma.$transaction as ReturnType<typeof vi.fn>).mockImplementation((cb: any) => cb(makePrisma()));
  const _innerPrisma = (prisma.$transaction as ReturnType<typeof vi.fn>).mock.calls;
  // Capture what was written to customer.create inside the transaction
  let capturedCreate: any;
  const txPrisma = {
    ...makePrisma(),
    customer: {
      ...makePrisma().customer,
      create: vi.fn().mockImplementation((args: any) => {
        capturedCreate = args;
        return Promise.resolve({ id: "c1" });
      }),
    },
    serviceArea: { findUnique: vi.fn().mockResolvedValue({ id: "sa1" }) },
    property: { create: vi.fn().mockResolvedValue({ id: "p1" }) },
    servicePlan: { create: vi.fn().mockResolvedValue({ id: "sp1" }) },
    round: { findUnique: vi.fn().mockResolvedValue(null) },
  };
  (prisma.$transaction as ReturnType<typeof vi.fn>).mockImplementation((cb: any) => cb(txPrisma));
  await createCustomerService(prisma).createProperty({
    customerName: "John Smith",
    phone: "+44 7700 900111",
    landline: "+44 1665 000111",
    addressLine: "12 Market St",
    postcode: "NE66 1SS",
    serviceAreaId: "sa1",
    price: 35,
  });
  expect(capturedCreate.data.landline).toBe("+44 1665 000111");
});

it("updateCustomer writes landline when provided", async () => {
  const prisma = makePrisma();
  (prisma.customer.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
    id: "c1", name: "John", phone: null, landline: null, email: null,
    properties: [{ id: "p1", roundId: null, servicePlans: [{ id: "sp1" }] }],
  });
  let capturedUpdate: any;
  const txPrisma = {
    ...makePrisma(),
    customer: {
      ...makePrisma().customer,
      update: vi.fn().mockImplementation((args: any) => {
        capturedUpdate = args;
        return Promise.resolve({ id: "c1" });
      }),
    },
    property: { update: vi.fn().mockResolvedValue({ id: "p1" }) },
    servicePlan: { update: vi.fn().mockResolvedValue({ id: "sp1" }) },
    round: { findUnique: vi.fn().mockResolvedValue(null) },
  };
  (prisma.$transaction as ReturnType<typeof vi.fn>).mockImplementation((cb: any) => cb(txPrisma));
  await createCustomerService(prisma).updateCustomer("c1", {
    landline: "+44 1665 000111",
  });
  expect(capturedUpdate.data.landline).toBe("+44 1665 000111");
});

// ── getCustomerDetail: servicePlans array ──────────────────────────────────

function makeCustomerWithPlans(plans: object[]) {
  return {
    id: "c1",
    name: "Alice",
    phone: null,
    landline: null,
    email: null,
    status: LifecycleStatus.ACTIVE,
    ghlContactId: null,
    payments: [],
    properties: [
      {
        id: "p1",
        status: LifecycleStatus.ACTIVE,
        addressLine: "1 Test St",
        postcode: "T1 1TT",
        propertyType: null,
        accessNotes: null,
        riskNotes: null,
        roundId: null,
        serviceAreaId: null,
        round: null,
        serviceArea: null,
        notes: [],
        photos: [],
        visits: [],
        servicePlans: plans,
      },
    ],
  };
}

function makeSettings() {
  return { paymentRule: null };
}

it("getCustomerDetail returns servicePlans array with 2 items when property has 2 plans", async () => {
  const prisma = makePrisma();
  const plans = [
    { id: "sp1", serviceId: null, service: null, price: 40, cleanMethod: null, paymentMethod: null, cleaningFrequency: "FOUR_WEEKLY", status: LifecycleStatus.ACTIVE, nextDueDate: null, lastCompleted: null, pauseStartDate: null, pauseEndDate: null },
    { id: "sp2", serviceId: "svc1", service: { name: "Gutters" }, price: 80, cleanMethod: null, paymentMethod: null, cleaningFrequency: "TWELVE_WEEKLY", status: LifecycleStatus.ACTIVE, nextDueDate: null, lastCompleted: null, pauseStartDate: null, pauseEndDate: null },
  ];
  (prisma.customer.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(makeCustomerWithPlans(plans));
  (prisma.businessSettings.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(makeSettings());

  const result = await createCustomerService(prisma).getCustomerDetail("c1", UserRole.ADMIN);

  expect(result.servicePlans).toHaveLength(2);
  expect(result.servicePlans[0].id).toBe("sp1");
  expect(result.servicePlans[1].id).toBe("sp2");
  expect(result.servicePlans[1].serviceName).toBe("Gutters");
  expect(result.tabs.servicePlans).toHaveLength(2);
});

it("getCustomerDetail standingInfo uses active plan frequency when multiple plans exist", async () => {
  const prisma = makePrisma();
  const plans = [
    { id: "sp1", serviceId: null, service: null, price: 40, cleanMethod: null, paymentMethod: null, cleaningFrequency: "FOUR_WEEKLY", status: LifecycleStatus.ACTIVE, nextDueDate: null, lastCompleted: null, pauseStartDate: null, pauseEndDate: null },
    { id: "sp2", serviceId: null, service: null, price: 20, cleanMethod: null, paymentMethod: null, cleaningFrequency: "TWELVE_WEEKLY", status: LifecycleStatus.CANCELLED, nextDueDate: null, lastCompleted: null, pauseStartDate: null, pauseEndDate: null },
  ];
  (prisma.customer.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(makeCustomerWithPlans(plans));
  (prisma.businessSettings.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(makeSettings());

  const result = await createCustomerService(prisma).getCustomerDetail("c1", UserRole.ADMIN);

  expect(result.servicePlans).toHaveLength(2);
  expect(result.standingInfo.frequency).toBe("FOUR_WEEKLY");
});

it("getCustomerDetail returns empty servicePlans when property has no plans", async () => {
  const prisma = makePrisma();
  (prisma.customer.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(makeCustomerWithPlans([]));
  (prisma.businessSettings.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(makeSettings());

  const result = await createCustomerService(prisma).getCustomerDetail("c1", UserRole.ADMIN);

  expect(result.servicePlans).toEqual([]);
  expect(result.tabs.servicePlans).toEqual([]);
});

it("getCustomerDetail returns empty servicePlans when customer has no properties", async () => {
  const prisma = makePrisma();
  (prisma.customer.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
    id: "c1", name: "Bob", phone: null, landline: null, email: null,
    status: LifecycleStatus.ACTIVE, ghlContactId: null, payments: [], properties: [],
  });
  (prisma.businessSettings.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(makeSettings());

  const result = await createCustomerService(prisma).getCustomerDetail("c1", UserRole.ADMIN);

  expect(result.servicePlans).toEqual([]);
  expect(result.property).toBeNull();
});
