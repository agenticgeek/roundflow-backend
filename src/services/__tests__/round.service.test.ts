import { it, expect, vi, beforeEach } from "vitest";
import { createRoundService } from "../round.service";
import { CleaningFrequency, RoundStatus } from "../../generated/tenant-client";

const sendMessage = vi.fn();
vi.mock("../message.service", () => ({
  createMessageService: vi.fn(() => ({ send: sendMessage })),
}));

beforeEach(() => {
  sendMessage.mockReset();
});

function makePrisma() {
  const prisma = {
    round: { findMany: vi.fn(), findUnique: vi.fn(), findUniqueOrThrow: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
    serviceArea: { findUnique: vi.fn() },
    technician: { findUnique: vi.fn(), findMany: vi.fn() },
    property: { findMany: vi.fn() },
    servicePlan: { update: vi.fn() },
    visit: { findMany: vi.fn(), updateMany: vi.fn(), findFirst: vi.fn(), create: vi.fn() },
    roundTechnician: { findMany: vi.fn(), deleteMany: vi.fn(), createMany: vi.fn() },
    // Defaults to "no settings row" (day not closed) so pre-existing tests
    // that don't care about Close Day behave the same as before it existed.
    businessSettings: { findFirst: vi.fn().mockResolvedValue(null) },
    $transaction: vi.fn(),
  } as unknown as Parameters<typeof createRoundService>[0];
  // Default: $transaction runs the callback immediately with the same client
  (prisma.$transaction as ReturnType<typeof vi.fn>).mockImplementation(
    (fn: (tx: typeof prisma) => Promise<unknown>) => fn(prisma)
  );
  return prisma;
}

it("createRoundService returns an object", () => {
  expect(createRoundService(makePrisma())).toBeDefined();
});

it("createRound stores TWELVE_WEEKLY frequency", async () => {
  const prisma = makePrisma();
  (prisma.serviceArea.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "sa1" });
  (prisma.round.create as ReturnType<typeof vi.fn>).mockResolvedValue({
    id: "r1", name: "Round A", frequency: CleaningFrequency.TWELVE_WEEKLY,
    status: RoundStatus.ACTIVE, defaultDay: null, description: null, serviceAreaId: "sa1",
    serviceArea: null, roundTechnicians: [], _count: { properties: 0 },
  });
  const result = await createRoundService(prisma).createRound({
    name: "Round A",
    frequency: CleaningFrequency.TWELVE_WEEKLY,
    serviceAreaId: "sa1",
  });
  expect(result.frequency).toBe(CleaningFrequency.TWELVE_WEEKLY);
});

it("setTechnicians throws 400 when a technician has not accepted their invite", async () => {
  const prisma = makePrisma();
  // Round exists
  (prisma.round.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "r1" });
  // Technician found but profileId is null — invite still pending
  (prisma.technician.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
    { id: "t1", active: true, profileId: null },
  ]);

  await expect(
    createRoundService(prisma).setTechnicians("r1", ["t1"])
  ).rejects.toMatchObject({ statusCode: 400 });
});

it("reassignTechnician throws 400 when target technician has not accepted their invite", async () => {
  const prisma = makePrisma();
  (prisma.round.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "r1" });
  (prisma.technician.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
    id: "t2", active: true, profileId: null,
  });

  await expect(
    createRoundService(prisma).reassignTechnician("r1", {
      fromTechnicianId: "t1",
      toTechnicianId: "t2",
      scope: "remaining",
      notify: false,
    })
  ).rejects.toMatchObject({ statusCode: 400 });
});

// ---- listOccurrencesForRounds -------------------------------------------

function makeVisit(overrides: Partial<{
  roundId: string | null;
  date: Date;
  status: string;
  paymentHold: boolean;
  price: { toNumber: () => number };
  _count: { issues: number };
  technician: { id: string; name: string | null } | null;
}> = {}) {
  return {
    roundId: "r1",
    date: new Date("2026-01-01T00:00:00.000Z"),
    status: "SCHEDULED",
    paymentHold: false,
    price: { toNumber: () => 0 },
    _count: { issues: 0 },
    technician: null,
    ...overrides,
  };
}

