import { it, expect, vi, describe, beforeEach } from "vitest";
import request from "supertest";
import express from "express";

const tenantToday = vi.fn();
vi.mock("../../services/business-time", () => ({
  tenantToday: (...a: unknown[]) => tenantToday(...a),
  tenantTodayRange: vi.fn(),
}));
vi.mock("../../services/settings.service", () => ({
  getCachedBusinessSettings: vi.fn().mockResolvedValue({ defaultWorkingDays: [], timezone: null, lastClosedDate: null, businessName: "Shine" }),
}));
vi.mock("../../services/notify", async () => (await import("../../test/notify-mock.js")).notifyMockModule());
vi.mock("../../services/message.service", () => ({ createMessageService: vi.fn(() => ({ broadcast: vi.fn() })) }));
vi.mock("../../services/visit.service", () => ({ createVisitService: vi.fn(() => ({})) }));
vi.mock("../../services/reports.service", () => ({ createReportsService: vi.fn(() => ({})) }));
vi.mock("../../services/visit-completion", () => ({ createVisitCompletionService: vi.fn(() => ({})), parseCompletionPayment: vi.fn() }));
vi.mock("../../services/visit-photos.service", () => ({ createVisitPhotosService: vi.fn(() => ({})) }));
vi.mock("../../middleware/requireAuth", () => ({ requireAuth: (_q: any, _s: any, n: any) => n() }));
vi.mock("../../middleware/requireTenantAccess", () => ({ requireTenantAccess: (_q: any, _s: any, n: any) => n() }));
vi.mock("../../middleware/requireRole", () => ({ requireBusinessAccess: () => (_q: any, _s: any, n: any) => n() }));

import { visitsRouter } from "../visits";
import { errorHandler } from "../../lib/error-handler";

const d = (s: string) => new Date(`${s}T00:00:00.000Z`);
const WED = d("2026-12-23");
const XMAS = { id: "xmas", label: "Christmas", startDate: d("2026-12-24"), endDate: d("2027-01-03"), mode: "MOVE", roundIds: [] as string[] };
const WARNING = { code: "DATE_IN_CLOSURE", closureId: "xmas", label: "Christmas", startDate: "2026-12-24", endDate: "2027-01-03" };

function makePrisma() {
  const tx = {
    visit: {
      update: vi.fn().mockResolvedValue({}),
      findMany: vi.fn().mockResolvedValue([
        {
          id: "v1", date: WED, status: "SCHEDULED", technicianId: null, roundId: "r1", propertyId: "p1", technician: null,
          property: { addressLine: "1 High St", customer: { id: "c1", name: "Jane", phone: "07", email: null, ghlContactId: null, messagesOptOut: false } },
        },
      ]),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    technicianAvailability: { findMany: vi.fn().mockResolvedValue([]) },
    integrationOutbox: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
    activityLog: { create: vi.fn().mockResolvedValue({}) },
  };
  return {
    visit: { findUnique: vi.fn().mockResolvedValue({ id: "v1", status: "SCHEDULED", date: WED, technicianId: null, roundId: "r1", propertyId: "p1" }) },
    businessClosure: { findMany: vi.fn().mockResolvedValue([XMAS]) },
    $transaction: vi.fn((cb: (t: typeof tx) => unknown) => cb(tx)),
  };
}

function makeApp(role: string, prisma: unknown) {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => { req.tenantPrisma = prisma; req.profile = { id: "u1", role }; next(); });
  app.use("/visits", visitsRouter);
  app.use(errorHandler);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  tenantToday.mockResolvedValue(WED);
});

describe.each(["MANAGER", "ADMIN"])("closure warnings as %s", (role) => {
  it("W1: PATCH reschedule into a closure is 200 with warnings; W2: outside it has no warnings field", async () => {
    const hit = await request(makeApp(role, makePrisma())).patch("/visits/v1/reschedule").send({ date: "2026-12-30" });
    expect(hit.status).toBe(200);
    expect(hit.body).toEqual({ id: "v1", status: "SCHEDULED", date: "2026-12-30", warnings: [WARNING] });

    const miss = await request(makeApp(role, makePrisma())).patch("/visits/v1/reschedule").send({ date: "2027-01-05" });
    expect(miss.status).toBe(200);
    expect(miss.body).toEqual({ id: "v1", status: "SCHEDULED", date: "2027-01-05" });
  });

  it("W3: POST carryover onto a closed day is 200 with warnings (also dryRun)", async () => {
    for (const dryRun of [false, true]) {
      const res = await request(makeApp(role, makePrisma())).post("/visits/carryover").send({ date: "2026-12-23", target: "NEXT_WORKING_DAY", dryRun });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ moved: 1, targetDate: "2026-12-24", dryRun, warnings: [WARNING] });
    }
  });

  it("GET carryover/options marks the option inside a closure with { closureId, label }", async () => {
    const res = await request(makeApp(role, makePrisma())).get("/visits/carryover/options").query({ date: "2026-12-23" });
    expect(res.status).toBe(200);
    expect(res.body.options).toEqual([
      { key: "NEXT_WORKING_DAY", date: "2026-12-24", label: "Thursday 24 Dec", default: true, closure: { closureId: "xmas", label: "Christmas" } },
    ]);
  });
});
