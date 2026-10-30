import { it, expect, vi, beforeEach } from "vitest";
import { createCustomerService } from "../customer.service";
import { LifecycleStatus, VisitStatus, PaymentStatus, PaymentMethod } from "../../generated/tenant-client";
import { UserRole } from "@prisma/client";
import { geocodePostcode } from "../../integrations/geocoding/client";

vi.mock("../../integrations/geocoding/client", () => ({
  geocodePostcode: vi.fn(),
}));

beforeEach(() => {
  vi.mocked(geocodePostcode).mockReset();
});

function makePrisma() {
  return {
    customer: { findMany: vi.fn(), findUnique: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn(), count: vi.fn() },
    property: { findMany: vi.fn(), findUnique: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn(), count: vi.fn() },
    servicePlan: { findMany: vi.fn(), findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
    round: { findMany: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
    serviceArea: { findUnique: vi.fn() },
    visit: { findMany: vi.fn(), updateMany: vi.fn(), createMany: vi.fn(), count: vi.fn() },
    payment: { findMany: vi.fn(), aggregate: vi.fn() },
    propertyNote: { findMany: vi.fn(), create: vi.fn() },
    photo: { findMany: vi.fn() },
    issue: { findMany: vi.fn(), count: vi.fn().mockResolvedValue(0) },
    invoice: { findMany: vi.fn(), aggregate: vi.fn().mockResolvedValue({ _sum: { amount: 0 } }) },
    $queryRaw: vi.fn().mockResolvedValue([]),
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

// ── geocoding triggers ──────────────────────────────────────────────────────

it("createProperty triggers a geocode lookup and writes coordinates onto the property", async () => {
  const prisma = makePrisma();
  (prisma.serviceArea.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "sa1" });
  const txPrisma = {
    ...makePrisma(),
    customer: { ...makePrisma().customer, create: vi.fn().mockResolvedValue({ id: "c1" }) },
    serviceArea: { findUnique: vi.fn().mockResolvedValue({ id: "sa1" }) },
    property: { create: vi.fn().mockResolvedValue({ id: "p1" }) },
    servicePlan: { create: vi.fn().mockResolvedValue({ id: "sp1" }) },
    round: { findUnique: vi.fn().mockResolvedValue(null) },
  };
  (prisma.$transaction as ReturnType<typeof vi.fn>).mockImplementation((cb: any) => cb(txPrisma));
  vi.mocked(geocodePostcode).mockResolvedValue({ latitude: 55.4, longitude: -1.7 });

  await createCustomerService(prisma).createProperty({
    customerName: "John Smith",
    addressLine: "12 Market St",
    postcode: "NE66 1SS",
    serviceAreaId: "sa1",
    price: 35,
  });

  await vi.waitFor(() => expect(prisma.property.update).toHaveBeenCalled());
  expect(geocodePostcode).toHaveBeenCalledWith("NE66 1SS");
  expect(prisma.property.update).toHaveBeenCalledWith({
    where: { id: "p1" },
    data: { latitude: 55.4, longitude: -1.7, geocodedAt: expect.any(Date), geocodeError: null },
  });
});

it("createProperty does not throw and records geocodeAttempts/geocodeError when the postcode has no match", async () => {
  const prisma = makePrisma();
  (prisma.serviceArea.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "sa1" });
  const txPrisma = {
    ...makePrisma(),
    customer: { ...makePrisma().customer, create: vi.fn().mockResolvedValue({ id: "c1" }) },
    serviceArea: { findUnique: vi.fn().mockResolvedValue({ id: "sa1" }) },
    property: { create: vi.fn().mockResolvedValue({ id: "p1" }) },
    servicePlan: { create: vi.fn().mockResolvedValue({ id: "sp1" }) },
    round: { findUnique: vi.fn().mockResolvedValue(null) },
  };
  (prisma.$transaction as ReturnType<typeof vi.fn>).mockImplementation((cb: any) => cb(txPrisma));
  vi.mocked(geocodePostcode).mockResolvedValue(null);

  await expect(
    createCustomerService(prisma).createProperty({
      customerName: "John Smith",
      addressLine: "1 Nowhere Rd",
      postcode: "ZZ99 9ZZ",
      serviceAreaId: "sa1",
      price: 35,
    })
  ).resolves.toBeDefined();

  await vi.waitFor(() => expect(prisma.property.update).toHaveBeenCalled());
  expect(prisma.property.update).toHaveBeenCalledWith({
    where: { id: "p1" },
    data: { geocodeAttempts: { increment: 1 }, geocodeError: "postcode not found" },
  });
});

it("createProperty does not throw when the geocoding provider itself fails", async () => {
  const prisma = makePrisma();
  (prisma.serviceArea.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "sa1" });
  const txPrisma = {
    ...makePrisma(),
    customer: { ...makePrisma().customer, create: vi.fn().mockResolvedValue({ id: "c1" }) },
    serviceArea: { findUnique: vi.fn().mockResolvedValue({ id: "sa1" }) },
    property: { create: vi.fn().mockResolvedValue({ id: "p1" }) },
    servicePlan: { create: vi.fn().mockResolvedValue({ id: "sp1" }) },
    round: { findUnique: vi.fn().mockResolvedValue(null) },
  };
  (prisma.$transaction as ReturnType<typeof vi.fn>).mockImplementation((cb: any) => cb(txPrisma));
  vi.mocked(geocodePostcode).mockRejectedValue(new Error("network down"));

  await expect(
    createCustomerService(prisma).createProperty({
      customerName: "John Smith",
      addressLine: "1 Nowhere Rd",
      postcode: "NE66 1SS",
      serviceAreaId: "sa1",
      price: 35,
    })
  ).resolves.toBeDefined();

  await vi.waitFor(() => expect(prisma.property.update).toHaveBeenCalled());
  expect(prisma.property.update).toHaveBeenCalledWith({
    where: { id: "p1" },
    data: { geocodeAttempts: { increment: 1 }, geocodeError: "Error: network down" },
  });
});

it("addPropertyToCustomer triggers a geocode lookup for the new property", async () => {
  const prisma = makePrisma();
  (prisma.customer.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "c1", status: LifecycleStatus.ACTIVE });
  (prisma.serviceArea.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "sa1" });
  const txPrisma = {
    ...makePrisma(),
    serviceArea: { findUnique: vi.fn().mockResolvedValue({ id: "sa1" }) },
    property: { create: vi.fn().mockResolvedValue({ id: "p2" }) },
    servicePlan: { create: vi.fn().mockResolvedValue({ id: "sp2" }) },
    round: { findUnique: vi.fn().mockResolvedValue(null) },
  };
  (prisma.$transaction as ReturnType<typeof vi.fn>).mockImplementation((cb: any) => cb(txPrisma));
  vi.mocked(geocodePostcode).mockResolvedValue({ latitude: 1, longitude: 2 });

  await createCustomerService(prisma).addPropertyToCustomer("c1", {
    addressLine: "5 High St",
    postcode: "NE1 1AA",
    serviceAreaId: "sa1",
    price: 20,
  });

  await vi.waitFor(() => expect(prisma.property.update).toHaveBeenCalled());
  expect(geocodePostcode).toHaveBeenCalledWith("NE1 1AA");
  expect(prisma.property.update).toHaveBeenCalledWith({
    where: { id: "p2" },
    data: { latitude: 1, longitude: 2, geocodedAt: expect.any(Date), geocodeError: null },
  });
});

