import { it, expect, vi } from "vitest";
import { createVisitService } from "../visit.service";

function makePrisma() {
  return {
    visit: { create: vi.fn() },
    property: { findUnique: vi.fn() },
    service: { findUnique: vi.fn() },
    technician: { findUnique: vi.fn() },
    round: { findUnique: vi.fn() },
  } as unknown as Parameters<typeof createVisitService>[0];
}

it("createVisitService returns an object", () => {
  expect(createVisitService(makePrisma())).toBeDefined();
});

it("createVisit sets isOneOff: true and status: SCHEDULED", async () => {
  const prisma = makePrisma();
  (prisma.property.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
    id: "p1", addressLine: "1 High St", postcode: "NE1 1AA",
    customer: { id: "c1", name: "Jane Doe" },
  });
  (prisma.visit.create as ReturnType<typeof vi.fn>).mockResolvedValue({
    id: "v1", date: new Date("2026-09-03T00:00:00.000Z"),
    status: "SCHEDULED", isOneOff: true, price: { toNumber: () => 45 },
    notes: null, paymentMethod: null, propertyId: "p1",
    property: { addressLine: "1 High St", postcode: "NE1 1AA", customer: { id: "c1", name: "Jane Doe" } },
    round: null, service: null, technician: null,
  });

  await createVisitService(prisma).createVisit("user-1", {
    propertyId: "p1", date: "2026-09-03", price: 45,
  });

  const createArgs = (prisma.visit.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
  expect(createArgs.data.isOneOff).toBe(true);
  expect(createArgs.data.status).toBe("SCHEDULED");
});

it("createVisit sets servicePlanId: null on the created row", async () => {
  const prisma = makePrisma();
  (prisma.property.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
    id: "p1", addressLine: "1 High St", postcode: "NE1 1AA",
    customer: { id: "c1", name: "Jane Doe" },
  });
  (prisma.visit.create as ReturnType<typeof vi.fn>).mockResolvedValue({
    id: "v1", date: new Date("2026-09-03T00:00:00.000Z"),
    status: "SCHEDULED", isOneOff: true, price: { toNumber: () => 45 },
    notes: null, paymentMethod: null, propertyId: "p1",
    property: { addressLine: "1 High St", postcode: "NE1 1AA", customer: { id: "c1", name: "Jane Doe" } },
    round: null, service: null, technician: null,
  });

  await createVisitService(prisma).createVisit("user-1", {
    propertyId: "p1", date: "2026-09-03", price: 45,
  });

  const createArgs = (prisma.visit.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
  expect(createArgs.data.servicePlanId).toBeNull();
});

it("createVisit throws 404 when propertyId does not exist", async () => {
  const prisma = makePrisma();
  (prisma.property.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);

  await expect(
    createVisitService(prisma).createVisit("user-1", {
      propertyId: "bad", date: "2026-09-03", price: 45,
    })
  ).rejects.toMatchObject({ statusCode: 404 });
});

it("createVisit throws 404 when technicianId does not exist", async () => {
  const prisma = makePrisma();
  (prisma.property.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
    id: "p1", addressLine: "1 High St", postcode: "NE1 1AA",
    customer: { id: "c1", name: "Jane Doe" },
  });
  (prisma.technician.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);

  await expect(
    createVisitService(prisma).createVisit("user-1", {
      propertyId: "p1", date: "2026-09-03", price: 45, technicianId: "bad",
    })
  ).rejects.toMatchObject({ statusCode: 404 });
});

it("createVisit throws 404 when serviceId does not exist", async () => {
  const prisma = makePrisma();
  (prisma.property.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
    id: "p1", addressLine: "1 High St", postcode: "NE1 1AA",
    customer: { id: "c1", name: "Jane Doe" },
  });
  (prisma.service.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);

  await expect(
    createVisitService(prisma).createVisit("user-1", {
      propertyId: "p1", date: "2026-09-03", price: 45, serviceId: "bad",
    })
  ).rejects.toMatchObject({ statusCode: 404 });
});

