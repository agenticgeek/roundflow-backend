import { it, expect, vi } from "vitest";
import request from "supertest";
import express from "express";

const mockBulkResult = {
  created: 1,
  failed: 0,
  results: [
    { customer: { id: "c1" }, property: { id: "p1" }, servicePlan: { id: "sp1" }, servicePlans: [{ id: "sp1" }] },
  ],
  errors: [],
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
  getStatus: vi.fn().mockResolvedValue({
    setupCompleted: false,
    allRequiredComplete: false,
    steps: [{ step: 1, complete: false, deferred: false }],
  }),
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
  phone: "07700900201",
  fullAddress: "1 Test Lane",
  postcode: "T1 1TT",
  serviceAreaId: "area1",
  roundId: "round1",
  price: 35,
};

// Smoke test for the getStatus() perf refactor (query batching + settings
// memoization lives inside the service, which is mocked here) — this just
// guards against a route-level regression breaking the response shape.
it("GET /setup/status returns 200 with the expected shape", async () => {
  const app = makeApp();
  const res = await request(app).get("/setup/status");
  expect(res.status).toBe(200);
  expect(res.body).toMatchObject({
    setupCompleted: expect.any(Boolean),
    allRequiredComplete: expect.any(Boolean),
    steps: expect.any(Array),
  });
});

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

it("POST /setup/step/9/bulk reports a real field name (not 'unknown') for a parse failure", async () => {
  const app = makeApp();
  const badRow = { ...validRow, roundId: undefined };
  const res = await request(app)
    .post("/setup/step/9/bulk")
    .send({ properties: [badRow] });
  expect(res.status).toBe(400);
  expect(res.body.errors).toEqual([
    { row: 0, field: "roundId", error: expect.any(String), message: expect.any(String) },
  ]);
});

it("POST /setup/step/9/bulk remaps a service-level row error back to the original row index after a parse failure earlier in the array", async () => {
  mockSetupSvc.bulkAddSetupProperties.mockResolvedValueOnce({
    created: 0,
    failed: 1,
    results: [],
    // The service only ever saw the one valid row, so it reports row 0 —
    // the route must remap that back to its real position (row 2).
    errors: [{ row: 0, field: "serviceAreaId", error: "serviceAreaId not found: bad-area", message: "serviceAreaId not found: bad-area" }],
  });
  const app = makeApp();
  const res = await request(app).post("/setup/step/9/bulk").send({
    properties: [
      { ...validRow, roundId: undefined }, // row 0: parse failure
      { ...validRow, customerName: undefined }, // row 1: parse failure
      { ...validRow, serviceAreaId: "bad-area" }, // row 2: the only row that reaches the service
    ],
  });
  expect(res.status).toBe(400);
  expect(res.body.errors).toEqual(
    expect.arrayContaining([
      { row: 0, field: "roundId", error: expect.any(String), message: expect.any(String) },
      { row: 1, field: "customerName", error: expect.any(String), message: expect.any(String) },
      { row: 2, field: "serviceAreaId", error: "serviceAreaId not found: bad-area", message: "serviceAreaId not found: bad-area" },
    ])
  );
  expect(mockSetupSvc.bulkAddSetupProperties).toHaveBeenCalledWith(
    [expect.objectContaining({ serviceAreaId: "bad-area" })],
    undefined,
    { allowFrequencyMismatch: false }
  );
});

it("POST /setup/step/9/bulk passes landline, serviceIds and idempotencyKey through", async () => {
  mockSetupSvc.bulkAddSetupProperties.mockResolvedValueOnce(mockBulkResult);
  const app = makeApp();
  const res = await request(app).post("/setup/step/9/bulk").send({
    idempotencyKey: "import-123",
    properties: [{ ...validRow, landline: "01234567890", serviceIds: ["svc-a", "svc-b"] }],
  });
  expect(res.status).toBe(201);
  expect(mockSetupSvc.bulkAddSetupProperties).toHaveBeenCalledWith(
    [expect.objectContaining({ landline: "01234567890", serviceIds: ["svc-a", "svc-b"] })],
    "import-123",
    { allowFrequencyMismatch: false }
  );
});

it("POST /setup/step/9/bulk returns 201 with idempotent:true and skips calling the service when a prior identical idempotencyKey already ran", async () => {
  mockSetupSvc.bulkAddSetupProperties.mockResolvedValueOnce({
    created: 5, failed: 0, results: [], errors: [], idempotent: true,
  });
  const app = makeApp();
  const res = await request(app)
    .post("/setup/step/9/bulk")
    .send({ idempotencyKey: "already-ran", properties: [validRow] });
  expect(res.status).toBe(201);
  expect(res.body).toMatchObject({ created: 5, idempotent: true });
});

it("POST /setup/step/9/bulk returns 400 (not 201) when every submitted row fails", async () => {
  mockSetupSvc.bulkAddSetupProperties.mockResolvedValueOnce({
    created: 0, failed: 1, results: [],
    errors: [{ row: 0, field: "serviceAreaId", error: "serviceAreaId not found: bad", message: "serviceAreaId not found: bad" }],
  });
  const app = makeApp();
  const res = await request(app)
    .post("/setup/step/9/bulk")
    .send({ properties: [{ ...validRow, serviceAreaId: "bad" }] });
  expect(res.status).toBe(400);
});

it("POST /setup/step/9 (single) passes landline and serviceIds through", async () => {
  mockSetupSvc.addSetupProperty.mockResolvedValueOnce(mockBulkResult.results[0]);
  const app = makeApp();
  const res = await request(app)
    .post("/setup/step/9")
    .send({ ...validRow, landline: "01234567890", serviceIds: ["svc-a", "svc-b"] });
  expect(res.status).toBe(201);
  expect(mockSetupSvc.addSetupProperty).toHaveBeenCalledWith(
    expect.objectContaining({ landline: "01234567890", serviceIds: ["svc-a", "svc-b"] })
  );
});
