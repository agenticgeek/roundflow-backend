import { it, expect, vi } from "vitest";
import request from "supertest";
import express from "express";

// ── shared mock factories ──────────────────────────────────────────────────

const mockLogActivity = vi.fn().mockResolvedValue(undefined);

vi.mock("../../services/reports.service", () => ({
  createReportsService: vi.fn(() => ({ logActivity: mockLogActivity })),
}));

vi.mock("../../services/customer.service", () => ({
  createCustomerService: vi.fn(() => ({
    createProperty: vi.fn().mockResolvedValue({ customerId: "c1", propertyId: "p1", servicePlanId: "sp1", assigned: false }),
  })),
}));

vi.mock("../../services/round.service", () => ({
  createRoundService: vi.fn(() => ({
    updateRound: vi.fn().mockResolvedValue({ id: "r1", name: "Test Round" }),
    setTechnicians: vi.fn().mockResolvedValue({ id: "r1", name: "Test Round" }),
    reassignTechnician: vi.fn().mockResolvedValue({ updated: 2 }),
    pushMissedJobs: vi.fn().mockResolvedValue({ pushed: 3 }),
  })),
}));

vi.mock("../../services/today.service", () => ({
  createTodayService: vi.fn(() => ({
    closeDay: vi.fn().mockResolvedValue({ closed: true }),
  })),
}));

vi.mock("../../middleware/requireAuth", () => ({
  requireAuth: (_req: any, _res: any, next: any) => {
    _req.user = { supabaseUserId: "u1", email: "admin@test.com" };
    next();
  },
}));
vi.mock("../../middleware/requireTenantAccess", () => ({
  requireTenantAccess: (_req: any, _res: any, next: any) => {
    _req.tenantPrisma = {};
    _req.profile = { id: "p1", role: "ADMIN" };
    next();
  },
}));
vi.mock("../../middleware/requireRole", () => ({
  requireBusinessAccess: () => (_req: any, _res: any, next: any) => next(),
  requireRole: () => (_req: any, _res: any, next: any) => next(),
}));

// ── app builders ───────────────────────────────────────────────────────────

import { propertiesRouter } from "../properties";
import { roundsRouter } from "../rounds";
import { todayRouter } from "../today";

function makePropertiesApp() {
  const app = express();
  app.use(express.json());
  app.use("/properties", propertiesRouter);
  return app;
}

function makeRoundsApp() {
  const app = express();
  app.use(express.json());
  app.use("/rounds", roundsRouter);
  return app;
}

function makeTodayApp() {
  const app = express();
  app.use(express.json());
  app.use("/today", todayRouter);
  return app;
}

// ── tests ──────────────────────────────────────────────────────────────────

it("POST /properties logActivity message includes the address", async () => {
  mockLogActivity.mockClear();
  const app = makePropertiesApp();
  await request(app).post("/properties").send({
    customerName: "Jane Smith",
    addressLine: "18 Green Lane",
    postcode: "NE61 1AB",
    serviceAreaId: "sa1",
    price: 35,
  });
  expect(mockLogActivity.mock.calls[0][1]).toContain("18 Green Lane");
});

it("POST /today/close calls logActivity with type DAY_CLOSED", async () => {
  mockLogActivity.mockClear();
  const app = makeTodayApp();
  await request(app).post("/today/close").send({ unfinishedAction: "push_to_tomorrow" });
  expect(mockLogActivity).toHaveBeenCalled();
  expect(mockLogActivity.mock.calls[0][0]).toBe("DAY_CLOSED");
});

it("POST /rounds/:id/push-missed calls logActivity with type VISITS_PUSHED", async () => {
  mockLogActivity.mockClear();
  const app = makeRoundsApp();
  await request(app).post("/rounds/r1/push-missed").send({
    newDate: "2026-08-15",
    reason: "Weather",
    notifyCustomers: false,
  });
  expect(mockLogActivity).toHaveBeenCalled();
  expect(mockLogActivity.mock.calls[0][0]).toBe("VISITS_PUSHED");
});

it("POST /rounds/:id/reassign calls logActivity with type TECHNICIAN_REASSIGNED", async () => {
  mockLogActivity.mockClear();
  const app = makeRoundsApp();
  await request(app).post("/rounds/r1/reassign").send({
    fromTechnicianId: "t1",
    toTechnicianId: "t2",
    scope: "remaining",
    notify: false,
  });
  expect(mockLogActivity).toHaveBeenCalled();
  expect(mockLogActivity.mock.calls[0][0]).toBe("TECHNICIAN_REASSIGNED");
});

it("PUT /rounds/:id/technicians calls logActivity with type TECHNICIAN_ASSIGNED", async () => {
  mockLogActivity.mockClear();
  const app = makeRoundsApp();
  await request(app).put("/rounds/r1/technicians").send({ technicianIds: ["t1"] });
  expect(mockLogActivity).toHaveBeenCalled();
  expect(mockLogActivity.mock.calls[0][0]).toBe("TECHNICIAN_ASSIGNED");
});

it("PATCH /rounds/:id calls logActivity with type ROUND_UPDATED", async () => {
  mockLogActivity.mockClear();
  const app = makeRoundsApp();
  await request(app).patch("/rounds/r1").send({ name: "Monday Round" });
  expect(mockLogActivity).toHaveBeenCalled();
  expect(mockLogActivity.mock.calls[0][0]).toBe("ROUND_UPDATED");
});

it("POST /properties calls logActivity with type PROPERTY_ADDED", async () => {
  mockLogActivity.mockClear();
  const app = makePropertiesApp();
  await request(app).post("/properties").send({
    customerName: "Jane Smith",
    addressLine: "18 Green Lane",
    postcode: "NE61 1AB",
    serviceAreaId: "sa1",
    price: 35,
  });
  expect(mockLogActivity).toHaveBeenCalled();
  expect(mockLogActivity.mock.calls[0][0]).toBe("PROPERTY_ADDED");
});
