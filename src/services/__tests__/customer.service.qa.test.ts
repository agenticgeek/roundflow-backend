import { it, expect, vi, beforeEach } from "vitest";
import { UserRole } from "@prisma/client";
import { createCustomerService } from "../customer.service";

// Notification producers are covered by notify.test.ts and the notification-producers tests.
vi.mock("../notify", async () => (await import("../../test/notify-mock.js")).notifyMockModule());

vi.mock("../../integrations/geocoding/client", async (orig) => ({
  ...(await orig<typeof import("../../integrations/geocoding/client")>()),
  geocodeAddress: vi.fn().mockResolvedValue({ result: null, error: "x" }),
}));

// QA batch 2026-11-03: A7/BUG-05 defaults, B3 visits follow a round move, B4 area
// mismatch, C5 service checks, E2E-028 paused status, delete consistency, pause defects.

function makePrisma(over: Record<string, any> = {}) {
  const prisma: any = {
    businessSettings: { findFirst: vi.fn().mockResolvedValue({ defaultPaymentMethod: "STRIPE" }) },
    customer: {
      findUnique: vi.fn(), findMany: vi.fn().mockResolvedValue([]), count: vi.fn().mockResolvedValue(0),
      create: vi.fn().mockResolvedValue({ id: "c1" }), update: vi.fn().mockResolvedValue({}),
    },
    property: {
      findUnique: vi.fn(), create: vi.fn().mockResolvedValue({ id: "p1" }), update: vi.fn().mockImplementation(({ data }: any) => Promise.resolve({ id: "p1", postcode: "X1", ...data })),
      findMany: vi.fn().mockResolvedValue([]), count: vi.fn().mockResolvedValue(0),
    },
    servicePlan: {
      create: vi.fn().mockResolvedValue({ id: "sp1" }), update: vi.fn().mockResolvedValue({}), updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      findMany: vi.fn().mockResolvedValue([]), findUnique: vi.fn(),
    },
    round: { findUnique: vi.fn().mockResolvedValue(null) },
    serviceArea: { findUnique: vi.fn().mockResolvedValue({ id: "sa1" }) },
    service: { findUnique: vi.fn().mockResolvedValue({ id: "svc1", active: true }) },
    visit: { findMany: vi.fn().mockResolvedValue([]), updateMany: vi.fn().mockResolvedValue({ count: 2 }) },
    invoice: { aggregate: vi.fn().mockResolvedValue({ _count: { _all: 0 }, _sum: { amount: 0 } }) },
    $transaction: vi.fn((cb: any) => (typeof cb === "function" ? cb(prisma) : Promise.all(cb))),
    ...over,
  };
  return prisma;
}

beforeEach(() => vi.clearAllMocks());

const addInput = (extra: Record<string, unknown> = {}) => ({
  addressLine: "1 High St", postcode: "X1 1AA", serviceAreaId: "sa1", price: 20, ...extra,
});

// ---- A7 / BUG-05 -----------------------------------------------------------

it("A7: createCustomer and addPropertyToCustomer fall back to the default payment method", async () => {
  const prisma = makePrisma();
  await createCustomerService(prisma).createCustomer({ name: "Jo" });
  expect(prisma.customer.create.mock.calls[0][0].data.paymentMethod).toBe("STRIPE");
  await createCustomerService(prisma).createCustomer({ name: "Jo", paymentMethod: "CASH" });
  expect(prisma.customer.create.mock.calls[1][0].data.paymentMethod).toBe("CASH");

  prisma.customer.findUnique.mockResolvedValue({ id: "c1", status: "ACTIVE", paymentMethod: null });
  await createCustomerService(prisma).addPropertyToCustomer("c1", addInput() as never);
  expect(prisma.servicePlan.create.mock.calls[0][0].data.paymentMethod).toBe("STRIPE");

  // the customer's own method beats the business default
  prisma.customer.findUnique.mockResolvedValue({ id: "c1", status: "ACTIVE", paymentMethod: "BACS" });
  await createCustomerService(prisma).addPropertyToCustomer("c1", addInput() as never);
  expect(prisma.servicePlan.create.mock.calls[1][0].data.paymentMethod).toBe("BACS");
});

