import { beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma, VisitStatus } from "../../generated/tenant-client";

// Technician app reads and actions by stop (property + day + technician).
// docs/PROPERTY_STOPS_PLAN_2026-11-19.md §7.4

vi.mock("../../services/notify", async () => (await import("../../test/notify-mock.js")).notifyMockModule());
const START = new Date("2026-11-19T00:00:00.000Z");
const END = new Date("2026-11-20T00:00:00.000Z");
vi.mock("../../services/business-time", () => ({ tenantTodayRange: async () => ({ start: START, end: END }) }));
const evaluateDebtGate = vi.fn();
vi.mock("../services/debt-gate", () => ({ evaluateDebtGate: (...a: unknown[]) => evaluateDebtGate(...a) }));

import { createHomeService, toRow } from "../services/home.service";
import { createJobTrackerService } from "../services/job-tracker.service";
import { createDayCloseService } from "../services/day-close.service";
import { notifyAdmins } from "../../services/notify";

const notifyAdminsMock = vi.mocked(notifyAdmins);

const property = (id: string, name = "Jo", address = `${id} street`) => ({
  id,
  addressLine: address,
  postcode: "NE1 1AA",
  latitude: 55,
  longitude: -1.6,
  geocodePrecision: "ROOFTOP",
  customer: { id: `c-${id}`, name, badDebt: false, paymentMethod: "CASH" },
  notes: [],
});

let seq = 0;
function row(id: string, prop: ReturnType<typeof property>, over: Record<string, unknown> = {}) {
  seq += 1;
  return {
    id,
    status: VisitStatus.SCHEDULED,
    date: START,
    createdAt: new Date(Date.UTC(2026, 10, 1, 0, 0, seq)),
    price: new Prisma.Decimal(20),
    originalPrice: null,
    priceAdjustmentReason: null,
    skipReason: null,
    isOneOff: false,
    paymentMethod: null,
    propertyId: prop.id,
    technicianId: "tech-1",
    roundId: "r1",
    round: { id: "r1", name: "Monday" },
    service: { id: `s-${id}`, name: `Service ${id}` },
    servicePlan: { paymentMethod: null },
    payment: null,
    carriedOverFromDate: null,
    notes: null,
    startedAt: null,
    arrivedAt: null,
    completedAt: null,
    _count: { issues: 0 },
    property: prop,
    ...over,
  };
}

function makePrisma(visits: unknown[] = []) {
  return {
    technician: { findUnique: vi.fn().mockResolvedValue({ id: "tech-1", name: "Sam" }) },
    visit: {
      findMany: vi.fn().mockResolvedValue(visits),
      findUnique: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    technicianDayClose: { findUnique: vi.fn().mockResolvedValue(null) },
    businessSettings: { findFirst: vi.fn().mockResolvedValue({ vatInInvoices: true, vatRate: 20 }) },
  } as any;
}

beforeEach(() => {
  vi.clearAllMocks();
  evaluateDebtGate.mockResolvedValue({ canStart: true, blockReason: null });
});

describe("toRow", () => {
  it("adds the property id and the stop key", () => {
    const p = property("p1");
    expect(toRow(row("v1", p) as any, 1)).toMatchObject({ visitId: "v1", propertyId: "p1", stopKey: "p1|2026-11-19|tech-1" });
  });
});

describe("GET /mobile/visits/today rows carry their stop", () => {
  it("numbers positions per stop within the round; every service in a stop shares the number", async () => {
    const p1 = property("p1", "Jo");
    const p2 = property("p2", "Al");
    const prisma = makePrisma([row("v1", p1), row("v2", p2), row("v3", p1), row("v4", p1, { roundId: null, round: null })]);
    const rows = await createHomeService(prisma).getTodayVisits("profile-1");
    expect(prisma.visit.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ technicianId: "tech-1", status: { not: VisitStatus.CANCELLED } }) }),
    );
    expect(rows.map((r) => [r.visitId, r.stopKey, r.position])).toEqual([
      ["v1", "p1|2026-11-19|tech-1", 1],
      ["v2", "p2|2026-11-19|tech-1", 2],
      ["v3", "p1|2026-11-19|tech-1", 1],
      ["v4", "p1|2026-11-19|tech-1", null],
    ]);
  });

  it("is empty for an unknown technician", async () => {
    const prisma = makePrisma();
    prisma.technician.findUnique.mockResolvedValue(null);
    await expect(createHomeService(prisma).getTodayVisits("x")).resolves.toEqual([]);
  });
});