it("updateProperty resets coordinates and triggers a re-geocode when the postcode changes", async () => {
  const prisma = makePrisma();
  (prisma.property.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
    id: "p1", postcode: "NE66 1AA", roundId: null, serviceAreaId: null, round: null, servicePlans: [],
  });
  const txPrisma = {
    ...makePrisma(),
    property: { update: vi.fn().mockResolvedValue({ id: "p1", postcode: "NE1 9ZZ" }) },
  };
  (prisma.$transaction as ReturnType<typeof vi.fn>).mockImplementation((cb: any) => cb(txPrisma));
  vi.mocked(geocodePostcode).mockResolvedValue({ latitude: 3, longitude: 4 });

  const result = await createCustomerService(prisma).updateProperty("p1", { postcode: "NE1 9ZZ" });

  expect(txPrisma.property.update).toHaveBeenCalledWith({
    where: { id: "p1" },
    data: {
      addressLine: undefined,
      postcode: "NE1 9ZZ",
      propertyName: undefined,
      propertyType: undefined,
      serviceAreaId: undefined,
      accessNotes: undefined,
      riskNotes: undefined,
      roundId: null,
      latitude: null,
      longitude: null,
      geocodedAt: null,
      geocodeAttempts: 0,
      geocodeError: null,
    },
  });
  expect(result).toEqual({ id: "p1", postcode: "NE1 9ZZ", movedToRound: null });
  await vi.waitFor(() => expect(prisma.property.update).toHaveBeenCalled());
  expect(geocodePostcode).toHaveBeenCalledWith("NE1 9ZZ");
});

it("updateProperty cleaningFrequency uses the B3 move logic (updatePlan) and keeps the new round", async () => {
  const prisma = makePrisma();
  (prisma.property.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
    id: "p1", postcode: "NE66 1AA", roundId: "r1", serviceAreaId: "sa1",
    servicePlans: [{ id: "sp-old", status: "CANCELLED" }, { id: "sp1", status: "ACTIVE" }],
  });
  (prisma.servicePlan.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
    id: "sp1", propertyId: "p1", lastCompleted: null,
    property: {
      serviceAreaId: "sa1", serviceArea: { name: "Alnwick" },
      round: { id: "r1", name: "Alnwick Mon 4wk", frequency: "FOUR_WEEKLY", defaultDay: "MON", serviceAreaId: "sa1", roundTechnicians: [], serviceArea: { name: "Alnwick" } },
    },
  });
  (prisma.round.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([{ id: "r2", name: "Alnwick Mon 6wk", defaultDay: "MON" }]);
  const tx = {
    ...makePrisma(),
    property: { update: vi.fn().mockResolvedValue({ id: "p1", postcode: "NE66 1AA", roundId: "r2" }) },
    servicePlan: { update: vi.fn().mockResolvedValue({ id: "sp1" }) },
    visit: { updateMany: vi.fn().mockResolvedValue({ count: 2 }) },
  };
  (prisma.$transaction as ReturnType<typeof vi.fn>).mockImplementation((cb: any) => cb(tx));

  const result = await createCustomerService(prisma).updateProperty("p1", { cleaningFrequency: "SIX_WEEKLY", accessNotes: "gate" });

  expect(prisma.servicePlan.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "sp1" } }));
  expect(tx.visit.updateMany).toHaveBeenCalled();
  expect(tx.property.update).toHaveBeenLastCalledWith({
    where: { id: "p1" },
    data: expect.objectContaining({ accessNotes: "gate", roundId: "r2" }),
  });
  expect(result.movedToRound).toEqual({ id: "r2", name: "Alnwick Mon 6wk", created: false });
});

it("updateProperty cleaningFrequency without a move leaves the round and ignores a property with no plan", async () => {
  const prisma = makePrisma();
  (prisma.property.findUnique as ReturnType<typeof vi.fn>)
    .mockResolvedValueOnce({ id: "p1", postcode: "X", roundId: null, serviceAreaId: null, servicePlans: [{ id: "sp1", status: "PAUSED" }] })
    .mockResolvedValueOnce({ id: "p2", postcode: "X", roundId: "r1", serviceAreaId: null, servicePlans: [] });
  (prisma.servicePlan.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "sp1", property: { round: null } });
  (prisma.servicePlan.update as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "sp1" });
  const tx = { ...makePrisma(), property: { update: vi.fn().mockResolvedValue({ id: "p1", postcode: "X" }) } };
  (prisma.$transaction as ReturnType<typeof vi.fn>).mockImplementation((cb: any) => cb(tx));

  const svc = createCustomerService(prisma);
  const first = await svc.updateProperty("p1", { cleaningFrequency: "SIX_WEEKLY" });
  expect(prisma.servicePlan.update).toHaveBeenCalledWith({ where: { id: "sp1" }, data: { cleaningFrequency: "SIX_WEEKLY" } });
  expect(tx.property.update.mock.calls[0][0].data.roundId).toBeNull();
  expect(first.movedToRound).toBeNull();

  await svc.updateProperty("p2", { cleaningFrequency: "SIX_WEEKLY" });
  expect(prisma.servicePlan.findUnique).toHaveBeenCalledTimes(1);
  expect(tx.property.update.mock.calls[1][0].data.roundId).toBe("r1");
});

it("updateProperty leaves coordinates untouched when the postcode is unchanged", async () => {
  const prisma = makePrisma();
  (prisma.property.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
    id: "p1", postcode: "NE66 1AA", roundId: null, serviceAreaId: null, round: null, servicePlans: [],
  });
  const txPrisma = {
    ...makePrisma(),
    property: { update: vi.fn().mockResolvedValue({ id: "p1" }) },
  };
  (prisma.$transaction as ReturnType<typeof vi.fn>).mockImplementation((cb: any) => cb(txPrisma));

  await createCustomerService(prisma).updateProperty("p1", { addressLine: "New Address Line" });

  expect(txPrisma.property.update).toHaveBeenCalledWith({
    where: { id: "p1" },
    data: {
      addressLine: "New Address Line",
      postcode: undefined,
      propertyName: undefined,
      propertyType: undefined,
      serviceAreaId: undefined,
      accessNotes: undefined,
      riskNotes: undefined,
      roundId: null,
    },
  });
  expect(geocodePostcode).not.toHaveBeenCalled();
  expect(prisma.property.update).not.toHaveBeenCalled();
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
    messagesOptOut: true,
  });
  expect(capturedUpdate.data.landline).toBe("+44 1665 000111");
  expect(capturedUpdate.data.messagesOptOut).toBe(true);
});

it("updateCustomer resets coordinates and triggers a re-geocode when the property's postcode changes", async () => {
  const prisma = makePrisma();
  (prisma.customer.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
    id: "c1", name: "John", phone: null, landline: null, email: null,
    properties: [{ id: "p1", postcode: "NE66 1AA", roundId: null, servicePlans: [{ id: "sp1" }] }],
  });
  const txPrisma = {
    ...makePrisma(),
    property: { update: vi.fn().mockResolvedValue({ id: "p1" }) },
    round: { findUnique: vi.fn().mockResolvedValue(null) },
  };
  (prisma.$transaction as ReturnType<typeof vi.fn>).mockImplementation((cb: any) => cb(txPrisma));
  vi.mocked(geocodePostcode).mockResolvedValue({ latitude: 9, longitude: 10 });

  const result = await createCustomerService(prisma).updateCustomer("c1", { postcode: "NE1 9ZZ" });

  expect(txPrisma.property.update).toHaveBeenCalledWith({
    where: { id: "p1" },
    data: {
      postcode: "NE1 9ZZ",
      latitude: null,
      longitude: null,
      geocodedAt: null,
      geocodeAttempts: 0,
      geocodeError: null,
    },
  });
  expect(result).toEqual({ customerId: "c1", propertyId: "p1", servicePlanId: "sp1" });
  await vi.waitFor(() => expect(prisma.property.update).toHaveBeenCalled());
  expect(geocodePostcode).toHaveBeenCalledWith("NE1 9ZZ");
});

it("updateCustomer leaves coordinates untouched when the property's postcode is unchanged", async () => {
  const prisma = makePrisma();
  (prisma.customer.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
    id: "c1", name: "John", phone: null, landline: null, email: null,
    properties: [{ id: "p1", postcode: "NE66 1AA", roundId: null, servicePlans: [{ id: "sp1" }] }],
  });
  const txPrisma = {
    ...makePrisma(),
    property: { update: vi.fn().mockResolvedValue({ id: "p1" }) },
  };
  (prisma.$transaction as ReturnType<typeof vi.fn>).mockImplementation((cb: any) => cb(txPrisma));

  await createCustomerService(prisma).updateCustomer("c1", { addressLine: "New Line" });

  expect(txPrisma.property.update).toHaveBeenCalledWith({
    where: { id: "p1" },
    data: { addressLine: "New Line" },
  });
  expect(geocodePostcode).not.toHaveBeenCalled();
  expect(prisma.property.update).not.toHaveBeenCalled();
});

