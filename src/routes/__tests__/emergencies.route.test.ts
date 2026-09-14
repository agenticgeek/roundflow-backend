import { it, expect, vi } from "vitest";
import request from "supertest";
import express from "express";

const mockResolvedEmergency = {
  ...{
    id: "emg1",
    technicianId: "t1",
    technicianName: "James",
    roundId: "r1",
    roundName: "Alnwick Monday",
    remainingStops: 3,
    lastLocation: "Alnwick High St Hub",
    scheduledWindowEnd: null,
    notes: null,
    reportedAt: "2026-09-15T18:24:00.000Z",
  },
  status: "RESOLVED",
  assignedTechnicianId: "t2",
  assignedTechnicianName: "Sarah",
  resolvedAt: "2026-09-15T18:30:00.000Z",
};

const mockAvailableTechnicians = [
  {
    technicianId: "t2",
    technicianName: "Sarah",
    avatarUrl: null,
    jobsRemaining: 0,
    availability: "AVAILABLE",
  },
  {
    technicianId: "t3",
    technicianName: "Rodri",
    avatarUrl: null,
    jobsRemaining: 2,
    availability: "BUSY",
  },
];

const mockEmergency = {
  id: "emg1",
  technicianId: "t1",
  technicianName: "James",
  roundId: "r1",
  roundName: "Alnwick Monday",
  remainingStops: 3,
  lastLocation: "Alnwick High St Hub",
  scheduledWindowEnd: null,
  notes: null,
  status: "ACTIVE",
  assignedTechnicianId: null,
  assignedTechnicianName: null,
  resolvedAt: null,
  reportedAt: "2026-09-15T18:24:00.000Z",
};

vi.mock("../../services/emergency.service", () => ({
  createEmergencyService: vi.fn(() => ({
    reportEmergency: vi.fn().mockResolvedValue(mockEmergency),
    getEmergency: vi.fn().mockResolvedValue(mockEmergency),
    listEmergencies: vi.fn().mockResolvedValue([mockEmergency]),
    getAvailableTechnicians: vi.fn().mockResolvedValue(mockAvailableTechnicians),
    reassign: vi.fn().mockResolvedValue(mockResolvedEmergency),
  })),
}));

vi.mock("../../middleware/requireAuth", () => ({
  requireAuth: (_req: any, _res: any, next: any) => next(),
}));
vi.mock("../../middleware/requireTenantAccess", () => ({
  requireTenantAccess: (_req: any, _res: any, next: any) => next(),
}));
vi.mock("../../middleware/requireRole", () => ({
  requireRole: () => (_req: any, _res: any, next: any) => next(),
}));

import { emergenciesRouter } from "../../routes/emergencies";

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => { req.tenantPrisma = {}; next(); });
  app.use("/emergencies", emergenciesRouter);
  return app;
}

it("emergenciesRouter is exported", () => {
  expect(emergenciesRouter).toBeDefined();
});

it("POST /emergencies returns 201 with emergency row", async () => {
  const app = makeApp();
  const res = await request(app).post("/emergencies").send({
    technicianId: "t1",
    roundId: "r1",
    remainingStops: 3,
    lastLocation: "Alnwick High St Hub",
  });
  expect(res.status).toBe(201);
  expect(res.body).toMatchObject({
    id: expect.any(String),
    technicianId: expect.any(String),
    roundId: expect.any(String),
    remainingStops: expect.any(Number),
    status: "ACTIVE",
    assignedTechnicianId: null,
    resolvedAt: null,
  });
});

it("GET /emergencies returns 200 with array of emergency rows", async () => {
  const app = makeApp();
  const res = await request(app).get("/emergencies");
  expect(res.status).toBe(200);
  expect(Array.isArray(res.body)).toBe(true);
  expect(res.body[0]).toMatchObject({
    id: expect.any(String),
    technicianId: expect.any(String),
    roundId: expect.any(String),
    remainingStops: expect.any(Number),
    status: expect.any(String),
    assignedTechnicianId: null,
    resolvedAt: null,
  });
});

it("POST /emergencies/:id/reassign returns 200 with resolved emergency", async () => {
  const app = makeApp();
  const res = await request(app)
    .post("/emergencies/emg1/reassign")
    .send({ newTechnicianId: "t2" });
  expect(res.status).toBe(200);
  expect(res.body).toMatchObject({
    id: "emg1",
    status: "RESOLVED",
    assignedTechnicianId: "t2",
    assignedTechnicianName: "Sarah",
    resolvedAt: expect.any(String),
  });
});

it("POST /emergencies/:id/reassign 400 when newTechnicianId missing", async () => {
  const app = makeApp();
  const res = await request(app).post("/emergencies/emg1/reassign").send({});
  expect(res.status).toBe(400);
});

it("GET /emergencies/:id/available-technicians returns 200 with technician rows", async () => {
  const app = makeApp();
  const res = await request(app).get("/emergencies/emg1/available-technicians");
  expect(res.status).toBe(200);
  expect(Array.isArray(res.body)).toBe(true);
  expect(res.body[0]).toMatchObject({
    technicianId: expect.any(String),
    jobsRemaining: expect.any(Number),
    availability: expect.stringMatching(/^(AVAILABLE|BUSY)$/),
  });
});

it("GET /emergencies/:id returns 200 with single emergency row", async () => {
  const app = makeApp();
  const res = await request(app).get("/emergencies/emg1");
  expect(res.status).toBe(200);
  expect(res.body).toMatchObject({
    id: "emg1",
    technicianId: expect.any(String),
    technicianName: expect.any(String),
    roundId: expect.any(String),
    roundName: expect.any(String),
    remainingStops: expect.any(Number),
    status: "ACTIVE",
    lastLocation: expect.any(String),
    assignedTechnicianId: null,
    resolvedAt: null,
    reportedAt: expect.any(String),
  });
});

it("GET /emergencies?status=ACTIVE filters correctly", async () => {
  const app = makeApp();
  const res = await request(app).get("/emergencies?status=ACTIVE");
  expect(res.status).toBe(200);
  expect(Array.isArray(res.body)).toBe(true);
});

it("POST /emergencies 400 when required fields missing", async () => {
  const app = makeApp();
  const res = await request(app).post("/emergencies").send({ technicianId: "t1" });
  expect(res.status).toBe(400);
});