it("listOccurrencesForRounds groups results by round then by date, issuing a single query", async () => {
  const prisma = makePrisma();
  const visits = [
    // round r1: two visits same date (2026-01-01), one visit different date (2026-01-02)
    makeVisit({ roundId: "r1", date: new Date("2026-01-01T00:00:00.000Z"), status: "COMPLETED", price: { toNumber: () => 100 } }),
    makeVisit({ roundId: "r1", date: new Date("2026-01-01T00:00:00.000Z"), status: "SCHEDULED", paymentHold: true, price: { toNumber: () => 50 }, _count: { issues: 2 } }),
    makeVisit({ roundId: "r1", date: new Date("2026-01-02T00:00:00.000Z"), status: "SCHEDULED", price: { toNumber: () => 75 } }),
    // round r2: one visit, non-overlapping date range with r1's second date
    makeVisit({ roundId: "r2", date: new Date("2026-01-03T00:00:00.000Z"), status: "COMPLETED", price: { toNumber: () => 200 } }),
    // round r3 (requested below) has zero matching visits
  ];
  (prisma.visit.findMany as ReturnType<typeof vi.fn>).mockResolvedValue(visits);

  const result = await createRoundService(prisma).listOccurrencesForRounds(
    ["r1", "r2", "r3"],
    new Date("2026-01-01T00:00:00.000Z"),
    new Date("2026-01-05T00:00:00.000Z"),
  );

  expect(prisma.visit.findMany).toHaveBeenCalledTimes(1);
  expect(result).toHaveLength(3);

  const r1 = result.find((r) => r.roundId === "r1")!;
  expect(r1.occurrences).toHaveLength(2);
  const r1Jan1 = r1.occurrences.find((o) => o.date === "2026-01-01")!;
  expect(r1Jan1).toMatchObject({
    stopCount: 2,
    totalValue: 150,
    completedCount: 1,
    completionPct: 50,
    holdCount: 1,
    issueCount: 2,
  });
  const r1Jan2 = r1.occurrences.find((o) => o.date === "2026-01-02")!;
  expect(r1Jan2).toMatchObject({ stopCount: 1, totalValue: 75, completedCount: 0, completionPct: 0 });

  const r2 = result.find((r) => r.roundId === "r2")!;
  expect(r2.occurrences).toHaveLength(1);
  expect(r2.occurrences[0]).toMatchObject({ date: "2026-01-03", stopCount: 1, totalValue: 200, completedCount: 1, completionPct: 100 });

  // round with zero matching visits still appears, with an empty array
  const r3 = result.find((r) => r.roundId === "r3")!;
  expect(r3.occurrences).toEqual([]);

  // no per-round assertRoundExists lookup for a batch call
  expect(prisma.round.findUnique).not.toHaveBeenCalled();
});

it("listOccurrencesForRounds skips a visit whose roundId is null (defensive, shouldn't happen given the where filter)", async () => {
  const prisma = makePrisma();
  (prisma.visit.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
    makeVisit({ roundId: null }),
    makeVisit({ roundId: "r1" }),
  ]);

  const result = await createRoundService(prisma).listOccurrencesForRounds(
    ["r1"],
    new Date("2026-01-01T00:00:00.000Z"),
    undefined,
  );

  expect(result).toHaveLength(1);
  expect(result[0].occurrences).toHaveLength(1);
  expect(result[0].occurrences[0].stopCount).toBe(1);
});

it("listOccurrencesForRounds queries with only 'to' bound when 'from' is omitted", async () => {
  const prisma = makePrisma();
  (prisma.visit.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
    makeVisit({ roundId: "r1", date: new Date("2026-01-01T00:00:00.000Z") }),
  ]);

  const result = await createRoundService(prisma).listOccurrencesForRounds(
    ["r1"],
    undefined,
    new Date("2026-01-05T00:00:00.000Z"),
  );

  expect(prisma.visit.findMany).toHaveBeenCalledWith(
    expect.objectContaining({
      where: expect.objectContaining({
        roundId: { in: ["r1"] },
        date: { lte: new Date("2026-01-05T00:00:00.000Z") },
      }),
    })
  );
  expect(result[0].occurrences).toHaveLength(1);
});