it("add-property: 404 unknown customer, 409 cancelled customer, 404 unknown area / round", async () => {
  const prisma = makePrisma();
  const svc = createCustomerService(prisma);
  prisma.customer.findUnique.mockResolvedValue(null);
  await expect(svc.addPropertyToCustomer("c1", addInput() as never)).rejects.toMatchObject({ statusCode: 404 });
  prisma.customer.findUnique.mockResolvedValue({ id: "c1", status: "CANCELLED" });
  await expect(svc.addPropertyToCustomer("c1", addInput() as never)).rejects.toMatchObject({ statusCode: 409 });
  prisma.customer.findUnique.mockResolvedValue({ id: "c1", status: "ACTIVE" });
  prisma.serviceArea.findUnique.mockResolvedValue(null);
  await expect(svc.addPropertyToCustomer("c1", addInput() as never)).rejects.toMatchObject({ statusCode: 404 });
  prisma.serviceArea.findUnique.mockResolvedValue({ id: "sa1" });
  await expect(svc.addPropertyToCustomer("c1", addInput({ roundId: "ghost" }) as never)).rejects.toMatchObject({ statusCode: 404 });
});

// ---- B4 / C5 ---------------------------------------------------------------

it("B4: createProperty and addPropertyToCustomer reject a round from another service area", async () => {
  const prisma = makePrisma();
  prisma.round.findUnique.mockResolvedValue({ id: "r1", serviceAreaId: "other", frequency: null, defaultDay: null });
  prisma.customer.findUnique.mockResolvedValue({ id: "c1", status: "ACTIVE" });
  const svc = createCustomerService(prisma);
  await expect(svc.createProperty({ customerName: "Jo", ...addInput({ roundId: "r1" }) } as never)).rejects.toMatchObject({ statusCode: 400, code: "ROUND_SERVICE_AREA_MISMATCH" });
  await expect(svc.addPropertyToCustomer("c1", addInput({ roundId: "r1" }) as never)).rejects.toMatchObject({ code: "ROUND_SERVICE_AREA_MISMATCH" });
  expect(prisma.property.create).not.toHaveBeenCalled();
  // same area is fine; a round with no area is fine
  prisma.round.findUnique.mockResolvedValue({ id: "r1", serviceAreaId: "sa1", frequency: "FOUR_WEEKLY", defaultDay: "MON" });
  await svc.createProperty({ customerName: "Jo", ...addInput({ roundId: "r1" }) } as never);
  prisma.round.findUnique.mockResolvedValue({ id: "r1", serviceAreaId: null, frequency: null, defaultDay: null });
  await svc.createProperty({ customerName: "Jo", ...addInput({ roundId: "r1" }) } as never);
  expect(prisma.property.create).toHaveBeenCalledTimes(2);
});

it("C5: unknown and inactive services are rejected on property creation", async () => {
  const prisma = makePrisma();
  const svc = createCustomerService(prisma);
  prisma.service.findUnique.mockResolvedValue(null);
  await expect(svc.createProperty({ customerName: "Jo", ...addInput({ serviceId: "ghost" }) } as never)).rejects.toMatchObject({ statusCode: 404 });
  prisma.service.findUnique.mockResolvedValue({ id: "svc1", active: false });
  await expect(svc.createProperty({ customerName: "Jo", ...addInput({ serviceId: "svc1" }) } as never)).rejects.toMatchObject({ statusCode: 400, code: "SERVICE_INACTIVE" });
  expect(prisma.customer.create).not.toHaveBeenCalled();
});

// ---- updateProperty: B3 + B4 -----------------------------------------------

