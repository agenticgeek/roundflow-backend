import { it, expect, vi } from "vitest";
import request from "supertest";
import express from "express";

const mockBulkResult = {
  created: 1,
  results: [
    { customer: { id: "c1" }, property: { id: "p1" }, servicePlan: { id: "sp1" } },
  ],
};

const mockSetupSvc = {
  assertSetupIncomplete: vi.fn().mockResolvedValue(undefined),
  getSetupProperties: vi.fn().mockResolvedValue([]),
  addSetupProperty: vi.fn().mockResolvedValue(mockBulkResult.results[0]),
  bulkAddSetupProperties: vi.fn().mockResolvedValue(mockBulkResult),
  // stubs for other steps referenced by the router
  getBusinessProfile: vi.fn().mockResolvedValue({}),
  saveBusinessProfile: vi.fn().mockResolvedValue({}),
  getSetupStatus: vi.fn().mockResolvedValue({}),
  getServices: vi.fn().mockResolvedValue([]),
  saveServices: vi.fn().mockResolvedValue([]),
  getMessageTemplates: vi.fn().mockResolvedValue([]),
  saveMessageTemplates: vi.fn().mockResolvedValue([]),
  getTechnicians: vi.fn().mockResolvedValue([]),
  saveTechnicians: vi.fn().mockResolvedValue([]),
  getServiceAreas: vi.fn().mockResolvedValue([]),
  saveServiceAreas: vi.fn().mockResolvedValue([]),
  getSetupRounds: vi.fn().mockResolvedValue([]),
  saveFirstRound: vi.fn().mockResolvedValue({}),
  getSetupRoundAssignments: vi.fn().mockResolvedValue([]),
  assignTechniciansToRounds: vi.fn().mockResolvedValue({}),
  activateSetup: vi.fn().mockResolvedValue({}),
  getPaymentSetup: vi.fn().mockResolvedValue({}),
  savePaymentSetup: vi.fn().mockResolvedValue({}),
  getRoundSettings: vi.fn().mockResolvedValue({}),
  saveRoundSettings: vi.fn().mockResolvedValue({}),
};

vi.mock("../../services/setup.service", () => ({
  createSetupService: vi.fn(() => mockSetupSvc),
}));
vi.mock("../../services/settings.service", () => ({
  createSettingsService: vi.fn(() => ({
    getMessageTemplates: vi.fn().mockResolvedValue([]),
  })),
}));
vi.mock("../../middleware/requireAuth", () => ({
  requireAuth: (_req: any, _res: any, next: any) => next(),
}));
vi.mock("../../middleware/requireTenantAccess", () => ({
  requireTenantAccess: (_req: any, _res: any, next: any) => {
    (_req as any).profile = { role: "ADMIN" };
    next();
  },
}));
vi.mock("../../middleware/requireRole", () => ({
  requireRole: () => (_req: any, _res: any, next: any) => next(),
  requireBusinessAccess: () => (_req: any, _res: any, next: any) => next(),
}));

import { setupRouter } from "../../routes/setup";

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => {
    req.tenantPrisma = {};
    req.profile = { role: "ADMIN" };
    next();
  });
  app.use("/setup", setupRouter);
  return app;
}

const validRow = {
  customerName: "Test Customer",
  fullAddress: "1 Test Lane",
  postcode: "T1 1TT",
  serviceAreaId: "area1",
  roundId: "round1",
  price: 35,
};

it("POST /setup/step/9/bulk with valid body returns 201 and created count", async () => {
  mockSetupSvc.bulkAddSetupProperties.mockResolvedValue(mockBulkResult);
  const app = makeApp();
  const res = await request(app)
    .post("/setup/step/9/bulk")
    .send({ properties: [validRow] });
  expect(res.status).toBe(201);
  expect(res.body).toMatchObject({ created: 1, results: expect.any(Array) });
});

it("POST /setup/step/9/bulk with empty properties returns 201 created: 0", async () => {
  mockSetupSvc.bulkAddSetupProperties.mockResolvedValue({ created: 0, results: [] });
  const app = makeApp();
  const res = await request(app)
    .post("/setup/step/9/bulk")
    .send({ properties: [] });
  expect(res.status).toBe(201);
  expect(res.body).toMatchObject({ created: 0, results: [] });
});

it("POST /setup/step/9/bulk missing required field returns 400", async () => {
  const app = makeApp();
  const badRow = { ...validRow, roundId: undefined }; // missing roundId
  const res = await request(app)
    .post("/setup/step/9/bulk")
    .send({ properties: [badRow] });
  expect(res.status).toBe(400);
});

it("POST /setup/step/9/bulk missing customerName returns 400", async () => {
  const app = makeApp();
  const badRow = { ...validRow, customerName: undefined };
  const res = await request(app)
    .post("/setup/step/9/bulk")
    .send({ properties: [badRow] });
  expect(res.status).toBe(400);
});

it("POST /setup/step/9/bulk when setup is complete returns 403", async () => {
  mockSetupSvc.assertSetupIncomplete.mockRejectedValueOnce(
    Object.assign(new Error("Setup is already complete"), { statusCode: 403, name: "AppError" })
  );
  const app = makeApp();
  const res = await request(app)
    .post("/setup/step/9/bulk")
    .send({ properties: [validRow] });
  expect(res.status).toBe(403);
  // restore
  mockSetupSvc.assertSetupIncomplete.mockResolvedValue(undefined);
});

it("POST /setup/step/9/bulk when properties is not an array returns 400", async () => {
  const app = makeApp();
  const res = await request(app)
    .post("/setup/step/9/bulk")
    .send({ properties: "not-an-array" });
  expect(res.status).toBe(400);
});