it("updateCustomer never calls property.update or geocodes when the customer has no property", async () => {
  const prisma = makePrisma();
  (prisma.customer.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
    id: "c1", name: "John", phone: null, landline: null, email: null, properties: [],
  });
  const txPrisma = makePrisma();
  (prisma.$transaction as ReturnType<typeof vi.fn>).mockImplementation((cb: any) => cb(txPrisma));

  const result = await createCustomerService(prisma).updateCustomer("c1", { postcode: "NE1 9ZZ" });

  expect(txPrisma.property.update).not.toHaveBeenCalled();
  expect(geocodePostcode).not.toHaveBeenCalled();
  expect(result).toEqual({ customerId: "c1", propertyId: null, servicePlanId: null });
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
    invoices: [],
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
  // Both plans are ACTIVE; primaryPlan()'s rule picks the first one found.
  expect(result.servicePlans[0].isPrimary).toBe(true);
  expect(result.servicePlans[1].isPrimary).toBe(false);
});

it("getCustomerDetail marks exactly one servicePlan as isPrimary: true when a later plan is ACTIVE and an earlier one is CANCELLED", async () => {
  const prisma = makePrisma();
  const plans = [
    { id: "sp1", serviceId: null, service: null, price: 40, cleanMethod: null, paymentMethod: null, cleaningFrequency: "FOUR_WEEKLY", status: LifecycleStatus.CANCELLED, nextDueDate: null, lastCompleted: null, pauseStartDate: null, pauseEndDate: null },
    { id: "sp2", serviceId: null, service: null, price: 80, cleanMethod: null, paymentMethod: null, cleaningFrequency: "TWELVE_WEEKLY", status: LifecycleStatus.ACTIVE, nextDueDate: null, lastCompleted: null, pauseStartDate: null, pauseEndDate: null },
  ];
  (prisma.customer.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(makeCustomerWithPlans(plans));
  (prisma.businessSettings.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(makeSettings());

  const result = await createCustomerService(prisma).getCustomerDetail("c1", UserRole.ADMIN);

  expect(result.servicePlans.find((p) => p.id === "sp1")?.isPrimary).toBe(false);
  expect(result.servicePlans.find((p) => p.id === "sp2")?.isPrimary).toBe(true);
});

it("getCustomerDetail falls back the primary plan to servicePlans[0] when none are ACTIVE, marking only that one isPrimary", async () => {
  const prisma = makePrisma();
  const plans = [
    { id: "sp1", serviceId: null, service: null, price: 40, cleanMethod: null, paymentMethod: null, cleaningFrequency: "FOUR_WEEKLY", status: LifecycleStatus.CANCELLED, nextDueDate: null, lastCompleted: null, pauseStartDate: null, pauseEndDate: null },
    { id: "sp2", serviceId: null, service: null, price: 80, cleanMethod: null, paymentMethod: null, cleaningFrequency: "TWELVE_WEEKLY", status: LifecycleStatus.CANCELLED, nextDueDate: null, lastCompleted: null, pauseStartDate: null, pauseEndDate: null },
  ];
  (prisma.customer.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(makeCustomerWithPlans(plans));
  (prisma.businessSettings.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(makeSettings());

  const result = await createCustomerService(prisma).getCustomerDetail("c1", UserRole.ADMIN);

  expect(result.servicePlans.find((p) => p.id === "sp1")?.isPrimary).toBe(true);
  expect(result.servicePlans.find((p) => p.id === "sp2")?.isPrimary).toBe(false);
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
    status: LifecycleStatus.ACTIVE, ghlContactId: null, payments: [], invoices: [], properties: [],
  });
  (prisma.businessSettings.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(makeSettings());

  const result = await createCustomerService(prisma).getCustomerDetail("c1", UserRole.ADMIN);

  expect(result.servicePlans).toEqual([]);
  expect(result.property).toBeNull();
});

// ── getCustomers: list filtering & pagination ──────────────────────────────

function makeListedCustomer(opts: {
  id: string;
  onHold?: boolean;
  paymentStatus?: PaymentStatus | null;
  amount?: number;
}) {
  const { id, onHold = false, paymentStatus = null, amount = 0 } = opts;
  return {
    id,
    name: `Customer ${id}`,
    status: LifecycleStatus.ACTIVE,
    holdNextClean: false,
    badDebt: false,
    payments: paymentStatus
      ? [{ status: paymentStatus, amount, createdAt: new Date("2026-01-01") }]
      : [],
    invoices: [] as Array<{ status: string; dueDate: Date | null; amount: number }>,
    properties: [
      {
        id: `p-${id}`,
        status: LifecycleStatus.ACTIVE,
        addressLine: "1 Test St",
        postcode: "T1 1TT",
        roundId: null,
        round: null,
        servicePlans: [],
        visits: onHold
          ? [{ paymentHold: true, technicianId: null, technician: null }]
          : [],
      },
    ],
  };
}

function mockSummaryCounts(
  prisma: ReturnType<typeof makePrisma>,
  { total, active, holds }: { total: number; active: number; holds: number }
) {
  (prisma.customer.count as ReturnType<typeof vi.fn>)
    .mockResolvedValueOnce(total)
    .mockResolvedValueOnce(active)
    .mockResolvedValueOnce(holds);
  (prisma.invoice.aggregate as ReturnType<typeof vi.fn>).mockResolvedValue({
    _sum: { amount: 0 },
  });
}

it("getCustomers({status:'HOLD'}) pushes the paymentHold semi-join into `where` and paginates at the DB level", async () => {
  const prisma = makePrisma();
  mockSummaryCounts(prisma, { total: 20, active: 13, holds: 7 });
  // 4th call to customer.count is the paginated HOLD-filtered count.
  (prisma.customer.count as ReturnType<typeof vi.fn>).mockResolvedValueOnce(7);
  const page2 = [
    makeListedCustomer({ id: "h3", onHold: true }),
    makeListedCustomer({ id: "h4", onHold: true }),
  ];
  (prisma.customer.findMany as ReturnType<typeof vi.fn>).mockResolvedValue(page2);

  const result = await createCustomerService(prisma).getCustomers(
    { status: "HOLD", page: 2, pageSize: 2 },
    UserRole.ADMIN
  );

  expect(result.customers).toHaveLength(2);
  expect(result.customers.map((c) => c.customerId)).toEqual(["h3", "h4"]);
  expect(result.pagination).toEqual({ page: 2, pageSize: 2, total: 7, totalPages: 4 });

  // Must NOT be a bare fetch-all: where.properties.some.visits.some carries the
  // paymentHold semi-join, and take/skip are passed straight to findMany.
  const findManyArgs = (prisma.customer.findMany as ReturnType<typeof vi.fn>).mock.calls[0][0];
  expect(findManyArgs.take).toBe(2);
  expect(findManyArgs.skip).toBe(2);
  expect(findManyArgs.where.properties.some.visits.some).toEqual({
    paymentHold: true,
    status: { in: [VisitStatus.SCHEDULED, VisitStatus.IN_PROGRESS] },
  });

  // Pagination count must use the same where (the HOLD semi-join), not count().
  const countCalls = (prisma.customer.count as ReturnType<typeof vi.fn>).mock.calls;
  const paginatedCountArgs = countCalls[countCalls.length - 1][0];
  expect(paginatedCountArgs.where.properties.some.visits.some.paymentHold).toBe(true);
});

it("getCustomers({status:'HOLD', roundId}) combines the roundId filter with the paymentHold semi-join", async () => {
  const prisma = makePrisma();
  mockSummaryCounts(prisma, { total: 5, active: 3, holds: 2 });
  (prisma.customer.count as ReturnType<typeof vi.fn>).mockResolvedValueOnce(2);
  (prisma.customer.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
    makeListedCustomer({ id: "h1", onHold: true }),
  ]);

  await createCustomerService(prisma).getCustomers(
    { status: "HOLD", roundId: "r1" },
    UserRole.ADMIN
  );

  const findManyArgs = (prisma.customer.findMany as ReturnType<typeof vi.fn>).mock.calls[0][0];
  expect(findManyArgs.where.properties.some.roundId).toBe("r1");
  expect(findManyArgs.where.properties.some.visits.some.paymentHold).toBe(true);
});

it.each(["ACTIVE", "PAUSED", "CANCELLED", undefined] as const)(
  "getCustomers(%s) uses plain status where and the standard count+findMany path",
  async (status) => {
    const prisma = makePrisma();
    mockSummaryCounts(prisma, { total: 10, active: 6, holds: 1 });
    (prisma.customer.count as ReturnType<typeof vi.fn>).mockResolvedValueOnce(1);
    const fixture = makeListedCustomer({
      id: "c1",
      paymentStatus: PaymentStatus.PENDING,
      amount: 50,
    });
    fixture.invoices = [{ status: "SENT", dueDate: null, amount: 50 }];
    (prisma.customer.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([fixture]);

    const result = await createCustomerService(prisma).getCustomers(
      status ? { status } : {},
      UserRole.ADMIN
    );

    expect(result.customers).toHaveLength(1);
    expect(result.customers[0].customerId).toBe("c1");
    expect(result.customers[0].amountDue).toBe(50);
    expect(result.customers[0].paymentStatus).toBe("UNPAID");
    expect(result.pagination.total).toBe(1);

    const findManyArgs = (prisma.customer.findMany as ReturnType<typeof vi.fn>).mock.calls[0][0];
    if (status) {
      expect(findManyArgs.where.status).toBe(status);
    } else {
      expect(findManyArgs.where.status).toBeUndefined();
    }
    // Regression guard: non-HOLD statuses never get the paymentHold semi-join.
    expect(findManyArgs.where.properties).toBeUndefined();
  }
);

it("getCustomers sums amountDue across ALL unpaid SENT invoices and ignores paid/draft/void ones", async () => {
  const prisma = makePrisma();
  mockSummaryCounts(prisma, { total: 1, active: 1, holds: 0 });
  (prisma.customer.count as ReturnType<typeof vi.fn>).mockResolvedValueOnce(1);
  const fixture = makeListedCustomer({ id: "c1" });
  fixture.invoices = [
    { status: "SENT", dueDate: new Date("2099-01-01"), amount: 50 },
    { status: "SENT", dueDate: null, amount: 30 },
    { status: "PAID", dueDate: null, amount: 99 },
    { status: "DRAFT", dueDate: null, amount: 11 },
    { status: "VOID", dueDate: null, amount: 7 },
  ];
  (prisma.customer.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([fixture]);

  const result = await createCustomerService(prisma).getCustomers({}, UserRole.ADMIN);

  expect(result.customers[0].amountDue).toBe(80);
  expect(result.customers[0].paymentStatus).toBe("UNPAID");
  // Invoices are not take-limited (amountDue needs all of them).
  const findManyArgs = (prisma.customer.findMany as ReturnType<typeof vi.fn>).mock.calls[0][0];
  expect(findManyArgs.include.invoices.take).toBeUndefined();
});

it("getCustomers: ON_HOLD from holdNextClean, nextDue falls back to the next open visit, badDebt passes through", async () => {
  const prisma = makePrisma();
  mockSummaryCounts(prisma, { total: 1, active: 1, holds: 0 });
  (prisma.customer.count as ReturnType<typeof vi.fn>).mockResolvedValueOnce(1);
  const fixture = makeListedCustomer({ id: "c1" });
  fixture.holdNextClean = true;
  fixture.badDebt = true;
  (fixture.properties[0] as any).visits = [
    { paymentHold: false, technicianId: "t1", technician: { name: "Sam" }, date: new Date("2026-11-06") },
  ];
  (prisma.customer.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([fixture]);

  const result = await createCustomerService(prisma).getCustomers({}, UserRole.ADMIN);

  expect(result.customers[0].paymentStatus).toBe("ON_HOLD");
  expect(result.customers[0].onHold).toBe(false);
  expect(result.customers[0].badDebt).toBe(true);
  expect(result.customers[0].nextDueDate).toBeNull();
  expect(result.customers[0].nextDue).toEqual(new Date("2026-11-06"));
});

it("getCustomers({status:'HOLD'}) returns a multi-property customer whose onHold visit is on a non-primary property, with onHold=true", async () => {
  // Regression test for: the HOLD filter matches if ANY property has an
  // on-hold visit, but toRow() used to compute `onHold` only from the single
  // primary (active-or-first) property — a customer could match the filter
  // via a secondary property while its own `onHold` field stayed false.
  const prisma = makePrisma();
  mockSummaryCounts(prisma, { total: 1, active: 0, holds: 1 });
  (prisma.customer.count as ReturnType<typeof vi.fn>).mockResolvedValueOnce(1);
  const multiPropertyCustomer = {
    id: "c1",
    name: "Customer c1",
    status: LifecycleStatus.ACTIVE,
    payments: [],
    invoices: [],
    properties: [
      {
        // Primary (active, listed first): no on-hold visit.
        id: "p-primary",
        status: LifecycleStatus.ACTIVE,
        addressLine: "1 Primary St",
        postcode: "P1 1PP",
        roundId: null,
        round: null,
        servicePlans: [],
        visits: [],
      },
      {
        // Secondary (not active): has the on-hold visit.
        id: "p-secondary",
        status: LifecycleStatus.PAUSED,
        addressLine: "2 Secondary St",
        postcode: "S1 1SS",
        roundId: null,
        round: null,
        servicePlans: [],
        visits: [{ paymentHold: true, technicianId: null, technician: null }],
      },
    ],
  };
  (prisma.customer.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([multiPropertyCustomer]);

  const result = await createCustomerService(prisma).getCustomers(
    { status: "HOLD" },
    UserRole.ADMIN
  );

  expect(result.customers).toHaveLength(1);
  expect(result.customers[0].customerId).toBe("c1");
  expect(result.customers[0].onHold).toBe(true);
});

it("getCustomers hides amountDue for TECHNICIAN viewers", async () => {
  const prisma = makePrisma();
  mockSummaryCounts(prisma, { total: 1, active: 1, holds: 0 });
  (prisma.customer.count as ReturnType<typeof vi.fn>).mockResolvedValueOnce(1);
  (prisma.customer.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
    makeListedCustomer({ id: "c1" }),
  ]);

  const result = await createCustomerService(prisma).getCustomers({}, UserRole.TECHNICIAN);

  expect(result.customers[0].amountDue).toBeUndefined();
  expect(result.summary.amountDue).toBeUndefined();
});

it("getCustomers rejects an invalid status filter", async () => {
  const prisma = makePrisma();
  await expect(
    createCustomerService(prisma).getCustomers({ status: "BOGUS" }, UserRole.ADMIN)
  ).rejects.toMatchObject({ statusCode: 400 });
});

it("getCustomers skips customers with no properties", async () => {
  const prisma = makePrisma();
  mockSummaryCounts(prisma, { total: 1, active: 1, holds: 0 });
  (prisma.customer.count as ReturnType<typeof vi.fn>).mockResolvedValueOnce(1);
  (prisma.customer.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
    { id: "c1", name: "No Property", status: LifecycleStatus.ACTIVE, payments: [], invoices: [], properties: [] },
  ]);

  const result = await createCustomerService(prisma).getCustomers({}, UserRole.ADMIN);

  expect(result.customers).toEqual([]);
});

// ── getCustomerDetail: visit/payment caps ──────────────────────────────────

function makeVisit(opts: {
  id: string;
  date: Date;
  status?: VisitStatus;
  paymentHold?: boolean;
}) {
  const { id, date, status = VisitStatus.COMPLETED, paymentHold = false } = opts;
  return {
    id,
    date,
    status,
    paymentHold,
    notes: null,
    price: 35,
    round: null,
    technician: null,
    invoice: null,
    payment: null,
    issues: [],
  };
}

function makeCustomerWithVisitsAndPayments(opts: {
  visitCount: number;
  payments: Array<{ status: PaymentStatus; amount: number; paidAt: Date | null }>;
}) {
  const { visitCount, payments } = opts;
  // Simulate the DB already having applied `orderBy: { date: "desc" }, take: 50` —
  // the mock returns visits newest-first and capped, exactly as Prisma would.
  const visits = Array.from({ length: visitCount }, (_, i) =>
    makeVisit({
      id: `v${visitCount - i}`,
      date: new Date(2026, 0, visitCount - i),
    })
  );
  return {
    id: "c1",
    name: "Dana",
    phone: null,
    email: null,
    status: LifecycleStatus.ACTIVE,
    ghlContactId: null,
    payments,
    invoices: [] as Array<{ status: string; dueDate: Date | null; amount: number }>,
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
        visits,
        servicePlans: [],
      },
    ],
  };
}

it("getCustomerDetail caps visitHistory/payments tabs at 50, newest-first, independent of the full payments history", async () => {
  const prisma = makePrisma();
  // 50 visits (already capped/ordered by the query, per the take:50/orderBy:desc fix).
  const customer = makeCustomerWithVisitsAndPayments({
    visitCount: 50,
    payments: [
      { status: PaymentStatus.PAID, amount: 100, paidAt: new Date("2026-01-01") },
      { status: PaymentStatus.OVERDUE, amount: 40, paidAt: null },
      { status: PaymentStatus.PENDING, amount: 60, paidAt: null },
      { status: PaymentStatus.PAID, amount: 20, paidAt: new Date("2026-03-01") },
    ],
  });
  (prisma.customer.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(customer);
  (prisma.businessSettings.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(makeSettings());

  const result = await createCustomerService(prisma).getCustomerDetail("c1", UserRole.ADMIN);

  expect(result.tabs.visitHistory).toHaveLength(50);
  expect(result.tabs.payments?.rows).toHaveLength(50);
  // newest-first
  expect(result.tabs.visitHistory[0].visitId).toBe("v50");
  expect(result.tabs.visitHistory[49].visitId).toBe("v1");

  // outstandingBalance/amountDue come from unpaid SENT invoices (GAP-021);
  // lastPaymentDate from the FULL payments array (not capped at 50).
  expect(result.standingInfo.outstandingBalance).toBe(0);
  expect(result.standingInfo.lastPaymentDate).toEqual(new Date("2026-03-01"));

  // The query itself must request the capped/ordered visits include.
  const includeArgs = (prisma.customer.findUnique as ReturnType<typeof vi.fn>).mock.calls[0][0];
  const visitsInclude = includeArgs.include.properties.include.visits;
  expect(visitsInclude.take).toBe(50);
  expect(visitsInclude.orderBy).toEqual({ date: "desc" });
});

it("getCustomerDetail includes the payment method on each payments.rows entry", async () => {
  const prisma = makePrisma();
  const customer = {
    id: "c1",
    name: "Dana",
    phone: null,
    email: null,
    status: LifecycleStatus.ACTIVE,
    ghlContactId: null,
    payments: [],
    invoices: [],
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
        servicePlans: [],
        visits: [
          {
            id: "v1",
            date: new Date("2026-03-01"),
            status: VisitStatus.COMPLETED,
            paymentHold: false,
            notes: null,
            price: 35,
            round: null,
            technician: null,
            invoice: null,
            payment: {
              id: "pay-1",
              status: PaymentStatus.PENDING,
              amount: 35,
              method: PaymentMethod.BACS,
              gocardlessId: null,
              stripeId: null,
            },
            issues: [],
          },
          {
            id: "v2",
            date: new Date("2026-02-01"),
            status: VisitStatus.COMPLETED,
            paymentHold: false,
            notes: null,
            price: 35,
            round: null,
            technician: null,
            invoice: null,
            payment: null,
            issues: [],
          },
        ],
      },
    ],
  };
  (prisma.customer.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(customer);
  (prisma.businessSettings.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(makeSettings());

  const result = await createCustomerService(prisma).getCustomerDetail("c1", UserRole.ADMIN);

  const rows = result.tabs.payments?.rows ?? [];
  expect(rows.find((r) => r.visitId === "v1")?.method).toBe(PaymentMethod.BACS);
  expect(rows.find((r) => r.visitId === "v2")?.method).toBeNull();
});

it("getCustomerDetail counts issues from the FULL visit history, not just the 50-visit cap", async () => {
  // Regression test for: issuesCount used to sum `v.issues.length` over the
  // now-50-capped `visits` array, silently dropping issues logged on any
  // visit outside the most-recent 50 for a long-tenured customer.
  const prisma = makePrisma();
  const customer = makeCustomerWithVisitsAndPayments({ visitCount: 50, payments: [] });
  (prisma.customer.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(customer);
  (prisma.businessSettings.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(makeSettings());
  // The true count spans visits outside the 50-visit window the main query caps to.
  (prisma.issue.count as ReturnType<typeof vi.fn>).mockResolvedValue(7);

  const result = await createCustomerService(prisma).getCustomerDetail("c1", UserRole.ADMIN);

  expect(result.standingInfo.issuesCount).toBe(7);
  // Scoped to this customer's property, not a bare table-wide count.
  const countArgs = (prisma.issue.count as ReturnType<typeof vi.fn>).mock.calls[0][0];
  expect(countArgs.where.visit.propertyId).toBe("p1");
});

it("getCustomerDetail handles a customer with 0 visits and 0 payments (empty-state)", async () => {
  const prisma = makePrisma();
  const customer = makeCustomerWithVisitsAndPayments({ visitCount: 0, payments: [] });
  (prisma.customer.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(customer);
  (prisma.businessSettings.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(makeSettings());

  const result = await createCustomerService(prisma).getCustomerDetail("c1", UserRole.ADMIN);

  expect(result.tabs.visitHistory).toEqual([]);
  expect(result.tabs.payments?.rows).toEqual([]);
  expect(result.standingInfo.outstandingBalance).toBe(0);
  expect(result.standingInfo.lastPaymentDate).toBeNull();
  expect(result.standingInfo.issuesCount).toBe(0);
  expect(result.standingInfo.nextVisitStatus).toBeNull();
});

it("getCustomerDetail hides outstandingBalance for TECHNICIAN viewers", async () => {
  const prisma = makePrisma();
  const customer = makeCustomerWithVisitsAndPayments({
    visitCount: 1,
    payments: [{ status: PaymentStatus.OVERDUE, amount: 40, paidAt: null }],
  });
  (prisma.customer.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(customer);
  (prisma.businessSettings.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(makeSettings());

  const result = await createCustomerService(prisma).getCustomerDetail("c1", UserRole.TECHNICIAN);

  expect(result.standingInfo.outstandingBalance).toBeUndefined();
  expect(result.tabs.payments).toBeUndefined();
});

it("getCustomerDetail throws 404 for an unknown customer", async () => {
  const prisma = makePrisma();
  (prisma.customer.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);
  (prisma.businessSettings.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(makeSettings());

  await expect(
    createCustomerService(prisma).getCustomerDetail("missing", UserRole.ADMIN)
  ).rejects.toMatchObject({ statusCode: 404 });
});

// ── coverage closers: search filter, FAILED badge, servicePlans picking,
//    scheduled-visit sort, onHold short-circuit, notes mapping ────────────

it("getCustomers applies the search filter and resolves 'failed'/plan fields from a populated property", async () => {
  const prisma = makePrisma();
  mockSummaryCounts(prisma, { total: 1, active: 0, holds: 0 });
  (prisma.customer.count as ReturnType<typeof vi.fn>).mockResolvedValueOnce(1);
  const fixture = {
    id: "c1",
    name: "Searched Co",
    status: LifecycleStatus.ACTIVE,
    payments: [{ status: PaymentStatus.FAILED, amount: 10, createdAt: new Date("2026-01-01") }],
    invoices: [],
    properties: [
      {
        id: "p1",
        status: LifecycleStatus.ACTIVE,
        addressLine: "1 Search St",
        postcode: "S1 1SS",
        roundId: "r1",
        round: { name: "Round A", frequency: "FOUR_WEEKLY" },
        servicePlans: [
          { status: LifecycleStatus.CANCELLED, cleaningFrequency: "TWELVE_WEEKLY", price: 10, nextDueDate: null },
          { status: LifecycleStatus.ACTIVE, cleaningFrequency: "FOUR_WEEKLY", price: 45, nextDueDate: new Date("2026-02-01") },
        ],
        visits: [],
      },
    ],
  };
  (prisma.customer.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([fixture]);

  const result = await createCustomerService(prisma).getCustomers(
    { search: "Search" },
    UserRole.ADMIN
  );

  expect(result.customers).toHaveLength(1);
  expect(result.customers[0].paymentStatus).toBe("FAILED");
  expect(result.customers[0].price).toBe(45);
  expect(result.customers[0].frequency).toBe("FOUR_WEEKLY");

  const findManyArgs = (prisma.customer.findMany as ReturnType<typeof vi.fn>).mock.calls[0][0];
  expect(findManyArgs.where.OR).toEqual([
    { name: { contains: "Search", mode: "insensitive" } },
    { properties: { some: { addressLine: { contains: "Search", mode: "insensitive" } } } },
    { properties: { some: { postcode: { contains: "Search", mode: "insensitive" } } } },
  ]);
});

it("getCustomers falls back to 0 when the due-payment aggregate sum is null", async () => {
  const prisma = makePrisma();
  (prisma.customer.count as ReturnType<typeof vi.fn>)
    .mockResolvedValueOnce(0)
    .mockResolvedValueOnce(0)
    .mockResolvedValueOnce(0)
    .mockResolvedValueOnce(0);
  (prisma.invoice.aggregate as ReturnType<typeof vi.fn>).mockResolvedValue({
    _sum: { amount: null },
  });
  (prisma.customer.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);

  const result = await createCustomerService(prisma).getCustomers({}, UserRole.ADMIN);

  expect(result.summary.amountDue).toBe(0);
});

it("getCustomerDetail sorts multiple scheduled visits, evaluates the paymentHold short-circuit, and maps property notes", async () => {
  const prisma = makePrisma();
  const customer = {
    id: "c1",
    name: "Dana",
    phone: null,
    email: null,
    status: LifecycleStatus.ACTIVE,
    ghlContactId: null,
    payments: [],
    invoices: [],
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
        notes: [{ id: "n1", propertyId: "p1", type: "GENERAL", body: "hello", authorProfileId: null, createdAt: new Date() }],
        photos: [],
        servicePlans: [],
        visits: [
          // Two OPEN_VISIT entries out of order, plus one on-hold-but-not-open visit
          // (exercises the paymentHold && OPEN_VISIT.includes(...) short-circuit).
          makeVisit({ id: "v-later", date: new Date("2026-05-10"), status: VisitStatus.SCHEDULED }),
          makeVisit({ id: "v-earlier", date: new Date("2026-05-05"), status: VisitStatus.IN_PROGRESS }),
          makeVisit({ id: "v-hold-completed", date: new Date("2026-01-01"), status: VisitStatus.COMPLETED, paymentHold: true }),
        ],
      },
    ],
  };
  (prisma.customer.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(customer);
  (prisma.businessSettings.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(makeSettings());

  const result = await createCustomerService(prisma).getCustomerDetail("c1", UserRole.ADMIN);

  // Scheduled visits sorted earliest-first for "next scheduled" selection.
  expect(result.standingInfo.nextVisitStatus).toBe(VisitStatus.IN_PROGRESS);
  // paymentHold is true on a COMPLETED visit only — not an open one — so onHold is false.
  expect(result.standingInfo.paymentStatus).toBe("NONE");
  expect(result.tabs.notes).toEqual([{ ...customer.properties[0].notes[0], authorName: null }]);
});

// ── per-plan writes: delegate to service-plan-lifecycle (tested in depth there) ──

type Fn = ReturnType<typeof vi.fn>;

function txReturning(prisma: ReturnType<typeof makePrisma>, tx: Record<string, unknown>) {
  (prisma.$transaction as Fn).mockImplementation((cb: any) => cb(tx));
}

it("updateServicePlan throws 404 when the plan does not exist", async () => {
  const prisma = makePrisma();
  (prisma.servicePlan.findUnique as Fn).mockResolvedValue(null);

  await expect(
    createCustomerService(prisma).updateServicePlan("missing", { price: 50 })
  ).rejects.toMatchObject({ statusCode: 404 });
});

it("updateServicePlan returns { servicePlan, movedToRound: null } for a plain field update", async () => {
  const prisma = makePrisma();
  (prisma.servicePlan.findUnique as Fn).mockResolvedValue({ id: "sp1", property: { round: null } });
  (prisma.servicePlan.update as Fn).mockResolvedValue({ id: "sp1", price: 50 });

  const result = await createCustomerService(prisma).updateServicePlan("sp1", { price: 50 });

  expect(result).toEqual({ servicePlan: { id: "sp1", price: 50 }, movedToRound: null });
  expect(prisma.servicePlan.update).toHaveBeenCalledWith({ where: { id: "sp1" }, data: { price: 50 } });
});

it("pauseServicePlan throws 404 when the plan does not exist", async () => {
  const prisma = makePrisma();
  (prisma.servicePlan.findUnique as Fn).mockResolvedValue(null);
  await expect(
    createCustomerService(prisma).pauseServicePlan("missing", { pauseStartDate: new Date() })
  ).rejects.toMatchObject({ statusCode: 404 });
});

it("pauseServicePlan throws 409 when the plan is already paused", async () => {
  const prisma = makePrisma();
  (prisma.servicePlan.findUnique as Fn).mockResolvedValue({ id: "sp1", status: LifecycleStatus.PAUSED });
  await expect(
    createCustomerService(prisma).pauseServicePlan("sp1", { pauseStartDate: new Date() })
  ).rejects.toMatchObject({ statusCode: 409 });
});

it("pauseServicePlan pauses now, cancels visits and reports cancelledVisits", async () => {
  const prisma = makePrisma();
  (prisma.servicePlan.findUnique as Fn).mockResolvedValue({ id: "sp1", status: LifecycleStatus.ACTIVE });
  const tx = {
    visit: { updateMany: vi.fn().mockResolvedValue({ count: 2 }) },
    servicePlan: { update: vi.fn().mockResolvedValue({ id: "sp1", status: LifecycleStatus.PAUSED }) },
  };
  txReturning(prisma, tx);

  const result = await createCustomerService(prisma).pauseServicePlan("sp1", { pauseStartDate: new Date("2020-01-01") });

  expect(result).toMatchObject({ id: "sp1", cancelledVisits: 2, pauseScheduled: false });
  expect(tx.servicePlan.update.mock.calls[0][0].data.status).toBe(LifecycleStatus.PAUSED);
});

it("resumeServicePlan throws 404 when the plan does not exist", async () => {
  const prisma = makePrisma();
  (prisma.servicePlan.findUnique as Fn).mockResolvedValue(null);
  await expect(createCustomerService(prisma).resumeServicePlan("missing")).rejects.toMatchObject({ statusCode: 404 });
});

it("resumeServicePlan throws 409 when the plan is ACTIVE with no scheduled pause", async () => {
  const prisma = makePrisma();
  (prisma.servicePlan.findUnique as Fn).mockResolvedValue({ id: "sp1", status: LifecycleStatus.ACTIVE, pauseStartDate: null });
  await expect(createCustomerService(prisma).resumeServicePlan("sp1")).rejects.toMatchObject({ statusCode: 409 });
});

it("resumeServicePlan resumes a PAUSED plan and recomputes nextDueDate", async () => {
  const prisma = makePrisma();
  (prisma.servicePlan.findUnique as Fn).mockResolvedValue({ id: "sp1", propertyId: "p1", status: LifecycleStatus.PAUSED });
  (prisma.property.findUnique as Fn).mockResolvedValue({ round: { defaultDay: "FRI" } });
  (prisma.servicePlan.update as Fn).mockResolvedValue({ id: "sp1", status: LifecycleStatus.ACTIVE });

  await createCustomerService(prisma).resumeServicePlan("sp1");

  const data = (prisma.servicePlan.update as Fn).mock.calls[0][0].data;
  expect(data).toMatchObject({ status: LifecycleStatus.ACTIVE, pauseStartDate: null, pauseEndDate: null });
  expect((data.nextDueDate as Date).getUTCDay()).toBe(5);
});

it("resumeServicePlan cancels a scheduled (future) pause on an ACTIVE plan", async () => {
  const prisma = makePrisma();
  (prisma.servicePlan.findUnique as Fn).mockResolvedValue({
    id: "sp1", propertyId: "p1", status: LifecycleStatus.ACTIVE, pauseStartDate: new Date("2099-01-01"),
  });
  (prisma.property.findUnique as Fn).mockResolvedValue(null);
  (prisma.servicePlan.update as Fn).mockResolvedValue({ id: "sp1" });

  await createCustomerService(prisma).resumeServicePlan("sp1");
  expect(prisma.servicePlan.update).toHaveBeenCalled();
});

it("pauseService (property-level) pauses the primary plan; 409 when already paused", async () => {
  const prisma = makePrisma();
  (prisma.property.findUnique as Fn).mockResolvedValueOnce({
    id: "p1", servicePlans: [{ id: "sp1", status: LifecycleStatus.PAUSED }],
  });
  await expect(
    createCustomerService(prisma).pauseService("p1", { pauseStartDate: new Date() })
  ).rejects.toMatchObject({ statusCode: 409 });

  (prisma.property.findUnique as Fn).mockResolvedValueOnce({
    id: "p1", servicePlans: [{ id: "sp1", status: LifecycleStatus.ACTIVE }],
  });
  txReturning(prisma, {
    visit: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
    servicePlan: { update: vi.fn().mockResolvedValue({ id: "sp1" }) },
  });
  const result = await createCustomerService(prisma).pauseService("p1", { pauseStartDate: new Date("2099-01-01") });
  expect(result).toMatchObject({ cancelledVisits: 0, pauseScheduled: true });
});

it("resumeService (property-level) resumes the primary plan; 409 when not paused", async () => {
  const prisma = makePrisma();
  (prisma.property.findUnique as Fn).mockResolvedValueOnce({
    id: "p1", servicePlans: [{ id: "sp1", status: LifecycleStatus.ACTIVE, pauseStartDate: null }],
  });
  await expect(createCustomerService(prisma).resumeService("p1")).rejects.toMatchObject({ statusCode: 409 });

  (prisma.property.findUnique as Fn)
    .mockResolvedValueOnce({ id: "p1", servicePlans: [{ id: "sp1", propertyId: "p1", status: LifecycleStatus.PAUSED }] })
    .mockResolvedValueOnce({ round: null });
  (prisma.servicePlan.update as Fn).mockResolvedValue({ id: "sp1", status: LifecycleStatus.ACTIVE });
  expect(await createCustomerService(prisma).resumeService("p1")).toEqual({ id: "sp1", status: LifecycleStatus.ACTIVE });
});

// ── GAP-022: bad debt, pinned notes ─────────────────────────────────────────

it("setBadDebt 404s for an unknown customer and updates the flag otherwise", async () => {
  const prisma = makePrisma();
  (prisma.customer.findUnique as Fn).mockResolvedValueOnce(null);
  await expect(createCustomerService(prisma).setBadDebt("x", true)).rejects.toMatchObject({ statusCode: 404 });

  (prisma.customer.findUnique as Fn).mockResolvedValueOnce({ id: "c1" });
  (prisma.customer.update as Fn).mockResolvedValue({ id: "c1", badDebt: true });
  expect(await createCustomerService(prisma).setBadDebt("c1", true)).toEqual({ id: "c1", badDebt: true });
  expect((prisma.customer.update as Fn).mock.calls[0][0].data).toEqual({ badDebt: true });
});

it("getNotes 404s for an unknown property", async () => {
  const prisma = makePrisma();
  (prisma.property.findUnique as Fn).mockResolvedValue(null);
  await expect(createCustomerService(prisma).getNotes("x")).rejects.toMatchObject({ statusCode: 404 });
});

it("getNotes prepends pinned ACCESS then RISK entries before the notes", async () => {
  const prisma = makePrisma();
  (prisma.property.findUnique as Fn).mockResolvedValue({ accessNotes: "Gate code 1234", riskNotes: "Dog" });
  const note = { id: "n1", body: "hi" };
  (prisma.propertyNote.findMany as Fn).mockResolvedValue([note]);

  const result = await createCustomerService(prisma).getNotes("p1");

  expect(result).toEqual([
    { pinned: true, source: "ACCESS", body: "Gate code 1234" },
    { pinned: true, source: "RISK", body: "Dog" },
    { ...note, pinned: false },
  ]);
});

it("getNotes skips blank or missing access/risk notes", async () => {
  const prisma = makePrisma();
  (prisma.property.findUnique as Fn).mockResolvedValue({ accessNotes: "  ", riskNotes: null });
  (prisma.propertyNote.findMany as Fn).mockResolvedValue([]);
  expect(await createCustomerService(prisma).getNotes("p1")).toEqual([]);
});

// ── GAP-010: search ─────────────────────────────────────────────────────────

it("searchCustomers returns [] for a blank query without touching the DB", async () => {
  const prisma = makePrisma();
  expect(await createCustomerService(prisma).searchCustomers("   ")).toEqual([]);
  expect(prisma.customer.findMany).not.toHaveBeenCalled();
});

it("searchCustomers matches phone digits via raw SQL and maps picker rows", async () => {
  const prisma = makePrisma();
  (prisma.$queryRaw as unknown as Fn).mockResolvedValue([{ id: "c9" }]);
  (prisma.customer.findMany as Fn).mockResolvedValue([
    { id: "c9", name: "Coates", phone: "+44 7700 900111", email: null, properties: [{ postcode: "NE66 1TD" }, { postcode: "NE66 2AA" }] },
    { id: "c2", name: "No Props", phone: null, email: "a@b.c", properties: [] },
  ]);

  const result = await createCustomerService(prisma).searchCustomers(" 07700 900 ");

  expect(prisma.$queryRaw).toHaveBeenCalled();
  const args = (prisma.customer.findMany as Fn).mock.calls[0][0];
  expect(args.take).toBe(10);
  expect(args.where.status).toEqual({ not: LifecycleStatus.CANCELLED });
  expect(args.where.OR).toContainEqual({ id: { in: ["c9"] } });
  expect(args.where.OR[0]).toEqual({ name: { contains: "07700 900", mode: "insensitive" } });
  expect(result).toEqual([
    { id: "c9", name: "Coates", phone: "+44 7700 900111", email: null, propertyCount: 2, postcode: "NE66 1TD" },
    { id: "c2", name: "No Props", phone: null, email: "a@b.c", propertyCount: 0, postcode: null },
  ]);
});

it("searchCustomers skips the phone query for short/no-digit terms and when it finds nothing", async () => {
  const prisma = makePrisma();
  (prisma.customer.findMany as Fn).mockResolvedValue([]);
  await createCustomerService(prisma).searchCustomers("coates");
  expect(prisma.$queryRaw).not.toHaveBeenCalled();
  expect((prisma.customer.findMany as Fn).mock.calls[0][0].where.OR).toHaveLength(3);

  (prisma.$queryRaw as unknown as Fn).mockResolvedValue([]);
  await createCustomerService(prisma).searchCustomers("12345");
  expect((prisma.customer.findMany as Fn).mock.calls[1][0].where.OR).toHaveLength(3);
});

// ── visit history ───────────────────────────────────────────────────────────

it("getVisitHistory 404s for an unknown customer", async () => {
  const prisma = makePrisma();
  (prisma.customer.findUnique as Fn).mockResolvedValue(null);
  await expect(createCustomerService(prisma).getVisitHistory("x", 1, 50)).rejects.toMatchObject({ statusCode: 404 });
});

it("getVisitHistory pages every status, including CANCELLED with its reason", async () => {
  const prisma = makePrisma();
  (prisma.customer.findUnique as Fn).mockResolvedValue({ id: "c1" });
  (prisma.visit.count as Fn).mockResolvedValue(3);
  (prisma.visit.findMany as Fn).mockResolvedValue([
    { id: "v1", date: new Date("2026-11-01"), status: VisitStatus.CANCELLED, cancelReason: "PAUSED", notes: null, round: { name: "Fri" }, payment: null },
    { id: "v2", date: new Date("2026-10-01"), status: VisitStatus.COMPLETED, cancelReason: null, notes: "ok", round: null, payment: { status: PaymentStatus.PAID } },
  ]);

  const result = await createCustomerService(prisma).getVisitHistory("c1", 2, 2);

  expect(result.pagination).toEqual({ page: 2, pageSize: 2, total: 3, totalPages: 2 });
  expect(result.rows[0]).toEqual({
    visitId: "v1", date: new Date("2026-11-01"), roundName: "Fri", status: VisitStatus.CANCELLED,
    cancelReason: "PAUSED", paymentStatus: null, notes: null,
  });
  expect(result.rows[1].paymentStatus).toBe(PaymentStatus.PAID);
  const args = (prisma.visit.findMany as Fn).mock.calls[0][0];
  expect(args.skip).toBe(2);
  expect(args.where).toEqual({ property: { customerId: "c1" } });
});

// ── detail: GAP-021/022 fields, CANCELLED handling ─────────────────────────

it("getCustomerDetail returns badDebt, invoice-based amountDue, ON_HOLD, nextDue fallback and cancelled visits in history only", async () => {
  const prisma = makePrisma();
  const customer = makeCustomerWithVisitsAndPayments({ visitCount: 0, payments: [] });
  (customer as any).badDebt = true;
  (customer as any).holdNextClean = true;
  customer.invoices = [{ status: "SENT", dueDate: new Date("2020-01-01"), amount: 25 }];
  customer.properties[0].visits = [
    { ...makeVisit({ id: "v-next", date: new Date("2026-12-04"), status: VisitStatus.SCHEDULED }), cancelReason: null },
    { ...makeVisit({ id: "v-cancel", date: new Date("2026-11-20"), status: VisitStatus.CANCELLED }), cancelReason: "PAUSED" },
  ] as any;
  (prisma.customer.findUnique as Fn).mockResolvedValue(customer);
  (prisma.businessSettings.findFirst as Fn).mockResolvedValue(makeSettings());

  const result = await createCustomerService(prisma).getCustomerDetail("c1", UserRole.ADMIN);

  expect(result.customer.badDebt).toBe(true);
  expect(result.standingInfo.paymentStatus).toBe("ON_HOLD");
  expect(result.standingInfo.amountDue).toBe(25);
  expect(result.standingInfo.outstandingBalance).toBe(25);
  expect(result.standingInfo.nextDue).toEqual(new Date("2026-12-04"));
  expect(result.tabs.visitHistory.map((v) => [v.visitId, v.cancelReason])).toEqual([
    ["v-next", null],
    ["v-cancel", "PAUSED"],
  ]);
  expect(result.tabs.payments?.rows.map((r) => r.visitId)).toEqual(["v-next"]);
});

it("getCustomerDetail reports OVERDUE from a past-due SENT invoice and hides amountDue for technicians", async () => {
  const prisma = makePrisma();
  const customer = makeCustomerWithVisitsAndPayments({ visitCount: 0, payments: [] });
  customer.invoices = [{ status: "SENT", dueDate: new Date("2020-01-01"), amount: 25 }];
  (prisma.customer.findUnique as Fn).mockResolvedValue(customer);
  (prisma.businessSettings.findFirst as Fn).mockResolvedValue(makeSettings());

  const admin = await createCustomerService(prisma).getCustomerDetail("c1", UserRole.ADMIN);
  expect(admin.standingInfo.paymentStatus).toBe("OVERDUE");
  expect(admin.standingInfo.nextDue).toBeNull();

  const tech = await createCustomerService(prisma).getCustomerDetail("c1", UserRole.TECHNICIAN);
  expect(tech.standingInfo.amountDue).toBeUndefined();
});

// ── A2: nextDueDate on POST /customers/:id/properties ───────────────────────

function addPropertySetup(round: unknown) {
  const prisma = makePrisma();
  (prisma.customer.findUnique as Fn).mockResolvedValue({ id: "c1", status: LifecycleStatus.ACTIVE });
  (prisma.round.findUnique as Fn).mockResolvedValue(round);
  (prisma.serviceArea.findUnique as Fn).mockResolvedValue({ id: "sa1" });
  (prisma.property.update as Fn).mockResolvedValue({});
  vi.mocked(geocodePostcode).mockResolvedValue(null);
  const tx = {
    property: { create: vi.fn().mockResolvedValue({ id: "p1" }) },
    servicePlan: { create: vi.fn().mockResolvedValue({ id: "sp1" }) },
  };
  txReturning(prisma, tx);
  return { prisma, tx };
}

const baseAdd = { addressLine: "1 St", postcode: "NE66 1TD", serviceAreaId: "sa1", price: 20 };

it("addPropertyToCustomer keeps an explicit nextDueDate", async () => {
  const { prisma, tx } = addPropertySetup({ id: "r1", frequency: "FOUR_WEEKLY", defaultDay: "FRI" });
  const due = new Date("2026-12-01");
  await createCustomerService(prisma).addPropertyToCustomer("c1", { ...baseAdd, roundId: "r1", nextDueDate: due });
  expect(tx.servicePlan.create.mock.calls[0][0].data.nextDueDate).toBe(due);
});

it("addPropertyToCustomer derives nextDueDate from lastCleanedDate + frequency, snapped to the round day", async () => {
  const { prisma, tx } = addPropertySetup({ id: "r1", frequency: "FOUR_WEEKLY", defaultDay: "FRI" });
  const lastCleanedDate = new Date();
  await createCustomerService(prisma).addPropertyToCustomer("c1", { ...baseAdd, roundId: "r1", lastCleanedDate });
  const data = tx.servicePlan.create.mock.calls[0][0].data;
  expect(data.cleaningFrequency).toBe("FOUR_WEEKLY");
  expect((data.nextDueDate as Date).getUTCDay()).toBe(5);
  expect((data.nextDueDate as Date).getTime()).toBeGreaterThan(Date.now() + 20 * 86_400_000);
});

it("addPropertyToCustomer ignores lastCleanedDate when the round has no frequency, and sets null with no round", async () => {
  const { prisma, tx } = addPropertySetup({ id: "r1", frequency: null, defaultDay: "MON" });
  await createCustomerService(prisma).addPropertyToCustomer("c1", { ...baseAdd, roundId: "r1", lastCleanedDate: new Date("2020-01-01") });
  const due = tx.servicePlan.create.mock.calls[0][0].data.nextDueDate as Date;
  expect(due.getUTCDay()).toBe(1);
  expect(due.getTime()).toBeLessThan(Date.now() + 8 * 86_400_000);

  const second = addPropertySetup(null);
  await createCustomerService(second.prisma).addPropertyToCustomer("c1", baseAdd);
  expect(second.tx.servicePlan.create.mock.calls[0][0].data.nextDueDate).toBeNull();
});