function propertyFixture(extra: Record<string, unknown> = {}) {
  return { id: "p1", roundId: "rOld", serviceAreaId: "sa1", postcode: "X1", servicePlans: [{ id: "sp1", status: "ACTIVE" }], ...extra };
}

it("B3: changing a property's round moves its future SCHEDULED visits, unassigns them and recomputes nextDueDate", async () => {
  const prisma = makePrisma();
  prisma.property.findUnique.mockResolvedValue(propertyFixture());
  prisma.round.findUnique.mockResolvedValue({ id: "rNew", serviceAreaId: "sa1", frequency: "FOUR_WEEKLY", defaultDay: "TUE" });
  prisma.servicePlan.findMany.mockResolvedValue([{ id: "sp1", lastCompleted: null, cleaningFrequency: "FOUR_WEEKLY" }]);
  const out = await createCustomerService(prisma).updateProperty("p1", { roundId: "rNew" });
  const move = prisma.visit.updateMany.mock.calls[0][0];
  expect(move.where).toMatchObject({ propertyId: "p1", status: "SCHEDULED", OR: [{ roundId: null }, { roundId: { not: "rNew" } }] });
  expect(move.data).toEqual({ roundId: "rNew", technicianId: null, technicianOverride: false });
  expect(prisma.servicePlan.update.mock.calls.at(-1)[0].data.nextDueDate).toBeInstanceOf(Date);
  expect(prisma.property.update.mock.calls[0][0].data).toMatchObject({ roundId: "rNew", assignedTechnicianId: null });
  expect(out.roundId).toBe("rNew");
});

it("B3: a plan without a frequency of its own uses the round's; with neither it is skipped; same round is a no-op", async () => {
  const prisma = makePrisma();
  prisma.property.findUnique.mockResolvedValue(propertyFixture());
  prisma.round.findUnique.mockResolvedValue({ id: "rNew", serviceAreaId: "sa1", frequency: null, defaultDay: null });
  prisma.servicePlan.findMany.mockResolvedValue([{ id: "sp1", lastCompleted: null, cleaningFrequency: null }]);
  await createCustomerService(prisma).updateProperty("p1", { roundId: "rNew" });
  expect(prisma.servicePlan.update).not.toHaveBeenCalled();

  const same = makePrisma();
  same.property.findUnique.mockResolvedValue(propertyFixture({ roundId: "rNew" }));
  same.round.findUnique.mockResolvedValue({ id: "rNew", serviceAreaId: "sa1", frequency: "FOUR_WEEKLY", defaultDay: null });
  await createCustomerService(same).updateProperty("p1", { roundId: "rNew" });
  expect(same.visit.updateMany).not.toHaveBeenCalled();

  const unassign = makePrisma();
  unassign.property.findUnique.mockResolvedValue(propertyFixture());
  await createCustomerService(unassign).updateProperty("p1", { roundId: null });
  expect(unassign.visit.updateMany).not.toHaveBeenCalled();
});

it("B4: updateProperty rejects a round from another area, or an area change that orphans the current round", async () => {
  const prisma = makePrisma();
  prisma.property.findUnique.mockResolvedValue(propertyFixture());
  prisma.round.findUnique.mockResolvedValue({ id: "rNew", serviceAreaId: "other", frequency: null, defaultDay: null });
  const svc = createCustomerService(prisma);
  await expect(svc.updateProperty("p1", { roundId: "rNew" })).rejects.toMatchObject({ code: "ROUND_SERVICE_AREA_MISMATCH" });
  // area changes while the current round stays: the current round must still fit
  prisma.round.findUnique.mockResolvedValue({ id: "rOld", serviceAreaId: "sa1", frequency: null, defaultDay: null });
  await expect(svc.updateProperty("p1", { serviceAreaId: "sa2" })).rejects.toMatchObject({ code: "ROUND_SERVICE_AREA_MISMATCH" });
  await svc.updateProperty("p1", { serviceAreaId: "sa1" });
  // the current round vanished: nothing to compare
  prisma.round.findUnique.mockResolvedValue(null);
  await svc.updateProperty("p1", { serviceAreaId: "sa2" });
  expect(prisma.property.update).toHaveBeenCalledTimes(2);
});

