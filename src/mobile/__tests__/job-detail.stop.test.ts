import { beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma, VisitStatus } from "../../generated/tenant-client";

// GET /mobile/visits/:id returns the whole stop (docs/PROPERTY_STOPS_PLAN_2026-11-19.md §7.4).

vi.mock("../services/debt-gate", () => ({ evaluateDebtGate: async () => ({ canStart: true, blockReason: null }) }));

import { createJobDetailService } from "../services/job-detail.service";

const DAY = new Date("2026-11-19T00:00:00.000Z");
const at = (s: number) => new Date(Date.UTC(2026, 10, 1, 0, 0, s));

const detailVisit = {
  id: "v2",
  status: VisitStatus.SCHEDULED,
  date: DAY,
  price: new Prisma.Decimal(10),
  paymentMethod: null,
  propertyId: "p1",
  technicianId: "tech-1",
  roundId: "r1",
  startedAt: null,
  arrivedAt: null,
  completedAt: null,
  servicePlan: null,
  property: {
    id: "p1",
    addressLine: "1 High St",
    postcode: "NE1",
    latitude: 55,
    longitude: -1,
    geocodePrecision: "ROOFTOP",
    accessNotes: null,
    riskNotes: null,
    customer: { id: "c1", name: "Jo", badDebt: false, paymentMethod: "CASH", invoices: [] },
    notes: [],
    photos: [],
  },
};

const stopVisit = (id: string, s: number, over: Record<string, unknown> = {}) => ({
  id,
  status: VisitStatus.SCHEDULED,
  createdAt: at(s),
  price: new Prisma.Decimal(20),
  originalPrice: null,
  priceAdjustmentReason: null,
  skipReason: null,
  isOneOff: false,
  carriedOverFromDate: null,
  service: { name: `Service ${id}` },
  ...over,
});

function makePrisma() {
  const prisma: any = {
    visit: {
      findUnique: vi.fn().mockResolvedValue(detailVisit),
      findFirst: vi.fn().mockResolvedValue(null),
      findMany: vi.fn(async (args: any) => {
        if (args.where.propertyId) {
          // the stop: same property, day and technician
          return [stopVisit("v1", 1), stopVisit("v2", 2, { price: new Prisma.Decimal(10) }), stopVisit("v3", 3, { status: VisitStatus.SKIPPED, skipReason: "Blocked" })];
        }
        // the technician's round that day, in list order
        return [
          { id: "a1", propertyId: "p0", createdAt: at(0) },
          { id: "v1", propertyId: "p1", createdAt: at(1) },
          { id: "v2", propertyId: "p1", createdAt: at(2) },
          { id: "v3", propertyId: "p1", createdAt: at(3) },
          { id: "b1", propertyId: "p9", createdAt: at(4) },
        ];
      }),
    },
    technician: { findMany: vi.fn().mockResolvedValue([]) },
    businessSettings: { findFirst: vi.fn().mockResolvedValue({ vatInInvoices: true, vatRate: 20 }) },
  };
  return prisma;
}

beforeEach(() => vi.clearAllMocks());

describe("getVisitDetail stop block", () => {
  it("lists every service at the stop with the lead visit and totals", async () => {
    const prisma = makePrisma();
    const detail = await createJobDetailService(prisma).getVisitDetail("v2");
    expect(detail.stop).toEqual({
      stopKey: "p1|2026-11-19|tech-1",
      leadVisitId: "v1",
      price: 30,
      grossTotal: 36,
      services: [
        expect.objectContaining({ visitId: "v1", serviceName: "Service v1", status: VisitStatus.SCHEDULED, price: 20, grossTotal: 24 }),
        expect.objectContaining({ visitId: "v2", price: 10, grossTotal: 12 }),
        expect.objectContaining({ visitId: "v3", status: VisitStatus.SKIPPED, skipReason: "Blocked" }),
      ],
    });
  });

  it("counts the round position by stop", async () => {
    const prisma = makePrisma();
    const detail = await createJobDetailService(prisma).getVisitDetail("v2");
    expect(detail.roundPosition).toEqual({ position: 2, total: 3 });
  });
});
