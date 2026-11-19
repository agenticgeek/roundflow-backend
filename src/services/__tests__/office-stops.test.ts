import { beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma, VisitStatus } from "../../generated/tenant-client";

// Office views show one stop per property per day per technician (docs/PROPERTY_STOPS_PLAN_2026-11-19.md §7.7).

vi.mock("../message.service", () => ({ createMessageService: vi.fn(() => ({ send: vi.fn() })) }));
vi.mock("../notify", async () => (await import("../../test/notify-mock.js")).notifyMockModule());
const projectOccurrences = vi.fn();
vi.mock("../round-projection", () => ({ projectOccurrences: (...a: unknown[]) => projectOccurrences(...a) }));

import { createRoundService } from "../round.service";
import { createTodayService } from "../today.service";

const DAY = "2026-11-19";
const date = new Date(`${DAY}T00:00:00.000Z`);
let seq = 0;

const property = (id: string) => ({
  id,
  propertyName: null,
  addressLine: `${id} High St`,
  postcode: "NE1",
  latitude: 55,
  longitude: -1,
  geocodePrecision: "ROOFTOP",
  customer: { name: `Customer ${id}` },
});

function visit(id: string, propertyId: string, over: Record<string, unknown> = {}) {
  seq += 1;
  return {
    id,
    date,
    createdAt: new Date(Date.UTC(2026, 10, 1, 0, 0, seq)),
    propertyId,
    roundId: "r1",
    round: { id: "r1", name: "Monday" },
    status: VisitStatus.SCHEDULED,
    price: new Prisma.Decimal(20),
    paymentHold: false,
    carriedOverFromDate: null,
    completedAt: null,
    technicianId: "t1",
    technician: { id: "t1", name: "Sam" },
    service: { name: `Service ${id}` },
    issues: [],
    _count: { issues: 0 },
    property: property(propertyId),
    ...over,
  };
}

function makePrisma(visits: unknown[]) {
  const prisma: any = {
    round: { findUnique: vi.fn().mockResolvedValue({ id: "r1", name: "Monday" }) },
    visit: { findMany: vi.fn().mockResolvedValue(visits) },
    businessSettings: { findFirst: vi.fn().mockResolvedValue(null) },
    businessClosure: { findMany: vi.fn().mockResolvedValue([]) },
  };
  return prisma;
}

beforeEach(() => {
  vi.clearAllMocks();
  projectOccurrences.mockResolvedValue(new Map());
});

describe("planner day stops", () => {
  const visits = () => [
    visit("v1", "p1"),
    visit("v2", "p1", { price: new Prisma.Decimal(10), service: { name: "Gutter clear" }, status: VisitStatus.COMPLETED }),
    visit("v3", "p2"),
    visit("v4", "p1", { technicianId: "t2", technician: { id: "t2", name: "Al" } }),
  ];

  it("getOccurrence: one stop per property and technician, with its services and total", async () => {
    const out = await createRoundService(makePrisma(visits())).getOccurrence("r1", DAY);
    expect(out.stops.map((s) => [s.visitId, s.stopKey, s.price, s.status])).toEqual([
      ["v1", "p1|2026-11-19|t1", 30, VisitStatus.SCHEDULED],
      ["v3", "p2|2026-11-19|t1", 20, VisitStatus.SCHEDULED],
      ["v4", "p1|2026-11-19|t2", 20, VisitStatus.SCHEDULED],
    ]);
    expect(out.stops[0].services).toEqual([
      { visitId: "v1", serviceName: "Service v1", status: VisitStatus.SCHEDULED, price: 20 },
      { visitId: "v2", serviceName: "Gutter clear", status: VisitStatus.COMPLETED, price: 10 },
    ]);
    expect(out.summary).toMatchObject({ stopCount: 3, completedCount: 0, totalValue: 70 });
  });

  it("listDayStopsForRounds groups the same way", async () => {
    const [round] = await createRoundService(makePrisma(visits())).listDayStopsForRounds(["r1"], DAY);
    expect(round.stops).toHaveLength(3);
    expect(round.stops[0].services).toHaveLength(2);
  });

  it("listOccurrences counts stops, and a stop is complete once nothing in it is open", async () => {
    const prisma = makePrisma([
      visit("v1", "p1", { status: VisitStatus.COMPLETED }),
      visit("v2", "p1", { status: VisitStatus.SKIPPED }),
      visit("v3", "p2", { status: VisitStatus.COMPLETED }),
      visit("v4", "p2"),
    ]);
    const [occ] = await createRoundService(prisma).listOccurrences("r1", date, date);
    expect(occ).toMatchObject({ date: DAY, stopCount: 2, completedCount: 1, completionPct: 50, totalValue: 80 });
  });

  it("listOccurrencesForRounds counts stops too", async () => {
    const prisma = makePrisma([visit("v1", "p1"), visit("v2", "p1"), visit("v3", "p2")]);
    const [round] = await createRoundService(prisma).listOccurrencesForRounds(["r1"], date, date);
    expect(round.occurrences[0].stopCount).toBe(2);
  });
});

describe("round today panel (Today's Work round detail)", () => {
  it("one stop per property with services; progress counts stops", async () => {
    const prisma = makePrisma([
      visit("v1", "p1", { status: VisitStatus.COMPLETED }),
      visit("v2", "p1", { status: VisitStatus.SKIPPED, issues: [{ id: "i1", note: "Blocked" }] }),
      visit("v3", "p2"),
    ]);
    const panel = await createRoundService(prisma).getTodayPanel("r1");
    expect(panel.progress).toEqual({ total: 2, completed: 1, skipped: 0, issues: 1 });
    expect(panel.stops.map((s) => [s.visitId, s.stopKey, s.status])).toEqual([
      ["v1", "p1|2026-11-19|t1", VisitStatus.COMPLETED],
      ["v3", "p2|2026-11-19|t1", VisitStatus.SCHEDULED],
    ]);
    expect(panel.stops[0]).toMatchObject({ hasIssue: true, issueFlag: "Blocked", price: 40 });
    expect(panel.stops[0].services.map((s) => s.visitId)).toEqual(["v1", "v2"]);
  });
});

describe("GET /today counts stops", () => {
  it("KPIs, round rows and technician cards count doors, values stay money sums", async () => {
    const prisma = makePrisma([
      visit("v1", "p1", { status: VisitStatus.COMPLETED }),
      visit("v2", "p1", { status: VisitStatus.COMPLETED }),
      visit("v3", "p2", { status: VisitStatus.IN_PROGRESS }),
      visit("v4", "p2"),
      visit("v5", "p3", { status: VisitStatus.SKIPPED }),
    ]);
    const out = await createTodayService(prisma).getTodaysWork();
    expect(out.kpi).toMatchObject({ totalStops: 3, completed: 1, inProgress: 1, skipped: 1, valueCompleted: 40 });
    expect(out.rounds[0]).toMatchObject({ total: 3, completed: 1, skipped: 1, scheduledValue: 100, completedValue: 40 });
    expect(out.technicians[0]).toMatchObject({ completed: 1, remaining: 1 });
  });
});