// ---- updateCustomer: B3 + B4 -----------------------------------------------

function customerFixture(extra: Record<string, unknown> = {}) {
  return {
    id: "c1",
    properties: [{ id: "p1", status: "ACTIVE", postcode: "X1", roundId: "rOld", serviceAreaId: "sa1", servicePlans: [{ id: "sp1", status: "ACTIVE" }] }],
    ...extra,
  };
}

it("B3/B4: updateCustomer moves visits on a real round change and rejects a mismatched area", async () => {
  const prisma = makePrisma();
  prisma.customer.findUnique.mockResolvedValue(customerFixture());
  prisma.round.findUnique.mockResolvedValue({ id: "rNew", serviceAreaId: "sa1", frequency: "SIX_WEEKLY", defaultDay: "WED" });
  prisma.servicePlan.findMany.mockResolvedValue([{ id: "sp1", lastCompleted: null, cleaningFrequency: "SIX_WEEKLY" }]);
  await createCustomerService(prisma).updateCustomer("c1", { roundId: "rNew" });
  expect(prisma.visit.updateMany.mock.calls[0][0].data).toEqual({ roundId: "rNew", technicianId: null, technicianOverride: false });
  expect(prisma.property.update.mock.calls[0][0].data.assignedTechnician).toEqual({ disconnect: true });

  prisma.round.findUnique.mockResolvedValue({ id: "rNew", serviceAreaId: "other", frequency: null, defaultDay: null });
  await expect(createCustomerService(prisma).updateCustomer("c1", { roundId: "rNew" })).rejects.toMatchObject({ code: "ROUND_SERVICE_AREA_MISMATCH" });

  // customer without a property: no move, no crash
  const bare = makePrisma();
  bare.customer.findUnique.mockResolvedValue({ id: "c1", properties: [] });
  bare.round.findUnique.mockResolvedValue({ id: "rNew", serviceAreaId: "sa1", frequency: null, defaultDay: null });
  await createCustomerService(bare).updateCustomer("c1", { roundId: "rNew" });
  expect(bare.visit.updateMany).not.toHaveBeenCalled();
});

// ---- list status + delete consistency ---------------------------------------

it("E2E-028: a customer whose only plan is paused is listed as PAUSED; unpaused stays ACTIVE", async () => {
  const mk = (planStatus: string) => ({
    id: "c1", name: "Jo", status: "ACTIVE", holdNextClean: false, badDebt: false, payments: [], invoices: [],
    properties: [{ id: "p1", status: "ACTIVE", addressLine: "1", postcode: "X", roundId: null, round: null, visits: [], servicePlans: [{ id: "sp1", status: planStatus, price: 20 }] }],
  });
  const prisma = makePrisma();
  prisma.customer.findMany.mockResolvedValue([mk("PAUSED")]);
  const res = await createCustomerService(prisma).getCustomers({}, UserRole.ADMIN);
  expect(res.customers[0].status).toBe("PAUSED");
  prisma.customer.findMany.mockResolvedValue([mk("ACTIVE")]);
  expect((await createCustomerService(prisma).getCustomers({}, UserRole.ADMIN)).customers[0].status).toBe("ACTIVE");
  const where = prisma.customer.findMany.mock.calls[0][0].where;
  expect(where.status).toEqual({ not: "CANCELLED" });
  // summary total excludes deleted customers
  expect(prisma.customer.count.mock.calls[0][0]).toEqual({ where: { status: { not: "CANCELLED" } } });

  const active = makePrisma();
  await createCustomerService(active).getCustomers({ status: "ACTIVE", roundId: "r1" }, UserRole.ADMIN);
  const w = active.customer.findMany.mock.calls[0][0].where;
  expect(w.status).toBe("ACTIVE");
  expect(w.properties).toEqual({ some: { roundId: "r1" } });
  expect(w.AND[0].NOT.properties.some.servicePlans.some.status).toBe("PAUSED");
});