it("listOccurrencesForRounds throws 400 when neither from nor to is given", async () => {
  const prisma = makePrisma();
  await expect(
    createRoundService(prisma).listOccurrencesForRounds(["r1"])
  ).rejects.toMatchObject({ statusCode: 400 });
  expect(prisma.visit.findMany).not.toHaveBeenCalled();
});

it("listOccurrencesForRounds throws 400 when from is after to", async () => {
  const prisma = makePrisma();
  await expect(
    createRoundService(prisma).listOccurrencesForRounds(
      ["r1"],
      new Date("2026-02-01T00:00:00.000Z"),
      new Date("2026-01-01T00:00:00.000Z"),
    )
  ).rejects.toMatchObject({ statusCode: 400 });
});

it("listOccurrencesForRounds throws 400 when the date range exceeds 90 days", async () => {
  const prisma = makePrisma();
  await expect(
    createRoundService(prisma).listOccurrencesForRounds(
      ["r1"],
      new Date("2026-01-01T00:00:00.000Z"),
      new Date("2026-05-01T00:00:00.000Z"),
    )
  ).rejects.toMatchObject({ statusCode: 400 });
});

it("listOccurrencesForRounds dedupes technicians per round/date and skips unassigned visits", async () => {
  const prisma = makePrisma();
  (prisma.visit.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
    makeVisit({ roundId: "r1", technician: { id: "t1", name: "James" } }),
    makeVisit({ roundId: "r1", technician: { id: "t1", name: "James" } }),
    makeVisit({ roundId: "r1", technician: { id: "t2", name: "Priya" } }),
    makeVisit({ roundId: "r1", technician: null }),
  ]);
  const result = await createRoundService(prisma).listOccurrencesForRounds(
    ["r1"],
    new Date("2026-01-01T00:00:00.000Z"),
    new Date("2026-01-05T00:00:00.000Z"),
  );
  const occ = result.find((r) => r.roundId === "r1")!.occurrences[0];
  expect(occ.technicians).toEqual([
    { id: "t1", name: "James" },
    { id: "t2", name: "Priya" },
  ]);
});

it("listOccurrencesForRounds returns an empty technicians array for a round with zero matching visits", async () => {
  const prisma = makePrisma();
  (prisma.visit.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  const result = await createRoundService(prisma).listOccurrencesForRounds(
    ["r1"],
    new Date("2026-01-01T00:00:00.000Z"),
    new Date("2026-01-05T00:00:00.000Z"),
  );
  expect(result[0].occurrences).toEqual([]);
});

// ---- listOccurrences (single round) ----------------------------------------

it("listOccurrences throws 404 when the round does not exist", async () => {
  const prisma = makePrisma();
  (prisma.round.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);
  await expect(
    createRoundService(prisma).listOccurrences("missing", new Date("2026-01-01T00:00:00.000Z"), new Date("2026-01-05T00:00:00.000Z"))
  ).rejects.toMatchObject({ statusCode: 404 });
});

it("listOccurrences throws 400 when neither from nor to is given", async () => {
  const prisma = makePrisma();
  (prisma.round.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "r1" });
  await expect(createRoundService(prisma).listOccurrences("r1")).rejects.toMatchObject({ statusCode: 400 });
});

it("listOccurrences throws 400 when from is after to", async () => {
  const prisma = makePrisma();
  (prisma.round.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "r1" });
  await expect(
    createRoundService(prisma).listOccurrences("r1", new Date("2026-02-01T00:00:00.000Z"), new Date("2026-01-01T00:00:00.000Z"))
  ).rejects.toMatchObject({ statusCode: 400 });
});

it("listOccurrences throws 400 when the date range exceeds 90 days", async () => {
  const prisma = makePrisma();
  (prisma.round.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "r1" });
  await expect(
    createRoundService(prisma).listOccurrences("r1", new Date("2026-01-01T00:00:00.000Z"), new Date("2026-05-01T00:00:00.000Z"))
  ).rejects.toMatchObject({ statusCode: 400 });
});

