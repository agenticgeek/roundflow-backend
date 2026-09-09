import { it, expect, vi } from "vitest";
import { createCustomerService } from "../customer.service";

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
  const innerPrisma = (prisma.$transaction as ReturnType<typeof vi.fn>).mock.calls;
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
  await createCustomerService(prisma).createProperty("user-1", {
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
  await createCustomerService(prisma).updateCustomer("user-1", "c1", {
    landline: "+44 1665 000111",
  });
  expect(capturedUpdate.data.landline).toBe("+44 1665 000111");
});