it("DELETE property cancels the customer when it was their last live property, otherwise only the property", async () => {
  const prisma = makePrisma();
  prisma.property.findUnique.mockResolvedValue({ id: "p1" });
  prisma.property.update.mockResolvedValue({ customerId: "c1" });
  prisma.property.count.mockResolvedValue(0);
  await createCustomerService(prisma).deleteProperty("p1");
  expect(prisma.customer.update).toHaveBeenCalledWith({ where: { id: "c1" }, data: { status: "CANCELLED" } });

  const other = makePrisma();
  other.property.findUnique.mockResolvedValue({ id: "p1" });
  other.property.update.mockResolvedValue({ customerId: "c1" });
  other.property.count.mockResolvedValue(1);
  await createCustomerService(other).deleteProperty("p1");
  expect(other.customer.update).not.toHaveBeenCalled();
});

// ---- pause / resume ----------------------------------------------------------

const pausePlanRow = (extra: Record<string, unknown> = {}) => ({ id: "sp1", propertyId: "p1", status: "ACTIVE", pauseStartDate: null, ...extra });

it("pause: 404 unknown plan, 409 cancelled or already paused, with clear messages", async () => {
  const prisma = makePrisma();
  const svc = createCustomerService(prisma);
  prisma.servicePlan.findUnique.mockResolvedValue(null);
  await expect(svc.pauseServicePlan("x", { pauseStartDate: new Date() })).rejects.toMatchObject({ statusCode: 404, message: "Service plan not found" });
  prisma.servicePlan.findUnique.mockResolvedValue(pausePlanRow({ status: "CANCELLED" }));
  await expect(svc.pauseServicePlan("sp1", { pauseStartDate: new Date() })).rejects.toMatchObject({ statusCode: 409, message: expect.stringContaining("cancelled") });
  prisma.servicePlan.findUnique.mockResolvedValue(pausePlanRow({ status: "PAUSED" }));
  await expect(svc.pauseServicePlan("sp1", { pauseStartDate: new Date() })).rejects.toMatchObject({ statusCode: 409, message: "Service plan is already paused" });
});

it("pause on a held customer's visit and an unassigned property still pauses and resumes", async () => {
  const prisma = makePrisma();
  const svc = createCustomerService(prisma);
  prisma.servicePlan.findUnique.mockResolvedValue(pausePlanRow());
  prisma.servicePlan.update.mockImplementation(({ data }: any) => Promise.resolve({ id: "sp1", ...data }));
  const start = new Date();
  const paused = await svc.pauseServicePlan("sp1", { pauseStartDate: start });
  expect(paused).toMatchObject({ status: "PAUSED", cancelledVisits: 2, pauseScheduled: false });
  // only SCHEDULED visits (held ones included) are cancelled, never started/completed ones
  expect(prisma.visit.updateMany.mock.calls[0][0].where.status).toBe("SCHEDULED");

  // resume on a property with no round (unassigned): snaps to a weekday, no crash
  prisma.servicePlan.findUnique.mockResolvedValue(pausePlanRow({ status: "PAUSED" }));
  prisma.property.findUnique.mockResolvedValue({ round: null });
  const resumed = await svc.resumeServicePlan("sp1");
  expect(resumed.status).toBe("ACTIVE");
});