it("listOccurrences dedupes technicians per date and skips unassigned visits", async () => {
  const prisma = makePrisma();
  (prisma.round.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "r1" });
  (prisma.visit.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
    { date: new Date("2026-01-01T00:00:00.000Z"), status: "COMPLETED", paymentHold: false, price: { toNumber: () => 50 }, _count: { issues: 0 }, technician: { id: "t1", name: "James" } },
    { date: new Date("2026-01-01T00:00:00.000Z"), status: "SCHEDULED", paymentHold: false, price: { toNumber: () => 40 }, _count: { issues: 0 }, technician: { id: "t1", name: "James" } },
    { date: new Date("2026-01-01T00:00:00.000Z"), status: "SCHEDULED", paymentHold: false, price: { toNumber: () => 30 }, _count: { issues: 0 }, technician: null },
  ]);
  const result = await createRoundService(prisma).listOccurrences(
    "r1",
    new Date("2026-01-01T00:00:00.000Z"),
    new Date("2026-01-02T00:00:00.000Z"),
  );
  expect(result).toHaveLength(1);
  expect(result[0].technicians).toEqual([{ id: "t1", name: "James" }]);
});

// ---- getOccurrence ----------------------------------------------------------

it("getOccurrence throws 404 when the round does not exist", async () => {
  const prisma = makePrisma();
  (prisma.round.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);
  await expect(createRoundService(prisma).getOccurrence("missing", "2026-01-01")).rejects.toMatchObject({ statusCode: 404 });
});

it("getOccurrence throws 400 for an invalid date", async () => {
  const prisma = makePrisma();
  (prisma.round.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "r1", name: "Round A" });
  await expect(createRoundService(prisma).getOccurrence("r1", "not-a-date")).rejects.toMatchObject({ statusCode: 400 });
});

it("getOccurrence returns stops and a summary with deduped technicians", async () => {
  const prisma = makePrisma();
  (prisma.round.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "r1", name: "Round A" });
  (prisma.visit.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
    {
      id: "v1", propertyId: "p1", price: { toNumber: () => 40 }, status: "COMPLETED", paymentHold: false,
      technicianId: "t1", completedAt: new Date("2026-01-01T10:00:00.000Z"),
      technician: { id: "t1", name: "James" },
      property: { propertyName: "12 Main St", addressLine: "12 Main St", postcode: "NE1 1AA", customer: { name: "John Smith" } },
      issues: [],
    },
    {
      id: "v2", propertyId: "p2", price: { toNumber: () => 30 }, status: "SCHEDULED", paymentHold: true,
      technicianId: "t1", completedAt: null,
      technician: { id: "t1", name: "James" },
      property: { propertyName: null, addressLine: "14 Main St", postcode: "NE1 1AB", customer: null },
      issues: [{ id: "i1", type: "ACCESS_PROBLEM", note: "Locked gate" }],
    },
  ]);
  const result = await createRoundService(prisma).getOccurrence("r1", "2026-01-01");
  expect(result.roundId).toBe("r1");
  expect(result.stops).toHaveLength(2);
  expect(result.summary.technicians).toEqual([{ id: "t1", name: "James" }]);
  expect(result.summary.holdCount).toBe(1);
  expect(result.summary.issueCount).toBe(1);
});

// ---- listDayStopsForRounds ---------------------------------------------------

function makeFullStopVisit(overrides: Record<string, unknown> = {}) {
  return {
    id: "v1", propertyId: "p1", price: { toNumber: () => 40 }, status: "COMPLETED", paymentHold: false,
    technicianId: "t1", completedAt: null, roundId: "r1",
    technician: { id: "t1", name: "James" },
    property: { propertyName: null, addressLine: "12 Main St", postcode: "NE1 1AA", customer: { name: "John Smith" } },
    issues: [],
    ...overrides,
  };
}

it("listDayStopsForRounds throws 400 for an invalid date (no per-round 404 lookup)", async () => {
  const prisma = makePrisma();
  await expect(
    createRoundService(prisma).listDayStopsForRounds(["r1", "r2"], "not-a-date")
  ).rejects.toMatchObject({ statusCode: 400 });
  expect(prisma.visit.findMany).not.toHaveBeenCalled();
});

