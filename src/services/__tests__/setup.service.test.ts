import { it, expect, vi } from "vitest";
import { createSetupService } from "../setup.service";
import { RoundStatus, Prisma } from "../../generated/tenant-client";

function uniqueConstraintError() {
  return new Prisma.PrismaClientKnownRequestError("Unique constraint failed on the fields: (`email`)", {
    code: "P2002",
    clientVersion: "6.19.3",
  });
}

function makePrisma() {
  return {
    businessSettings: { findFirst: vi.fn(), findMany: vi.fn(), upsert: vi.fn() },
    service: { findMany: vi.fn(), deleteMany: vi.fn(), createMany: vi.fn(), count: vi.fn().mockResolvedValue(0) },
    messageTemplate: { findMany: vi.fn(), deleteMany: vi.fn(), createMany: vi.fn(), count: vi.fn().mockResolvedValue(0) },
    technician: { findMany: vi.fn(), deleteMany: vi.fn(), createMany: vi.fn(), count: vi.fn().mockResolvedValue(0) },
    technicianServiceArea: { createMany: vi.fn().mockResolvedValue({ count: 0 }) },
    serviceArea: { findMany: vi.fn(), findUnique: vi.fn(), deleteMany: vi.fn(), createMany: vi.fn(), count: vi.fn().mockResolvedValue(0) },
    round: {
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      count: vi.fn().mockResolvedValue(0),
    },
    roundTechnician: { deleteMany: vi.fn(), createMany: vi.fn() },
    // findMany defaults to echoing back a bare { id } record per id in a
    // `where: { id: { in: [...] } }` query — bulkAddSetupProperties refetches
    // createMany'd rows this way to build its response shape.
    customer: {
      findMany: vi.fn((args: any) => Promise.resolve((args?.where?.id?.in ?? []).map((id: string) => ({ id })))),
      create: vi.fn(),
      createMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    property: {
      findMany: vi.fn((args: any) => Promise.resolve((args?.where?.id?.in ?? []).map((id: string) => ({ id })))),
      create: vi.fn(),
      createMany: vi.fn().mockResolvedValue({ count: 0 }),
      count: vi.fn().mockResolvedValue(0),
    },
    servicePlan: {
      findMany: vi.fn((args: any) => Promise.resolve((args?.where?.id?.in ?? []).map((id: string) => ({ id })))),
      create: vi.fn(),
      createMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    visit: { findMany: vi.fn(), createMany: vi.fn(), count: vi.fn().mockResolvedValue(0) },
    bulkImportAttempt: { findUnique: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue({}) },
    // Supports both the interactive callback form ($transaction(cb)) used by
    // other steps and the array/batched form ($transaction([...])) used by
    // bulkAddSetupProperties.
    $transaction: vi.fn((arg: any) => (Array.isArray(arg) ? Promise.all(arg) : arg(makePrisma()))),
  } as unknown as Parameters<typeof createSetupService>[0];
}

function makeServiceArea(id: string) {
  return { id };
}

function makeRound(id: string, status: RoundStatus = RoundStatus.ACTIVE) {
  return { id, status, name: "Round A", frequency: "FOUR_WEEKLY", defaultDay: null };
}

function makeInput(overrides: Partial<{
  customerName: string; fullAddress: string; postcode: string;
  serviceAreaId: string; roundId: string; price: number;
}> = {}) {
  return {
    customerName: "Test Customer",
    fullAddress: "1 Test Lane",
    postcode: "T1 1TT",
    serviceAreaId: "area1",
    roundId: "round1",
    price: 35,
    ...overrides,
  };
}

// ── getSetupProperties ──────────────────────────────────────────────────────

it("getSetupProperties maps each property's servicePlans through and drops properties with no plan", async () => {
  const prisma = makePrisma();
  (prisma.property.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
    { id: "p1", customer: { id: "c1" }, servicePlans: [{ id: "sp1" }] },
    { id: "p2", customer: { id: "c2" }, servicePlans: [] },
  ]);

  const result = await createSetupService(prisma).getSetupProperties();

  expect(result).toHaveLength(1);
  expect(result[0]).toMatchObject({
    customer: { id: "c1" },
    servicePlan: { id: "sp1" },
    servicePlans: [{ id: "sp1" }],
  });
});

// ── addSetupProperty (single) ──────────────────────────────────────────────

it("addSetupProperty throws 400 for an invalid propertyType", async () => {
  const prisma = makePrisma();
  await expect(
    createSetupService(prisma).addSetupProperty({ ...makeInput(), propertyType: "IGLOO" })
  ).rejects.toMatchObject({ statusCode: 400 });
});

it("addSetupProperty throws 400 for an invalid cleaningFrequency", async () => {
  const prisma = makePrisma();
  await expect(
    createSetupService(prisma).addSetupProperty({ ...makeInput(), cleaningFrequency: "DAILY" })
  ).rejects.toMatchObject({ statusCode: 400 });
});

it("addSetupProperty throws 400 for an invalid paymentMethod", async () => {
  const prisma = makePrisma();
  await expect(
    createSetupService(prisma).addSetupProperty({ ...makeInput(), paymentMethod: "CRYPTO" })
  ).rejects.toMatchObject({ statusCode: 400 });
});

it("addSetupProperty throws 400 when serviceAreaId does not exist", async () => {
  const prisma = makePrisma();
  (prisma.serviceArea.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);
  await expect(
    createSetupService(prisma).addSetupProperty(makeInput())
  ).rejects.toMatchObject({ statusCode: 400 });
});

it("addSetupProperty throws 400 when roundId does not exist", async () => {
  const prisma = makePrisma();
  (prisma.serviceArea.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(makeServiceArea("area1"));
  (prisma.round.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);
  await expect(
    createSetupService(prisma).addSetupProperty(makeInput())
  ).rejects.toMatchObject({ statusCode: 400 });
});

it("addSetupProperty throws 400 when the round is not ACTIVE", async () => {
  const prisma = makePrisma();
  (prisma.serviceArea.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(makeServiceArea("area1"));
  (prisma.round.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(makeRound("round1", RoundStatus.DRAFT));
  await expect(
    createSetupService(prisma).addSetupProperty(makeInput())
  ).rejects.toMatchObject({ statusCode: 400 });
});

it("addSetupProperty throws 400 for a negative price", async () => {
  const prisma = makePrisma();
  (prisma.serviceArea.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(makeServiceArea("area1"));
  (prisma.round.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(makeRound("round1"));
  await expect(
    createSetupService(prisma).addSetupProperty({ ...makeInput(), price: -1 })
  ).rejects.toMatchObject({ statusCode: 400 });
});

it("addSetupProperty creates one plan at the full price when serviceIds is not given", async () => {
  const prisma = makePrisma();
  // addSetupProperty runs inside the interactive-callback form of
  // $transaction; the shared makePrisma() default hands the callback a
  // brand-new (unconfigured) mock client, so reuse this test's own `prisma`
  // instead, matching the pattern in round.service.test.ts.
  (prisma.$transaction as ReturnType<typeof vi.fn>).mockImplementation((fn: (tx: typeof prisma) => Promise<unknown>) => fn(prisma));
  (prisma.serviceArea.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(makeServiceArea("area1"));
  (prisma.round.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(makeRound("round1"));
  (prisma.customer.create as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "c1" });
  (prisma.property.create as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "p1" });
  (prisma.servicePlan.create as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "sp1", price: 35 });

  const result = await createSetupService(prisma).addSetupProperty({ ...makeInput(), price: 35, serviceId: "svc-a" });

  expect(prisma.servicePlan.create).toHaveBeenCalledTimes(1);
  expect(prisma.servicePlan.create).toHaveBeenCalledWith({
    data: expect.objectContaining({ serviceId: "svc-a", price: 35, propertyId: "p1" }),
  });
  expect(result.servicePlans).toEqual([{ id: "sp1", price: 35 }]);
  expect(result.servicePlan).toBe(result.servicePlans[0]);
});

it("addSetupProperty creates one plan per serviceIds entry, splitting price evenly", async () => {
  const prisma = makePrisma();
  (prisma.$transaction as ReturnType<typeof vi.fn>).mockImplementation((fn: (tx: typeof prisma) => Promise<unknown>) => fn(prisma));
  (prisma.serviceArea.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(makeServiceArea("area1"));
  (prisma.round.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(makeRound("round1"));
  (prisma.customer.create as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "c1" });
  (prisma.property.create as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "p1" });
  (prisma.servicePlan.create as ReturnType<typeof vi.fn>)
    .mockResolvedValueOnce({ id: "sp1", serviceId: "svc-a", price: 25 })
    .mockResolvedValueOnce({ id: "sp2", serviceId: "svc-b", price: 25 });

  const result = await createSetupService(prisma).addSetupProperty({
    ...makeInput(), price: 50, serviceIds: ["svc-a", "svc-b"],
  });

  expect(prisma.servicePlan.create).toHaveBeenCalledTimes(2);
  expect(prisma.servicePlan.create).toHaveBeenNthCalledWith(1, { data: expect.objectContaining({ serviceId: "svc-a", price: 25 }) });
  expect(prisma.servicePlan.create).toHaveBeenNthCalledWith(2, { data: expect.objectContaining({ serviceId: "svc-b", price: 25 }) });
  expect(result.servicePlans).toHaveLength(2);
});

it("addSetupProperty writes landline through to the created customer", async () => {
  const prisma = makePrisma();
  (prisma.$transaction as ReturnType<typeof vi.fn>).mockImplementation((fn: (tx: typeof prisma) => Promise<unknown>) => fn(prisma));
  (prisma.serviceArea.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(makeServiceArea("area1"));
  (prisma.round.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(makeRound("round1"));
  (prisma.customer.create as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "c1" });
  (prisma.property.create as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "p1" });
  (prisma.servicePlan.create as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "sp1" });

  await createSetupService(prisma).addSetupProperty({ ...makeInput(), landline: "01234567890" });

  expect(prisma.customer.create).toHaveBeenCalledWith({
    data: expect.objectContaining({ landline: "01234567890" }),
  });
});

// ── bulkAddSetupProperties ─────────────────────────────────────────────────

it("bulkAddSetupProperties: empty input returns { created: 0, failed: 0, results: [], errors: [] }", async () => {
  const prisma = makePrisma();
  const result = await createSetupService(prisma).bulkAddSetupProperties([]);
  expect(result).toEqual({ created: 0, failed: 0, results: [], errors: [] });
});

it("bulkAddSetupProperties: 3 valid rows returns created: 3", async () => {
  const prisma = makePrisma();
  (prisma.serviceArea.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([makeServiceArea("area1")]);
  (prisma.round.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([makeRound("round1")]);

  const inputs = [makeInput(), makeInput(), makeInput()];
  const result = await createSetupService(prisma).bulkAddSetupProperties(inputs);

  expect(result.created).toBe(3);
  expect(result.results).toHaveLength(3);
  expect(prisma.customer.createMany).toHaveBeenCalledTimes(1);
  expect(prisma.property.createMany).toHaveBeenCalledTimes(1);
  expect(prisma.servicePlan.createMany).toHaveBeenCalledTimes(1);
});

it("bulkAddSetupProperties: unknown serviceAreaId is reported as a row error, not an aborting throw", async () => {
  const prisma = makePrisma();
  (prisma.serviceArea.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]); // no areas found
  (prisma.round.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([makeRound("round1")]);

  const result = await createSetupService(prisma).bulkAddSetupProperties([makeInput()]);

  expect(result.created).toBe(0);
  expect(result.failed).toBe(1);
  expect(result.errors).toEqual([
    { row: 0, field: "serviceAreaId", message: expect.stringContaining("area1") },
  ]);
  expect(prisma.$transaction).not.toHaveBeenCalled();
});

it("bulkAddSetupProperties: unknown roundId is reported as a row error, not an aborting throw", async () => {
  const prisma = makePrisma();
  (prisma.serviceArea.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([makeServiceArea("area1")]);
  (prisma.round.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]); // no rounds found

  const result = await createSetupService(prisma).bulkAddSetupProperties([makeInput()]);

  expect(result.errors).toEqual([
    { row: 0, field: "roundId", message: expect.stringContaining("round1") },
  ]);
  expect(prisma.$transaction).not.toHaveBeenCalled();
});

it("bulkAddSetupProperties: inactive round is reported as a row error, not an aborting throw", async () => {
  const prisma = makePrisma();
  (prisma.serviceArea.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([makeServiceArea("area1")]);
  (prisma.round.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([makeRound("round1", RoundStatus.DRAFT)]);

  const result = await createSetupService(prisma).bulkAddSetupProperties([makeInput()]);

  expect(result.errors).toEqual([
    { row: 0, field: "roundId", message: expect.stringContaining("ACTIVE") },
  ]);
  expect(prisma.$transaction).not.toHaveBeenCalled();
});

it("bulkAddSetupProperties: a bad row doesn't block other valid rows in the same request", async () => {
  const prisma = makePrisma();
  (prisma.serviceArea.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([makeServiceArea("area1")]);
  (prisma.round.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([makeRound("round1")]);

  const result = await createSetupService(prisma).bulkAddSetupProperties([
    makeInput(),
    { ...makeInput(), serviceAreaId: "missing-area" },
    makeInput(),
  ]);

  expect(result.created).toBe(2);
  expect(result.failed).toBe(1);
  expect(result.errors).toEqual([
    { row: 1, field: "serviceAreaId", message: expect.stringContaining("missing-area") },
  ]);
});

it("bulkAddSetupProperties: 150 rows fires two transactions", async () => {
  const prisma = makePrisma();
  (prisma.serviceArea.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([makeServiceArea("area1")]);
  (prisma.round.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([makeRound("round1")]);

  const inputs = Array.from({ length: 150 }, () => makeInput());
  const result = await createSetupService(prisma).bulkAddSetupProperties(inputs);

  expect(result.created).toBe(150);
  expect(prisma.$transaction).toHaveBeenCalledTimes(2); // batch 1: 100, batch 2: 50
});

it("bulkAddSetupProperties: invalid propertyType is a row error and skips FK checks for that row", async () => {
  const prisma = makePrisma();
  const input = { ...makeInput(), propertyType: "IGLOO" };

  const result = await createSetupService(prisma).bulkAddSetupProperties([input]);

  expect(result.errors).toEqual([
    { row: 0, field: "propertyType", message: expect.stringContaining("propertyType") },
  ]);
  expect(prisma.serviceArea.findMany).not.toHaveBeenCalled();
});

it("bulkAddSetupProperties: invalid cleaningFrequency is reported as a row error", async () => {
  const prisma = makePrisma();
  const input = { ...makeInput(), cleaningFrequency: "DAILY" };
  const result = await createSetupService(prisma).bulkAddSetupProperties([input]);
  expect(result.errors).toEqual([
    { row: 0, field: "cleaningFrequency", message: expect.stringContaining("cleaningFrequency") },
  ]);
});

it("bulkAddSetupProperties: invalid paymentMethod is reported as a row error", async () => {
  const prisma = makePrisma();
  const input = { ...makeInput(), paymentMethod: "CRYPTO" };
  const result = await createSetupService(prisma).bulkAddSetupProperties([input]);
  expect(result.errors).toEqual([
    { row: 0, field: "paymentMethod", message: expect.stringContaining("paymentMethod") },
  ]);
});

it("bulkAddSetupProperties: a negative price is reported as a row error", async () => {
  const prisma = makePrisma();
  const input = { ...makeInput(), price: -5 };
  const result = await createSetupService(prisma).bulkAddSetupProperties([input]);
  expect(result.errors).toEqual([
    { row: 0, field: "price", message: expect.stringContaining("price") },
  ]);
});

it("bulkAddSetupProperties: a batch DB failure is reported per-row and does not throw", async () => {
  const prisma = makePrisma();
  (prisma.serviceArea.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([makeServiceArea("area1")]);
  (prisma.round.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([makeRound("round1")]);
  (prisma.$transaction as ReturnType<typeof vi.fn>).mockImplementationOnce(() =>
    Promise.reject(new Error("db exploded"))
  );

  const result = await createSetupService(prisma).bulkAddSetupProperties([makeInput(), makeInput()]);

  expect(result.created).toBe(0);
  expect(result.failed).toBe(2);
  expect(result.errors).toEqual([
    { row: 0, field: "batch", message: "db exploded" },
    { row: 1, field: "batch", message: "db exploded" },
  ]);
});

it("bulkAddSetupProperties: a failed batch doesn't stop a later batch from succeeding", async () => {
  const prisma = makePrisma();
  (prisma.serviceArea.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([makeServiceArea("area1")]);
  (prisma.round.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([makeRound("round1")]);
  (prisma.$transaction as ReturnType<typeof vi.fn>)
    .mockImplementationOnce(() => Promise.reject(new Error("batch 1 failed")))
    .mockImplementationOnce((arg: any) => Promise.all(arg));

  const inputs = Array.from({ length: 150 }, () => makeInput());
  const result = await createSetupService(prisma).bulkAddSetupProperties(inputs);

  expect(result.created).toBe(50); // batch 2 (rows 100-149) succeeded
  expect(result.failed).toBe(100); // batch 1 (rows 0-99) failed
  expect(result.errors).toHaveLength(100);
  expect(result.errors.every((e) => e.field === "batch")).toBe(true);
});

it("bulkAddSetupProperties: landline is written through to the created customer", async () => {
  const prisma = makePrisma();
  (prisma.serviceArea.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([makeServiceArea("area1")]);
  (prisma.round.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([makeRound("round1")]);

  await createSetupService(prisma).bulkAddSetupProperties([{ ...makeInput(), landline: "01234567890" }]);

  const call = (prisma.customer.createMany as ReturnType<typeof vi.fn>).mock.calls[0][0];
  expect(call.data[0].landline).toBe("01234567890");
});

it("bulkAddSetupProperties: serviceIds creates one ServicePlan per id, splitting price evenly", async () => {
  const prisma = makePrisma();
  (prisma.serviceArea.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([makeServiceArea("area1")]);
  (prisma.round.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([makeRound("round1")]);

  const result = await createSetupService(prisma).bulkAddSetupProperties([
    { ...makeInput(), price: 100, serviceIds: ["svc-a", "svc-b", "svc-c"] },
  ]);

  const call = (prisma.servicePlan.createMany as ReturnType<typeof vi.fn>).mock.calls[0][0];
  expect(call.data).toHaveLength(3);
  expect(call.data.map((p: { serviceId: string }) => p.serviceId)).toEqual(["svc-a", "svc-b", "svc-c"]);
  // 100 / 3 = 33.33.., floored to 33.33 for the first two, remainder on the last.
  expect(call.data[0].price).toBe(33.33);
  expect(call.data[1].price).toBe(33.33);
  expect(call.data[2].price).toBe(33.34);
  expect(call.data[0].price + call.data[1].price + call.data[2].price).toBe(100);
  expect(result.results[0].servicePlans).toHaveLength(3);
  expect(result.results[0].servicePlan).toBe(result.results[0].servicePlans[0]);
});

it("bulkAddSetupProperties: a single serviceId (no serviceIds) still creates exactly one plan at the full price", async () => {
  const prisma = makePrisma();
  (prisma.serviceArea.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([makeServiceArea("area1")]);
  (prisma.round.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([makeRound("round1")]);

  await createSetupService(prisma).bulkAddSetupProperties([
    { ...makeInput(), price: 50, serviceId: "svc-a" },
  ]);

  const call = (prisma.servicePlan.createMany as ReturnType<typeof vi.fn>).mock.calls[0][0];
  expect(call.data).toHaveLength(1);
  expect(call.data[0]).toMatchObject({ serviceId: "svc-a", price: 50 });
});

// ---- idempotency -----------------------------------------------------------

it("bulkAddSetupProperties: a repeat call with the same idempotencyKey returns the original count without re-inserting", async () => {
  const prisma = makePrisma();
  (prisma.bulkImportAttempt.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
    id: "a1", idempotencyKey: "key-1", createdCount: 3,
  });

  const result = await createSetupService(prisma).bulkAddSetupProperties([makeInput()], "key-1");

  expect(result).toEqual({ created: 3, failed: 0, results: [], errors: [], idempotent: true });
  expect(prisma.serviceArea.findMany).not.toHaveBeenCalled();
  expect(prisma.$transaction).not.toHaveBeenCalled();
});

it("bulkAddSetupProperties: records a BulkImportAttempt after a successful run when idempotencyKey is given", async () => {
  const prisma = makePrisma();
  (prisma.serviceArea.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([makeServiceArea("area1")]);
  (prisma.round.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([makeRound("round1")]);

  await createSetupService(prisma).bulkAddSetupProperties([makeInput()], "key-2");

  expect(prisma.bulkImportAttempt.create).toHaveBeenCalledWith({
    data: { idempotencyKey: "key-2", createdCount: 1 },
  });
});

it("bulkAddSetupProperties: does not record a BulkImportAttempt when no idempotencyKey is given", async () => {
  const prisma = makePrisma();
  (prisma.serviceArea.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([makeServiceArea("area1")]);
  (prisma.round.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([makeRound("round1")]);

  await createSetupService(prisma).bulkAddSetupProperties([makeInput()]);

  expect(prisma.bulkImportAttempt.findUnique).not.toHaveBeenCalled();
  expect(prisma.bulkImportAttempt.create).not.toHaveBeenCalled();
});

it("bulkAddSetupProperties: swallows a BulkImportAttempt create race (e.g. concurrent identical retry)", async () => {
  const prisma = makePrisma();
  (prisma.serviceArea.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([makeServiceArea("area1")]);
  (prisma.round.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([makeRound("round1")]);
  (prisma.bulkImportAttempt.create as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("unique violation"));

  const result = await createSetupService(prisma).bulkAddSetupProperties([makeInput()], "key-3");

  expect(result.created).toBe(1);
});

// ── getStatus: step 10 "all active rounds assigned" ────────────────────────
// These also guard the perf refactor that folded round.findMany into the
// getStatus() Promise.all — round.findMany must still be called exactly
// once and allRoundsAssigned must still be computed correctly.

it("getStatus: no active rounds → step 10 incomplete, round.findMany called once", async () => {
  const prisma = makePrisma();
  (prisma.round.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);

  const status = await createSetupService(prisma).getStatus();

  expect(status.steps.find((s) => s.step === 10)?.complete).toBe(false);
  expect(prisma.round.findMany).toHaveBeenCalledTimes(1);
});

it("getStatus: active round with no technicians → step 10 incomplete", async () => {
  const prisma = makePrisma();
  (prisma.round.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
    { id: "round1", roundTechnicians: [] },
  ]);

  const status = await createSetupService(prisma).getStatus();

  expect(status.steps.find((s) => s.step === 10)?.complete).toBe(false);
  expect(prisma.round.findMany).toHaveBeenCalledTimes(1);
});

it("getStatus: every active round has ≥1 technician → step 10 complete", async () => {
  const prisma = makePrisma();
  (prisma.round.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
    { id: "round1", roundTechnicians: [{ technicianId: "t1" }] },
    { id: "round2", roundTechnicians: [{ technicianId: "t2" }] },
  ]);

  const status = await createSetupService(prisma).getStatus();

  expect(status.steps.find((s) => s.step === 10)?.complete).toBe(true);
  expect(prisma.round.findMany).toHaveBeenCalledTimes(1);
});

// ── completeSetup: step 12 must never appear as a "missing" step ───────────
// Regression coverage (QA bug report RF-07): step 12 (Review & Launch) is the
// completion action itself — it can never be true until completeSetup()
// finishes, so allRequiredComplete already excludes it (step < 12). The error
// message's `missing` list didn't apply the same exclusion, so it always
// listed step 12 alongside any genuinely incomplete step, even though the
// wizard UI only shows 10 numbered steps.

it("completeSetup's error message excludes step 12 (Review & Launch is the completion action itself, not a real missing step)", async () => {
  const prisma = makePrisma();
  (prisma.round.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);

  await expect(createSetupService(prisma).completeSetup()).rejects.toThrow(
    "Setup cannot be completed — required steps incomplete: 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11"
  );
});

// ── saveTechnicians: email + serviceAreaIds (QA bug report RF-05) ──────────
// POST /setup/step/6 previously only accepted {name, role, phone, active} —
// email and service-area assignment were silently dropped even if the
// wizard's "Edit technician" form sent them.

it("saveTechnicians persists email and creates one TechnicianServiceArea row per assigned area", async () => {
  const prisma = makePrisma();
  (prisma.$transaction as ReturnType<typeof vi.fn>).mockImplementation((fn: (tx: typeof prisma) => Promise<unknown>) => fn(prisma));
  (prisma.serviceArea.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([{ id: "sa1" }, { id: "sa2" }]);
  (prisma.technician.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);

  await createSetupService(prisma).saveTechnicians([
    { name: "Jess", email: "jess@example.com", serviceAreaIds: ["sa1", "sa2"] },
  ]);

  expect(prisma.technician.createMany).toHaveBeenCalledWith({
    data: [expect.objectContaining({ name: "Jess", email: "jess@example.com" })],
  });
  const areaCall = (prisma.technicianServiceArea.createMany as ReturnType<typeof vi.fn>).mock.calls[0][0];
  expect(areaCall.data).toHaveLength(2);
  expect(areaCall.data).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ serviceAreaId: "sa1" }),
      expect.objectContaining({ serviceAreaId: "sa2" }),
    ])
  );
});

it("saveTechnicians rejects an unknown serviceAreaId before writing anything", async () => {
  const prisma = makePrisma();
  (prisma.serviceArea.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);

  await expect(
    createSetupService(prisma).saveTechnicians([{ name: "Jess", serviceAreaIds: ["missing-area"] }])
  ).rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining("missing-area") });
  expect(prisma.$transaction).not.toHaveBeenCalled();
});

it("saveTechnicians maps a duplicate-email unique constraint violation to a 409, not an unhandled error", async () => {
  const prisma = makePrisma();
  (prisma.$transaction as ReturnType<typeof vi.fn>).mockImplementation(() =>
    Promise.reject(uniqueConstraintError())
  );

  await expect(
    createSetupService(prisma).saveTechnicians([{ name: "Jess", email: "dupe@example.com" }])
  ).rejects.toMatchObject({ statusCode: 409 });
});

// ── getSettings() memoization & upsertSettings() cache refresh ─────────────
// A SetupService instance is created fresh per request (createSetupService),
// so these assert request-scoped behavior, not cross-request caching.

it("getSettings is memoized within one service instance: assertSetupIncomplete then a read hits the DB only once", async () => {
  const prisma = makePrisma();
  (prisma.businessSettings.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
    uniqueId: "singleton",
    setupCompleted: false,
    businessName: "Acme Cleaning",
  });

  const svc = createSetupService(prisma);
  await svc.assertSetupIncomplete();
  const settings = await svc.getBusinessSettings();

  expect(settings?.businessName).toBe("Acme Cleaning");
  expect(prisma.businessSettings.findFirst).toHaveBeenCalledTimes(1);
});

it("a new service instance does not share the memoized settings of a prior instance", async () => {
  const prisma = makePrisma();
  (prisma.businessSettings.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
    uniqueId: "singleton",
    setupCompleted: false,
  });

  await createSetupService(prisma).getBusinessSettings();
  await createSetupService(prisma).getBusinessSettings();

  expect(prisma.businessSettings.findFirst).toHaveBeenCalledTimes(2);
});

it("saveBusinessProfile refreshes the memo: a subsequent read in the same request reflects the write without re-querying", async () => {
  const prisma = makePrisma();
  (prisma.businessSettings.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
    uniqueId: "singleton",
    setupCompleted: false,
    businessName: null,
  });
  (prisma.businessSettings.upsert as ReturnType<typeof vi.fn>).mockResolvedValue({
    uniqueId: "singleton",
    setupCompleted: false,
    businessName: "Acme Cleaning",
  });

  const svc = createSetupService(prisma);
  await svc.getBusinessSettings(); // primes the memo with businessName: null
  await svc.saveBusinessProfile({ businessName: "Acme Cleaning" });
  const settings = await svc.getBusinessSettings();

  expect(settings?.businessName).toBe("Acme Cleaning");
  // One priming read + one post-write read that must be served from the
  // refreshed memo, not a second findFirst.
  expect(prisma.businessSettings.findFirst).toHaveBeenCalledTimes(1);
});

// ---- payment setup (wizard step 2) -------------------------------------------

it("getPaymentSetup returns the BusinessSettings singleton", async () => {
  const prisma = makePrisma();
  (prisma.businessSettings.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
    uniqueId: "singleton",
    paymentRule: "COLLECT_AFTER_VISIT",
    gocardlessConnected: true,
    stripeConnected: false,
  });

  const result = await createSetupService(prisma).getPaymentSetup();

  expect(result?.paymentRule).toBe("COLLECT_AFTER_VISIT");
});

it("getPaymentSetup returns null before setup has started", async () => {
  const prisma = makePrisma();
  (prisma.businessSettings.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);

  const result = await createSetupService(prisma).getPaymentSetup();

  expect(result).toBeNull();
});

it("savePaymentSetup persists paymentRule/debtHoldEnabled/vatInInvoices and the connect flags", async () => {
  const prisma = makePrisma();
  (prisma.businessSettings.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);
  (prisma.businessSettings.upsert as ReturnType<typeof vi.fn>).mockResolvedValue({
    uniqueId: "singleton",
    paymentRule: "COLLECT_BEFORE_VISIT",
    debtHoldEnabled: true,
    vatInInvoices: true,
    gocardlessConnected: true,
    stripeConnected: true,
  });

  const result = await createSetupService(prisma).savePaymentSetup({
    paymentRule: "COLLECT_BEFORE_VISIT",
    debtHoldEnabled: true,
    vatInInvoices: true,
    gocardlessConnected: true,
    stripeConnected: true,
  });

  expect(prisma.businessSettings.upsert).toHaveBeenCalledWith({
    where: { uniqueId: "singleton" },
    update: {
      paymentRule: "COLLECT_BEFORE_VISIT",
      debtHoldEnabled: true,
      vatInInvoices: true,
      gocardlessConnected: true,
      stripeConnected: true,
    },
    create: {
      paymentRule: "COLLECT_BEFORE_VISIT",
      debtHoldEnabled: true,
      vatInInvoices: true,
      gocardlessConnected: true,
      stripeConnected: true,
    },
  });
  expect(result.gocardlessConnected).toBe(true);
});

it("savePaymentSetup passes through undefined fields untouched (partial update)", async () => {
  const prisma = makePrisma();
  (prisma.businessSettings.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);
  (prisma.businessSettings.upsert as ReturnType<typeof vi.fn>).mockResolvedValue({ uniqueId: "singleton" });

  await createSetupService(prisma).savePaymentSetup({ stripeConnected: true });

  expect(prisma.businessSettings.upsert).toHaveBeenCalledWith(
    expect.objectContaining({
      update: {
        paymentRule: undefined,
        debtHoldEnabled: undefined,
        vatInInvoices: undefined,
        gocardlessConnected: undefined,
        stripeConnected: true,
      },
    })
  );
});