it("createVisit throws 404 when roundId does not exist", async () => {
  const prisma = makePrisma();
  (prisma.property.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
    id: "p1", addressLine: "1 High St", postcode: "NE1 1AA",
    customer: { id: "c1", name: "Jane Doe" },
  });
  (prisma.round.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);

  await expect(
    createVisitService(prisma).createVisit("user-1", {
      propertyId: "p1", date: "2026-09-03", price: 45, roundId: "bad",
    })
  ).rejects.toMatchObject({ statusCode: 404 });
});

it("createVisit throws 400 for price: 0", async () => {
  await expect(
    createVisitService(makePrisma()).createVisit("user-1", {
      propertyId: "p1", date: "2026-09-03", price: 0,
    })
  ).rejects.toMatchObject({ statusCode: 400 });
});

it("createVisit throws 400 for price: -5", async () => {
  await expect(
    createVisitService(makePrisma()).createVisit("user-1", {
      propertyId: "p1", date: "2026-09-03", price: -5,
    })
  ).rejects.toMatchObject({ statusCode: 400 });
});

it("createVisit throws 400 for date: '03-09-2026'", async () => {
  await expect(
    createVisitService(makePrisma()).createVisit("user-1", {
      propertyId: "p1", date: "03-09-2026", price: 45,
    })
  ).rejects.toMatchObject({ statusCode: 400 });
});

it("createVisit returns price as a number", async () => {
  const prisma = makePrisma();
  (prisma.property.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
    id: "p1", addressLine: "1 High St", postcode: "NE1 1AA",
    customer: { id: "c1", name: "Jane Doe" },
  });
  (prisma.visit.create as ReturnType<typeof vi.fn>).mockResolvedValue({
    id: "v1", date: new Date("2026-09-03T00:00:00.000Z"),
    status: "SCHEDULED", isOneOff: true, price: { toNumber: () => 45 },
    notes: null, paymentMethod: null, propertyId: "p1",
    property: { addressLine: "1 High St", postcode: "NE1 1AA", customer: { id: "c1", name: "Jane Doe" } },
    round: null, service: null, technician: null,
  });

  const result = await createVisitService(prisma).createVisit("user-1", {
    propertyId: "p1", date: "2026-09-03", price: 45,
  });

  expect(typeof result.price).toBe("number");
  expect(result.price).toBe(45);
});

it("createVisit throws 400 when technicianId has not accepted their invite", async () => {
  const prisma = makePrisma();
  (prisma.property.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
    id: "p1", addressLine: "1 High St", postcode: "NE1 1AA",
    customer: { id: "c1", name: "Jane Doe" },
  });
  // Technician exists but profileId is null — invite still pending
  (prisma.technician.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
    id: "t1", active: true, profileId: null,
  });

  await expect(
    createVisitService(prisma).createVisit("user-1", {
      propertyId: "p1", date: "2026-09-03", price: 45, technicianId: "t1",
    })
  ).rejects.toMatchObject({ statusCode: 400 });
});

it("createVisit creates row with roundId: null when roundId is omitted", async () => {
  const prisma = makePrisma();
  (prisma.property.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
    id: "p1", addressLine: "1 High St", postcode: "NE1 1AA",
    customer: { id: "c1", name: "Jane Doe" },
  });
  (prisma.visit.create as ReturnType<typeof vi.fn>).mockResolvedValue({
    id: "v1", date: new Date("2026-09-03T00:00:00.000Z"),
    status: "SCHEDULED", isOneOff: true, price: { toNumber: () => 45 },
    notes: null, paymentMethod: null, propertyId: "p1",
    property: { addressLine: "1 High St", postcode: "NE1 1AA", customer: { id: "c1", name: "Jane Doe" } },
    round: null, service: null, technician: null,
  });

  await createVisitService(prisma).createVisit("user-1", {
    propertyId: "p1", date: "2026-09-03", price: 45,
  });

  const createArgs = (prisma.visit.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
  expect(createArgs.data.roundId).toBeNull();
});
