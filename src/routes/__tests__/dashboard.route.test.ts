import { it, expect, vi } from "vitest";
import request from "supertest";
import express from "express";

const mockKpis = {
  jobsScheduledToday: 48,
  openComplaints: 2,
  openComplaintsByPriority: { high: 1, medium: 1, low: 0 },
  cleanUnpaidAmount: 1240,
  cleanUnpaidCount: 18,
  monthlyRevenue: 12400,
};

const mockRounds = [
  {
    roundId: "r1",
    roundName: "Alnwick Monday",
    technicianId: "t1",
    technicianName: "James",
    status: "in_progress",
    total: 12,
    completed: 8,
    skipped: 1,
    issueCount: 1,
    paymentHolds: 0,
    value: 220,
    etaMinutes: null,
  },
];

const mockAlerts = {
  skippedNeedingReview: 4,
  failedPayments: 7,
  complaintRevisitsDue: 2,
};

const mockChartData = {
  months: ["Apr", "May", "Jun", "Jul", "Aug", "Sep"],
  valueCompleted: [1200, 1400, 980, 1100, 1600, 1340],
  issueCount: [3, 5, 2, 4, 6, 3],
  revenuePerHour: null,
};

const mockTechnicianKpis = [
  {
    technicianId: "t1",
    technicianName: "James",
    jobsCompleted: 42,
    valueCompleted: 840,
    openComplaints: 1,
    issueCount: 3,
    timeOnJobMinutes: null,
    strikes: null,
    damages: null,
    upsells: null,
  },
];

vi.mock("../../services/dashboard.service", () => ({
  createDashboardService: vi.fn(() => ({
    getKpis: vi.fn().mockResolvedValue(mockKpis),
    getAlerts: vi.fn().mockResolvedValue(mockAlerts),
    getTodaysRounds: vi.fn().mockResolvedValue(mockRounds),
    getTechnicianKpis: vi.fn().mockResolvedValue(mockTechnicianKpis),
    getChartData: vi.fn().mockResolvedValue(mockChartData),
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

import { dashboardRouter } from "../../routes/dashboard";

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => { req.tenantPrisma = {}; next(); });
  app.use("/dashboard", dashboardRouter);
  return app;
}

it("dashboardRouter is exported", () => {
  expect(dashboardRouter).toBeDefined();
});

it("GET /dashboard/rounds returns 200 with round rows", async () => {
  const app = makeApp();
  const res = await request(app).get("/dashboard/rounds");
  expect(res.status).toBe(200);
  expect(Array.isArray(res.body)).toBe(true);
  expect(res.body[0]).toMatchObject({
    roundId: expect.any(String),
    roundName: expect.any(String),
    total: expect.any(Number),
    completed: expect.any(Number),
    skipped: expect.any(Number),
    issueCount: expect.any(Number),
    value: expect.any(Number),
    status: expect.any(String),
  });
});

it("GET /dashboard/alerts returns 200 with all 3 alert fields", async () => {
  const app = makeApp();
  const res = await request(app).get("/dashboard/alerts");
  expect(res.status).toBe(200);
  expect(res.body).toMatchObject({
    skippedNeedingReview: expect.any(Number),
    failedPayments: expect.any(Number),
    complaintRevisitsDue: expect.any(Number),
  });
});

it("GET /dashboard/kpis returns 200 with all 4 metric fields", async () => {
  const app = makeApp();
  const res = await request(app).get("/dashboard/kpis");
  expect(res.status).toBe(200);
  expect(res.body).toMatchObject({
    jobsScheduledToday: expect.any(Number),
    openComplaints: expect.any(Number),
    openComplaintsByPriority: {
      high: expect.any(Number),
      medium: expect.any(Number),
      low: expect.any(Number),
    },
    cleanUnpaidAmount: expect.any(Number),
    cleanUnpaidCount: expect.any(Number),
    monthlyRevenue: expect.any(Number),
  });
});

it("GET /dashboard/charts returns 200 with parallel month arrays", async () => {
  const app = makeApp();
  const res = await request(app).get("/dashboard/charts?range=6m");
  expect(res.status).toBe(200);
  expect(Array.isArray(res.body.months)).toBe(true);
  expect(Array.isArray(res.body.valueCompleted)).toBe(true);
  expect(Array.isArray(res.body.issueCount)).toBe(true);
  expect(res.body.months.length).toBe(res.body.valueCompleted.length);
  expect(res.body.months.length).toBe(res.body.issueCount.length);
  expect(res.body.revenuePerHour).toBeNull();
});

it("GET /dashboard/technician-kpis returns 200 with per-technician rows", async () => {
  const app = makeApp();
  const res = await request(app).get("/dashboard/technician-kpis?period=monthly");
  expect(res.status).toBe(200);
  expect(Array.isArray(res.body)).toBe(true);
  expect(res.body[0]).toMatchObject({
    technicianId: expect.any(String),
    jobsCompleted: expect.any(Number),
    valueCompleted: expect.any(Number),
    openComplaints: expect.any(Number),
    issueCount: expect.any(Number),
    timeOnJobMinutes: null,
    strikes: null,
    damages: null,
    upsells: null,
  });
});
