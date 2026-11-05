import { it, expect, vi, beforeEach, describe } from "vitest";
import { createRoundService, AllocationError } from "../round.service";
import { CleaningFrequency, RoundStatus } from "../../generated/tenant-client";

const sendMessage = vi.fn();
vi.mock("../message.service", () => ({
  createMessageService: vi.fn(() => ({ send: sendMessage })),
}));

// Real resolve/autoSplit; restamping is visit-assignment's own concern
// (tested there), so it's stubbed to a count here.
const restampFutureVisits = vi.fn();
vi.mock("../visit-assignment", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../visit-assignment")>()),
  restampFutureVisits: (...args: unknown[]) => restampFutureVisits(...args),
}));

beforeEach(() => {
  sendMessage.mockReset();
  restampFutureVisits.mockReset().mockResolvedValue(0);
});

function makePrisma() {
  const prisma = {
    round: { findMany: vi.fn(), findUnique: vi.fn(), findUniqueOrThrow: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
    serviceArea: { findUnique: vi.fn() },
    technician: { findUnique: vi.fn(), findMany: vi.fn() },
    property: { findMany: vi.fn(), updateMany: vi.fn() },
    servicePlan: { update: vi.fn() },
    visit: { findMany: vi.fn(), updateMany: vi.fn(), findFirst: vi.fn(), create: vi.fn() },
    roundTechnician: { findMany: vi.fn().mockResolvedValue([]), deleteMany: vi.fn(), createMany: vi.fn() },
    technicianAvailability: { findMany: vi.fn().mockResolvedValue([]) },
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
      scope: "REMAINING",
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

it("getOccurrence passes through a stop's geocoded latitude/longitude, and null when ungeocoded", async () => {
  const prisma = makePrisma();
  (prisma.round.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "r1", name: "Round A" });
  (prisma.visit.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
    {
      id: "v1", propertyId: "p1", price: { toNumber: () => 40 }, status: "COMPLETED", paymentHold: false,
      technicianId: "t1", completedAt: null,
      technician: { id: "t1", name: "James" },
      property: {
        propertyName: "12 Main St", addressLine: "12 Main St", postcode: "NE1 1AA",
        latitude: 55.4, longitude: -1.7, customer: { name: "John Smith" },
      },
      issues: [],
    },
    {
      id: "v2", propertyId: "p2", price: { toNumber: () => 30 }, status: "SCHEDULED", paymentHold: false,
      technicianId: null, completedAt: null,
      technician: null,
      property: {
        propertyName: null, addressLine: "14 Main St", postcode: "NE1 1AB",
        latitude: null, longitude: null, customer: null,
      },
      issues: [],
    },
  ]);
  const result = await createRoundService(prisma).getOccurrence("r1", "2026-01-01");
  expect(result.stops[0]).toMatchObject({ latitude: 55.4, longitude: -1.7 });
  expect(result.stops[1]).toMatchObject({ latitude: null, longitude: null });
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

// ---- getTodayPanel --------------------------------------------------------

it("getTodayPanel throws 404 when the round does not exist", async () => {
  const prisma = makePrisma();
  (prisma.round.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);
  await expect(createRoundService(prisma).getTodayPanel("r1")).rejects.toMatchObject({ statusCode: 404 });
});

it("getTodayPanel passes through each stop's geocoded latitude/longitude, and null when ungeocoded", async () => {
  const prisma = makePrisma();
  (prisma.round.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "r1", name: "Round A" });
  (prisma.visit.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
    {
      id: "v1", status: "SCHEDULED", paymentHold: false, technicianId: "t1",
      technician: { id: "t1", name: "James" },
      property: { addressLine: "12 Main St", latitude: 55.4, longitude: -1.7, customer: { name: "John Smith" } },
      issues: [],
    },
    {
      id: "v2", status: "SCHEDULED", paymentHold: false, technicianId: null,
      technician: null,
      property: { addressLine: "14 Main St", latitude: null, longitude: null, customer: null },
      issues: [],
    },
  ]);

  const result = await createRoundService(prisma).getTodayPanel("r1");

  expect(result.stops[0]).toMatchObject({ latitude: 55.4, longitude: -1.7 });
  expect(result.stops[1]).toMatchObject({ latitude: null, longitude: null });
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
      assignedTechnicianId: null,
      customer: { holdNextClean: false },
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
      assignedTechnicianId: null,
      customer: { holdNextClean: false },
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
    { id: "p1", assignedTechnicianId: null, customer: { holdNextClean: false }, servicePlans: [{ id: "sp1", price: 35, nextDueDate: null, cleaningFrequency: null, serviceId: null }] },
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
      scope: "REMAINING",
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
      scope: "REMAINING",
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
    scope: "ALL",
    notify: false,
  });
  expect(result).toEqual({ updated: 3 });
  // A one-off reassign is pinned so restamping leaves it alone.
  expect(prisma.visit.updateMany).toHaveBeenCalledWith({
    where: expect.objectContaining({ roundId: "r1", technicianId: "t1" }),
    data: { technicianId: "t2", technicianOverride: true },
  });
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

// ---- A1: setTechnicians split / allocation (GAP-012) ----------------------

const mock = (fn: unknown) => fn as ReturnType<typeof vi.fn>;

function tech(id: string, overrides: Record<string, unknown> = {}) {
  return { id, name: `Tech ${id}`, active: true, profileId: `prof-${id}`, ...overrides };
}

function roundProperty(id: string, addressLine: string, prices: number[] = [], assignedTechnicianId: string | null = null) {
  return { id, postcode: "NE66 1AA", addressLine, assignedTechnicianId, servicePlans: prices.map((price) => ({ price })) };
}

function splitPrisma(technicians: ReturnType<typeof tech>[], properties: ReturnType<typeof roundProperty>[]) {
  const prisma = makePrisma();
  mock(prisma.round.findUnique).mockResolvedValue({ id: "r1" });
  mock(prisma.technician.findMany).mockResolvedValue(technicians);
  mock(prisma.property.findMany).mockResolvedValue(properties);
  return prisma;
}

// propertyIds per assignedTechnicianId from the property.updateMany calls.
function propertyWrites(prisma: ReturnType<typeof makePrisma>) {
  return Object.fromEntries(
    mock(prisma.property.updateMany).mock.calls.map((c) => [String(c[0].data.assignedTechnicianId), c[0].where.id.in])
  );
}

describe("setTechnicians", () => {
  it("404s when the round does not exist", async () => {
    const prisma = makePrisma();
    mock(prisma.round.findUnique).mockResolvedValue(null);
    await expect(createRoundService(prisma).setTechnicians("missing", [])).rejects.toMatchObject({ statusCode: 404 });
  });

  it("404s when a technician is unknown", async () => {
    const prisma = splitPrisma([], []);
    await expect(createRoundService(prisma).setTechnicians("r1", ["t1"])).rejects.toMatchObject({ statusCode: 404 });
  });

  it("names pending-invite technicians in the 400 (falling back to id)", async () => {
    const prisma = splitPrisma([tech("t1", { profileId: null }), tech("t2", { profileId: null, name: null })], []);
    await expect(createRoundService(prisma).setTechnicians("r1", ["t1", "t2"])).rejects.toMatchObject({
      statusCode: 400,
      message: "Cannot assign technician(s) with a pending invite: Tech t1, t2",
    });
  });

  it("400s for an inactive technician", async () => {
    const prisma = splitPrisma([tech("t1", { active: false })], []);
    await expect(createRoundService(prisma).setTechnicians("r1", ["t1"])).rejects.toMatchObject({ statusCode: 400 });
  });

  it("400s when SINGLE is given with other than exactly one technician", async () => {
    const prisma = splitPrisma([], []);
    for (const ids of [[], ["t1", "t2"]]) {
      await expect(
        createRoundService(prisma).setTechnicians("r1", ids, { mode: "SINGLE" })
      ).rejects.toMatchObject({ statusCode: 400 });
    }
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("defaults to SINGLE for one technician: every property, round technicians replaced, visits restamped", async () => {
    const prisma = splitPrisma([tech("t1")], [roundProperty("p1", "1 High St", [20, 17]), roundProperty("p2", "2 High St", [15])]);
    restampFutureVisits.mockResolvedValue(6);

    const result = await createRoundService(prisma).setTechnicians("r1", ["t1", "t1"]);

    expect(result).toEqual({
      roundId: "r1",
      allocation: [{ technicianId: "t1", name: "Tech t1", propertyIds: ["p1", "p2"], stops: 2, value: "52.00" }],
      visitsUpdated: 6,
    });
    expect(prisma.roundTechnician.deleteMany).toHaveBeenCalledWith({ where: { roundId: "r1" } });
    expect(prisma.roundTechnician.createMany).toHaveBeenCalledWith({ data: [{ roundId: "r1", technicianId: "t1" }] });
    expect(propertyWrites(prisma)).toEqual({ t1: ["p1", "p2"] });
    expect(restampFutureVisits).toHaveBeenCalledWith(prisma, "r1", expect.any(Date));
  });

  it("an empty list clears the round and unassigns every property", async () => {
    const prisma = splitPrisma([], [roundProperty("p1", "1 High St")]);

    const result = await createRoundService(prisma).setTechnicians("r1", []);

    expect(result.allocation).toEqual([]);
    expect(prisma.technician.findMany).not.toHaveBeenCalled();
    expect(prisma.roundTechnician.createMany).not.toHaveBeenCalled();
    expect(propertyWrites(prisma)).toEqual({ null: ["p1"] });
  });

  it("defaults to AUTO for two or more technicians, keeping streets whole", async () => {
    const prisma = splitPrisma(
      [tech("t1"), tech("t2")],
      [
        roundProperty("a1", "1 Acre Rd", [10]),
        roundProperty("a2", "2 Acre Rd", [10]),
        roundProperty("b1", "1 Bell St", [12]),
        roundProperty("b2", "2 Bell St", [12]),
      ]
    );

    // Request order doesn't matter: the split is labelled by sorted id.
    const result = await createRoundService(prisma).setTechnicians("r1", ["t2", "t1"]);

    expect(result.allocation).toEqual([
      { technicianId: "t2", name: "Tech t2", propertyIds: ["b1", "b2"], stops: 2, value: "24.00" },
      { technicianId: "t1", name: "Tech t1", propertyIds: ["a1", "a2"], stops: 2, value: "20.00" },
    ]);
    expect(propertyWrites(prisma)).toEqual({ t1: ["a1", "a2"], t2: ["b1", "b2"] });
  });

  it("MANUAL writes the given allocation and leaves unlisted properties unassigned", async () => {
    const prisma = splitPrisma(
      [tech("t1"), tech("t2")],
      [roundProperty("p1", "1 High St"), roundProperty("p2", "2 High St"), roundProperty("p3", "3 High St")]
    );

    const result = await createRoundService(prisma).setTechnicians("r1", ["t1", "t2"], {
      mode: "MANUAL",
      allocations: [{ propertyId: "p1", technicianId: "t2" }, { propertyId: "p2", technicianId: "t1" }],
    });

    expect(result.allocation.map((a) => [a.technicianId, a.propertyIds])).toEqual([["t1", ["p2"]], ["t2", ["p1"]]]);
    expect(propertyWrites(prisma)).toEqual({ t2: ["p1"], t1: ["p2"], null: ["p3"] });
  });

  it("MANUAL without allocations unassigns everything", async () => {
    const prisma = splitPrisma([tech("t1")], [roundProperty("p1", "1 High St")]);
    await createRoundService(prisma).setTechnicians("r1", ["t1"], { mode: "MANUAL" });
    expect(propertyWrites(prisma)).toEqual({ null: ["p1"] });
  });

  it("MANUAL 400s with INVALID_ALLOCATION and a per-property reason map, writing nothing", async () => {
    const prisma = splitPrisma([tech("t1")], [roundProperty("p1", "1 High St"), roundProperty("p2", "2 High St")]);

    const err = await createRoundService(prisma)
      .setTechnicians("r1", ["t1"], {
        mode: "MANUAL",
        allocations: [
          { propertyId: "p9", technicianId: "t1" },
          { propertyId: "p1", technicianId: "t1" },
          { propertyId: "p1", technicianId: "t1" },
          { propertyId: "p2", technicianId: "t7" },
        ],
      })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(AllocationError);
    expect(err).toMatchObject({
      statusCode: 400,
      code: "INVALID_ALLOCATION",
      fields: {
        p9: "Property not in round",
        p1: "Property allocated more than once",
        p2: "Technician not in technicianIds",
      },
    });
    expect(prisma.roundTechnician.deleteMany).not.toHaveBeenCalled();
  });

  it("dryRun returns the same result but rolls the transaction back", async () => {
    const prisma = splitPrisma([tech("t1")], [roundProperty("p1", "1 High St", [20])]);
    let rejected: unknown;
    mock(prisma.$transaction).mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
      try {
        return await fn(prisma);
      } catch (e) {
        rejected = e; // a real interactive transaction rolls back here
        throw e;
      }
    });
    restampFutureVisits.mockResolvedValue(3);

    const result = await createRoundService(prisma).setTechnicians("r1", ["t1"], undefined, { dryRun: true });

    expect(result).toEqual({
      roundId: "r1",
      allocation: [{ technicianId: "t1", name: "Tech t1", propertyIds: ["p1"], stops: 1, value: "20.00" }],
      visitsUpdated: 3,
    });
    expect(rejected).toBeInstanceOf(Error);
  });

  it("propagates a restamp failure (the transaction rolls back)", async () => {
    const prisma = splitPrisma([tech("t1")], []);
    restampFutureVisits.mockRejectedValue(new Error("db down"));
    await expect(createRoundService(prisma).setTechnicians("r1", ["t1"])).rejects.toThrow("db down");
  });
});

describe("getAllocation", () => {
  function allocationPrisma(techIds: string[], properties: ReturnType<typeof roundProperty>[]) {
    const prisma = makePrisma();
    mock(prisma.round.findUnique).mockResolvedValue({ id: "r1" });
    mock(prisma.roundTechnician.findMany).mockResolvedValue(
      techIds.map((id) => ({ technician: { id, name: `Tech ${id}` } }))
    );
    mock(prisma.property.findMany).mockResolvedValue(properties);
    return prisma;
  }

  it("404s when the round does not exist", async () => {
    const prisma = makePrisma();
    mock(prisma.round.findUnique).mockResolvedValue(null);
    await expect(createRoundService(prisma).getAllocation("missing")).rejects.toMatchObject({ statusCode: 404 });
  });

  it("SINGLE: the sole technician gets every property, assigned or not", async () => {
    const prisma = allocationPrisma(["t1"], [roundProperty("p1", "1 High St", [10]), roundProperty("p2", "2 High St", [], "gone")]);

    const result = await createRoundService(prisma).getAllocation("r1");

    expect(result).toEqual({
      mode: "SINGLE",
      allocation: [{ technicianId: "t1", name: "Tech t1", propertyIds: ["p1", "p2"], stops: 2, value: "10.00" }],
    });
  });

  it("no technicians: SINGLE with an empty allocation", async () => {
    const prisma = allocationPrisma([], [roundProperty("p1", "1 High St")]);
    expect(await createRoundService(prisma).getAllocation("r1")).toEqual({ mode: "SINGLE", allocation: [] });
  });

  it("AUTO when the stored allocation matches the auto split", async () => {
    const prisma = allocationPrisma(["t2", "t1"], [
      roundProperty("a1", "1 Acre Rd", [], "t1"),
      roundProperty("b1", "1 Bell St", [], "t2"),
    ]);
    const result = await createRoundService(prisma).getAllocation("r1");
    expect(result.mode).toBe("AUTO");
    expect(result.allocation.map((a) => [a.technicianId, a.propertyIds])).toEqual([["t2", ["b1"]], ["t1", ["a1"]]]);
  });

  it("MANUAL when it doesn't", async () => {
    const prisma = allocationPrisma(["t1", "t2"], [
      roundProperty("a1", "1 Acre Rd", [], "t2"),
      roundProperty("b1", "1 Bell St", [], "t1"),
    ]);
    expect((await createRoundService(prisma).getAllocation("r1")).mode).toBe("MANUAL");
  });
});

// ---- reassign (GAP-013) ----------------------------------------------------

describe("reassignTechnician (date / unassigned / permanent)", () => {
  function reassignPrisma() {
    const prisma = makePrisma();
    mock(prisma.round.findUnique).mockResolvedValue({ id: "r1" });
    mock(prisma.technician.findUnique).mockResolvedValue({ id: "t2", active: true, profileId: "p2" });
    mock(prisma.visit.updateMany).mockResolvedValue({ count: 2 });
    return prisma;
  }
  const futureDate = () => {
    const d = new Date(Date.now() + 7 * 86_400_000);
    d.setUTCHours(0, 0, 0, 0);
    return d;
  };

  it("moves the date's unassigned visits when fromTechnicianId is null", async () => {
    const prisma = reassignPrisma();
    const date = futureDate();

    const result = await createRoundService(prisma).reassignTechnician("r1", {
      date, fromTechnicianId: null, toTechnicianId: "t2", scope: "REMAINING", notify: false,
    });

    expect(result).toEqual({ updated: 2 });
    expect(prisma.visit.updateMany).toHaveBeenCalledWith({
      where: {
        roundId: "r1",
        technicianId: null,
        date: { gte: date, lt: new Date(date.getTime() + 86_400_000) },
        status: { in: ["SCHEDULED", "IN_PROGRESS"] },
      },
      data: { technicianId: "t2", technicianOverride: true },
    });
  });

  it("does not check Close Day for a future date", async () => {
    const prisma = reassignPrisma();
    mock(prisma.businessSettings.findFirst).mockResolvedValue({ lastClosedDate: new Date().toISOString().slice(0, 10) });
    await expect(
      createRoundService(prisma).reassignTechnician("r1", {
        date: futureDate(), fromTechnicianId: "t1", toTechnicianId: "t2", scope: "ALL", notify: false,
      })
    ).resolves.toEqual({ updated: 2 });
  });

  it("400s for a past date", async () => {
    const prisma = reassignPrisma();
    await expect(
      createRoundService(prisma).reassignTechnician("r1", {
        date: new Date("2020-01-01T00:00:00.000Z"), fromTechnicianId: null, toTechnicianId: "t2", scope: "ALL", notify: false,
      })
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("404s when the target technician is missing, 400s when inactive", async () => {
    const prisma = reassignPrisma();
    const input = { fromTechnicianId: null, toTechnicianId: "t2", scope: "ALL" as const, notify: false };
    mock(prisma.technician.findUnique).mockResolvedValueOnce(null);
    await expect(createRoundService(prisma).reassignTechnician("r1", input)).rejects.toMatchObject({ statusCode: 404 });
    mock(prisma.technician.findUnique).mockResolvedValueOnce({ id: "t2", active: false, profileId: "p2" });
    await expect(createRoundService(prisma).reassignTechnician("r1", input)).rejects.toMatchObject({ statusCode: 400 });
  });

  it("permanent: moves the properties' allocation, adds the target to the round and restamps", async () => {
    const prisma = reassignPrisma();
    mock(prisma.visit.findMany).mockResolvedValue([
      { id: "v1", propertyId: "p1" },
      { id: "v2", propertyId: "p1" },
      { id: "v3", propertyId: "p2" },
    ]);
    mock(prisma.visit.updateMany).mockResolvedValue({ count: 3 });
    restampFutureVisits.mockResolvedValue(5);

    const result = await createRoundService(prisma).reassignTechnician("r1", {
      fromTechnicianId: "t1", toTechnicianId: "t2", scope: "REMAINING", permanent: true, notify: false,
    });

    expect(result).toEqual({ updated: 8 });
    expect(prisma.roundTechnician.createMany).toHaveBeenCalledWith({
      data: [{ roundId: "r1", technicianId: "t2" }],
      skipDuplicates: true,
    });
    expect(prisma.property.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["p1", "p2"] } },
      data: { assignedTechnicianId: "t2" },
    });
    expect(prisma.visit.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["v1", "v2", "v3"] } },
      data: { technicianId: "t2", technicianOverride: false },
    });
    expect(restampFutureVisits).toHaveBeenCalledWith(prisma, "r1", expect.any(Date));
  });
});

// ---- A4: planner/today readers exclude CANCELLED ---------------------------

it("planner and today-panel queries exclude CANCELLED visits", async () => {
  const prisma = makePrisma();
  mock(prisma.round.findUnique).mockResolvedValue({ id: "r1", name: "Round 1" });
  mock(prisma.visit.findMany).mockResolvedValue([]);
  const svc = createRoundService(prisma);
  const from = new Date("2026-01-01T00:00:00.000Z");

  await svc.listOccurrences("r1", from);
  await svc.listOccurrencesForRounds(["r1"], from);
  await svc.getOccurrence("r1", "2026-01-01");
  await svc.listDayStopsForRounds(["r1"], "2026-01-01");
  await svc.getTodayPanel("r1");

  for (const call of mock(prisma.visit.findMany).mock.calls) {
    expect(call[0].where.status).toEqual({ not: "CANCELLED" });
  }
  expect(mock(prisma.visit.findMany).mock.calls).toHaveLength(5);
});