describe("counts by stop", () => {
  it("GET /mobile/rounds/today counts stops, not services", async () => {
    const p1 = property("p1");
    const p2 = property("p2");
    const prisma = makePrisma([
      row("v1", p1, { status: VisitStatus.COMPLETED }),
      row("v2", p1, { status: VisitStatus.COMPLETED }),
      row("v3", p2),
      row("v4", p2, { status: VisitStatus.COMPLETED }),
    ]);
    const [round] = await createHomeService(prisma).getRoundsSummary("profile-1");
    expect(round).toMatchObject({ totalCount: 2, completedCount: 1, expectedRevenue: 80, earnedRevenue: 60 });
  });

  it("GET /mobile/completions counts stops; its rows stay per completed visit", async () => {
    const p1 = property("p1");
    const p2 = property("p2");
    const p3 = property("p3");
    const prisma = makePrisma();
    prisma.visit.findMany
      .mockResolvedValueOnce([
        row("v1", p1, { status: VisitStatus.COMPLETED }),
        row("v2", p1, { status: VisitStatus.SKIPPED }),
        row("v3", p2, { status: VisitStatus.SKIPPED }),
        row("v4", p3),
      ])
      .mockResolvedValueOnce([]); // last week
    const out = await createHomeService(prisma).getCompletions("profile-1");
    expect(out).toMatchObject({ completedCount: 1, skippedCount: 1, totalCount: 3, revenueToday: 20 });
    expect(out.visits.map((v) => v.visitId)).toEqual(["v1"]);
  });

  it("GET /mobile/day counts stops and lists each unfinished stop once with its services", async () => {
    const p1 = property("p1");
    const p2 = property("p2");
    const prisma = makePrisma([
      { ...row("v1", p1, { status: VisitStatus.COMPLETED }) },
      { ...row("v2", p1) },
      { ...row("v3", p1, { service: { id: "s", name: "Gutter clear" } }) },
      { ...row("v4", p2, { status: VisitStatus.COMPLETED }) },
    ]);
    const day = await createDayCloseService(prisma).getStatus("tech-1");
    expect(day.completedCount).toBe(1);
    expect(day.remaining).toEqual([
      expect.objectContaining({ visitId: "v1", stopKey: "p1|2026-11-19|tech-1", serviceNames: ["Service v2", "Gutter clear"], status: "SCHEDULED" }),
    ]);
  });
});

describe("start / arrive / skip cover the whole stop", () => {
  const p1 = property("p1");
  const stopRows = () => [row("v1", p1), row("v2", p1), row("v3", p1, { status: VisitStatus.COMPLETED })];

  it("start moves every SCHEDULED service to IN_PROGRESS and checks the debt gate once", async () => {
    const prisma = makePrisma(stopRows());
    prisma.visit.findUnique.mockResolvedValue({ ...row("v2", p1), property: { customerId: "c-p1" } });
    await createJobTrackerService(prisma).startVisit("v2", "profile-1");
    expect(evaluateDebtGate).toHaveBeenCalledTimes(1);
    expect(prisma.visit.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["v1", "v2"] }, status: VisitStatus.SCHEDULED },
      data: { status: VisitStatus.IN_PROGRESS, startedAt: expect.any(Date) },
    });
  });

  it("start is a 409 only when nothing in the stop is SCHEDULED", async () => {
    const prisma = makePrisma([row("v1", p1, { status: VisitStatus.IN_PROGRESS }), row("v2", p1, { status: VisitStatus.COMPLETED })]);
    prisma.visit.findUnique.mockResolvedValue({ ...row("v1", p1, { status: VisitStatus.IN_PROGRESS }), property: { customerId: "c-p1" } });
    await expect(createJobTrackerService(prisma).startVisit("v1", "profile-1")).rejects.toMatchObject({ statusCode: 409 });
  });

  it("start is still blocked by debt (403) for the whole stop", async () => {
    evaluateDebtGate.mockResolvedValue({ canStart: false, blockReason: "Outstanding debt" });
    const prisma = makePrisma(stopRows());
    prisma.visit.findUnique.mockResolvedValue({ ...row("v1", p1), property: { customerId: "c-p1" } });
    await expect(createJobTrackerService(prisma).startVisit("v1", "profile-1")).rejects.toMatchObject({ statusCode: 403 });
    expect(prisma.visit.updateMany).not.toHaveBeenCalled();
  });

  it("arrive stamps every IN_PROGRESS service", async () => {
    const prisma = makePrisma([row("v1", p1, { status: VisitStatus.IN_PROGRESS }), row("v2", p1, { status: VisitStatus.IN_PROGRESS }), row("v3", p1, { status: VisitStatus.COMPLETED })]);
    prisma.visit.findUnique.mockResolvedValue(row("v1", p1, { status: VisitStatus.IN_PROGRESS }));
    await createJobTrackerService(prisma).markArrived("v1");
    expect(prisma.visit.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["v1", "v2"] }, status: VisitStatus.IN_PROGRESS },
      data: { arrivedAt: expect.any(Date) },
    });
  });

  it("skip with stop: true skips every open service with one office notification", async () => {
    const prisma = makePrisma(stopRows());
    prisma.visit.findUnique.mockResolvedValue(row("v1", p1));
    await createJobTrackerService(prisma).skipVisit("v1", "NO_ACCESS", "Locked gate", { stop: true });
    expect(prisma.visit.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["v1", "v2"] }, status: { in: [VisitStatus.SCHEDULED, VisitStatus.IN_PROGRESS] } },
      data: { status: VisitStatus.SKIPPED, skipReason: "NO_ACCESS: Locked gate" },
    });
    expect(notifyAdminsMock).toHaveBeenCalledTimes(1);
  });

  it("skip without stop skips just that service (older app builds)", async () => {
    const prisma = makePrisma(stopRows());
    prisma.visit.findUnique.mockResolvedValue(row("v1", p1));
    await createJobTrackerService(prisma).skipVisit("v1", "NO_ACCESS");
    expect(prisma.visit.update).toHaveBeenCalledWith({ where: { id: "v1" }, data: { status: VisitStatus.SKIPPED, skipReason: "NO_ACCESS" } });
    expect(prisma.visit.updateMany).not.toHaveBeenCalled();
  });
});