it("future-dated pause keeps the plan ACTIVE and can be cancelled with resume", async () => {
  const prisma = makePrisma();
  const svc = createCustomerService(prisma);
  prisma.servicePlan.findUnique.mockResolvedValue(pausePlanRow());
  prisma.servicePlan.update.mockImplementation(({ data }: any) => Promise.resolve({ id: "sp1", ...data }));
  const future = new Date(Date.now() + 10 * 86_400_000);
  const res = await svc.pauseServicePlan("sp1", { pauseStartDate: future, pauseEndDate: new Date(future.getTime() + 7 * 86_400_000) });
  expect(res.pauseScheduled).toBe(true);
  expect(res.status).toBeUndefined();
  expect(prisma.servicePlan.update.mock.calls[0][0].data.pauseStartDate.getUTCHours()).toBe(0);

  prisma.servicePlan.findUnique.mockResolvedValue(pausePlanRow({ pauseStartDate: future }));
  prisma.property.findUnique.mockResolvedValue({ round: { defaultDay: "MON" } });
  await expect(svc.resumeServicePlan("sp1")).resolves.toMatchObject({ status: "ACTIVE", pauseStartDate: null });
  prisma.servicePlan.findUnique.mockResolvedValue(pausePlanRow());
  await expect(svc.resumeServicePlan("sp1")).rejects.toMatchObject({ statusCode: 409, message: "Service plan is not paused" });
});

it("pauseService on a property uses its primary plan and 404s with no plan", async () => {
  const prisma = makePrisma();
  const svc = createCustomerService(prisma);
  prisma.property.findUnique.mockResolvedValue({ id: "p1", servicePlans: [] });
  await expect(svc.pauseService("p1", { pauseStartDate: new Date() })).rejects.toMatchObject({ statusCode: 404 });
  prisma.property.findUnique.mockResolvedValue({ id: "p1", servicePlans: [pausePlanRow({ status: "CANCELLED" })] });
  await expect(svc.pauseService("p1", { pauseStartDate: new Date() })).rejects.toMatchObject({ statusCode: 409 });
});

// ---- B5: unpaid invoices block deletion -------------------------------------

it("deleting an unknown customer is a 404 and nothing is checked or written", async () => {
  const prisma = makePrisma();
  prisma.customer.findUnique.mockResolvedValue(null);
  await expect(createCustomerService(prisma).deleteCustomer("nope")).rejects.toMatchObject({ statusCode: 404 });
  expect(prisma.invoice.aggregate).not.toHaveBeenCalled();
  expect(prisma.$transaction).not.toHaveBeenCalled();
});

it("B5: deleting a customer with unpaid (SENT) invoices is a 409 UNPAID_INVOICES with count and total; nothing is written", async () => {
  const prisma = makePrisma();
  prisma.customer.findUnique.mockResolvedValue({ id: "c1" });
  prisma.invoice.aggregate.mockResolvedValue({ _count: { _all: 2 }, _sum: { amount: 85.5 } });
  await expect(createCustomerService(prisma).deleteCustomer("c1")).rejects.toMatchObject({
    statusCode: 409, code: "UNPAID_INVOICES", count: 2, total: 85.5,
  });
  expect(prisma.invoice.aggregate.mock.calls[0][0].where).toEqual({ customerId: "c1", status: "SENT" });
  expect(prisma.$transaction).not.toHaveBeenCalled();
});

it("B5: deleting a property whose visits have unpaid invoices is a 409; paid/void/draft do not block", async () => {
  const prisma = makePrisma();
  prisma.property.findUnique.mockResolvedValue({ id: "p1" });
  prisma.invoice.aggregate.mockResolvedValue({ _count: { _all: 1 }, _sum: { amount: null } });
  await expect(createCustomerService(prisma).deleteProperty("p1")).rejects.toMatchObject({
    statusCode: 409, code: "UNPAID_INVOICES", count: 1, total: 0,
  });
  expect(prisma.invoice.aggregate.mock.calls[0][0].where).toEqual({ status: "SENT", visit: { propertyId: "p1" } });

  const ok = makePrisma();
  ok.property.findUnique.mockResolvedValue({ id: "p1" });
  ok.property.update.mockResolvedValue({ customerId: "c1" });
  ok.property.count.mockResolvedValue(1);
  await createCustomerService(ok).deleteProperty("p1");
  expect(ok.property.update).toHaveBeenCalled();
});