it("listDayStopsForRounds groups stops by round, one query for every requested round", async () => {
  const prisma = makePrisma();
  (prisma.visit.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
    makeFullStopVisit({ id: "v1", roundId: "r1" }),
    makeFullStopVisit({ id: "v2", roundId: "r1" }),
    makeFullStopVisit({ id: "v3", roundId: "r2" }),
  ]);

  const result = await createRoundService(prisma).listDayStopsForRounds(["r1", "r2", "r3"], "2026-01-01");

  expect(prisma.visit.findMany).toHaveBeenCalledTimes(1);
  expect(result).toHaveLength(3);
  expect(result.find((r) => r.roundId === "r1")!.stops).toHaveLength(2);
  expect(result.find((r) => r.roundId === "r2")!.stops).toHaveLength(1);
  // A round with zero matching visits still appears, with an empty array —
  // no per-round 404, matching listOccurrencesForRounds()'s batch semantics.
  expect(result.find((r) => r.roundId === "r3")!.stops).toEqual([]);
});

it("listDayStopsForRounds skips a visit whose roundId is null (defensive, shouldn't happen given the where filter)", async () => {
  const prisma = makePrisma();
  (prisma.visit.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
    makeFullStopVisit({ id: "v1", roundId: null }),
    makeFullStopVisit({ id: "v2", roundId: "r1" }),
  ]);

  const result = await createRoundService(prisma).listDayStopsForRounds(["r1"], "2026-01-01");

  expect(result[0].stops).toHaveLength(1);
});

it("listDayStopsForRounds queries the given date's UTC range for all roundIds at once", async () => {
  const prisma = makePrisma();
  (prisma.visit.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);

  await createRoundService(prisma).listDayStopsForRounds(["r1", "r2"], "2026-01-01");

  const call = (prisma.visit.findMany as ReturnType<typeof vi.fn>).mock.calls[0][0];
  expect(call.where.roundId).toEqual({ in: ["r1", "r2"] });
  expect(call.where.date.gte).toEqual(new Date("2026-01-01T00:00:00.000Z"));
  expect(call.where.date.lt).toEqual(new Date("2026-01-02T00:00:00.000Z"));
});

// ---- generateVisitsNow --------------------------------------------------------

it("generateVisitsNow throws 404 when the round does not exist", async () => {
  const prisma = makePrisma();
  (prisma.round.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);
  await expect(createRoundService(prisma).generateVisitsNow("missing")).rejects.toMatchObject({ statusCode: 404 });
});

it("generateVisitsNow throws 400 when the round is not ACTIVE", async () => {
  const prisma = makePrisma();
  (prisma.round.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "r1", frequency: "FOUR_WEEKLY", status: RoundStatus.DRAFT });
  await expect(createRoundService(prisma).generateVisitsNow("r1")).rejects.toMatchObject({ statusCode: 400 });
  expect(prisma.property.findMany).not.toHaveBeenCalled();
});

it("generateVisitsNow creates due visits for the round's ACTIVE properties right now", async () => {
  const prisma = makePrisma();
  (prisma.round.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "r1", frequency: "FOUR_WEEKLY", status: RoundStatus.ACTIVE });
  (prisma.property.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
    {
      id: "p1",
      servicePlans: [
        { id: "sp1", price: 35, nextDueDate: new Date("2026-01-01T00:00:00.000Z"), cleaningFrequency: "FOUR_WEEKLY", serviceId: null },
      ],
    },
  ]);
  (prisma.visit.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);
  (prisma.visit.create as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "v1" });
  (prisma.servicePlan.update as ReturnType<typeof vi.fn>).mockResolvedValue({});

  const result = await createRoundService(prisma).generateVisitsNow("r1");

  expect(result).toEqual({ visitsGenerated: 1 });
  expect(prisma.visit.create).toHaveBeenCalledTimes(1);
  const createArgs = (prisma.visit.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
  expect(createArgs.data).toMatchObject({ propertyId: "p1", roundId: "r1", servicePlanId: "sp1", price: 35 });
});

it("generateVisitsNow skips a plan that already has a future scheduled/in-progress visit (idempotent)", async () => {
  const prisma = makePrisma();
  (prisma.round.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "r1", frequency: "FOUR_WEEKLY", status: RoundStatus.ACTIVE });
  (prisma.property.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
    {
      id: "p1",
      servicePlans: [
        { id: "sp1", price: 35, nextDueDate: new Date("2026-01-01T00:00:00.000Z"), cleaningFrequency: "FOUR_WEEKLY", serviceId: null },
      ],
    },
  ]);
  (prisma.visit.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "existing-visit" });

  const result = await createRoundService(prisma).generateVisitsNow("r1");

  expect(result).toEqual({ visitsGenerated: 0 });
  expect(prisma.visit.create).not.toHaveBeenCalled();
});

it("generateVisitsNow skips a plan with no frequency (neither its own nor the round's) and no nextDueDate", async () => {
  const prisma = makePrisma();
  (prisma.round.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "r1", frequency: null, status: RoundStatus.ACTIVE });
  (prisma.property.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
    { id: "p1", servicePlans: [{ id: "sp1", price: 35, nextDueDate: null, cleaningFrequency: null, serviceId: null }] },
  ]);

  const result = await createRoundService(prisma).generateVisitsNow("r1");

  expect(result).toEqual({ visitsGenerated: 0 });
  expect(prisma.visit.create).not.toHaveBeenCalled();
});

it("reassignTechnician throws 400 when fromTechnicianId and toTechnicianId are the same", async () => {
  const prisma = makePrisma();
  await expect(
    createRoundService(prisma).reassignTechnician("r1", {
      fromTechnicianId: "t1",
      toTechnicianId: "t1",
      scope: "remaining",
      notify: false,
    })
  ).rejects.toMatchObject({ statusCode: 400 });
  expect(prisma.round.findUnique).not.toHaveBeenCalled();
});

// ---- Close Day guard (reassignTechnician / pushMissedJobs) -----------------

it("reassignTechnician throws 409 when the operational day is already closed", async () => {
  const prisma = makePrisma();
  (prisma.round.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "r1" });
  const today = new Date().toISOString().slice(0, 10);
  (prisma.businessSettings.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({ lastClosedDate: today });
  await expect(
    createRoundService(prisma).reassignTechnician("r1", {
      fromTechnicianId: "t1",
      toTechnicianId: "t2",
      scope: "remaining",
      notify: false,
    })
  ).rejects.toMatchObject({ statusCode: 409 });
  expect(prisma.visit.updateMany).not.toHaveBeenCalled();
});

it("reassignTechnician succeeds when the day is not closed", async () => {
  const prisma = makePrisma();
  (prisma.round.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "r1" });
  (prisma.technician.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "t2", active: true, profileId: "p2" });
  (prisma.visit.updateMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 3 });
  const result = await createRoundService(prisma).reassignTechnician("r1", {
    fromTechnicianId: "t1",
    toTechnicianId: "t2",
    scope: "all",
    notify: false,
  });
  expect(result).toEqual({ updatedCount: 3 });
});

it("pushMissedJobs throws 409 when the operational day is already closed", async () => {
  const prisma = makePrisma();
  (prisma.round.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "r1" });
  const today = new Date().toISOString().slice(0, 10);
  (prisma.businessSettings.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({ lastClosedDate: today });
  const tomorrow = new Date(Date.now() + 2 * 86_400_000);
  await expect(
    createRoundService(prisma).pushMissedJobs("r1", { newDate: tomorrow, reason: "Weather", notifyCustomers: false })
  ).rejects.toMatchObject({ statusCode: 409 });
  expect(prisma.visit.updateMany).not.toHaveBeenCalled();
});

it("pushMissedJobs throws 400 when newDate is not after today", async () => {
  const prisma = makePrisma();
  (prisma.round.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "r1" });
  await expect(
    createRoundService(prisma).pushMissedJobs("r1", { newDate: new Date(), reason: "x", notifyCustomers: false })
  ).rejects.toMatchObject({ statusCode: 400 });
});

it("pushMissedJobs does not query affected visits or send messages when notifyCustomers is false", async () => {
  const prisma = makePrisma();
  (prisma.round.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "r1" });
  (prisma.visit.updateMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 2 });
  const tomorrow = new Date(Date.now() + 2 * 86_400_000);
  const result = await createRoundService(prisma).pushMissedJobs("r1", {
    newDate: tomorrow, reason: "Weather", notifyCustomers: false,
  });
  expect(result).toEqual({ pushedCount: 2 });
  expect(prisma.visit.findMany).not.toHaveBeenCalled();
  expect(sendMessage).not.toHaveBeenCalled();
});

it("pushMissedJobs sends one deduped message per affected customer when notifyCustomers is true", async () => {
  const prisma = makePrisma();
  (prisma.round.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "r1" });
  (prisma.visit.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
    { property: { customerId: "c1" } },
    { property: { customerId: "c1" } },
    { property: { customerId: "c2" } },
  ]);
  (prisma.visit.updateMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 3 });
  sendMessage.mockResolvedValue({ status: "sent" });
  const tomorrow = new Date(Date.now() + 2 * 86_400_000);
  await createRoundService(prisma).pushMissedJobs("r1", {
    newDate: tomorrow, reason: "Weather delay", notifyCustomers: true,
  });
  expect(sendMessage).toHaveBeenCalledTimes(2);
  expect(sendMessage).toHaveBeenCalledWith({ customerId: "c1", channel: "sms", body: "Your clean has been rescheduled. Reason: Weather delay" });
  expect(sendMessage).toHaveBeenCalledWith({ customerId: "c2", channel: "sms", body: "Your clean has been rescheduled. Reason: Weather delay" });
});

it("pushMissedJobs uses the caller-provided message verbatim (trimmed) instead of the reason fallback", async () => {
  const prisma = makePrisma();
  (prisma.round.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "r1" });
  (prisma.visit.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([{ property: { customerId: "c1" } }]);
  (prisma.visit.updateMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 1 });
  sendMessage.mockResolvedValue({ status: "sent" });
  const tomorrow = new Date(Date.now() + 2 * 86_400_000);
  await createRoundService(prisma).pushMissedJobs("r1", {
    newDate: tomorrow, reason: "Weather delay", notifyCustomers: true, message: "  Sorry, we're rescheduling you.  ",
  });
  expect(sendMessage).toHaveBeenCalledWith({ customerId: "c1", channel: "sms", body: "Sorry, we're rescheduling you." });
});

it("pushMissedJobs falls back to the reason-based message when message is only whitespace", async () => {
  const prisma = makePrisma();
  (prisma.round.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "r1" });
  (prisma.visit.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([{ property: { customerId: "c1" } }]);
  (prisma.visit.updateMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 1 });
  sendMessage.mockResolvedValue({ status: "sent" });
  const tomorrow = new Date(Date.now() + 2 * 86_400_000);
  await createRoundService(prisma).pushMissedJobs("r1", {
    newDate: tomorrow, reason: "Weather delay", notifyCustomers: true, message: "   ",
  });
  expect(sendMessage).toHaveBeenCalledWith({ customerId: "c1", channel: "sms", body: "Your clean has been rescheduled. Reason: Weather delay" });
});

it("pushMissedJobs does not send anything when notifyCustomers is true but no visits matched", async () => {
  const prisma = makePrisma();
  (prisma.round.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "r1" });
  (prisma.visit.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  (prisma.visit.updateMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 0 });
  const tomorrow = new Date(Date.now() + 2 * 86_400_000);
  const result = await createRoundService(prisma).pushMissedJobs("r1", {
    newDate: tomorrow, reason: "Weather", notifyCustomers: true,
  });
  expect(result).toEqual({ pushedCount: 0 });
  expect(sendMessage).not.toHaveBeenCalled();
});

it("pushMissedJobs logs and continues when a per-customer send fails (best-effort)", async () => {
  const prisma = makePrisma();
  (prisma.round.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "r1" });
  (prisma.visit.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
    { property: { customerId: "c1" } },
    { property: { customerId: "c2" } },
  ]);
  (prisma.visit.updateMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 2 });
  sendMessage.mockRejectedValueOnce(new Error("GHL down")).mockResolvedValueOnce({ status: "sent" });
  const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  const tomorrow = new Date(Date.now() + 2 * 86_400_000);
  const result = await createRoundService(prisma).pushMissedJobs("r1", {
    newDate: tomorrow, reason: "Weather", notifyCustomers: true,
  });
  expect(result).toEqual({ pushedCount: 2 });
  expect(sendMessage).toHaveBeenCalledTimes(2);
  expect(consoleErrorSpy).toHaveBeenCalled();
  consoleErrorSpy.mockRestore();
});
