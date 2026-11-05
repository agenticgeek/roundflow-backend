import { it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";

const secretRow = {
  businessName: "Coates",
  vatRate: "20.00",
  ghlAccessTokenEncrypted: "secret-1",
  stripeSecretKeyEncrypted: "secret-2",
  gocardlessAccessTokenEncrypted: "secret-3",
};

const svc = {
  assertSetupIncomplete: vi.fn().mockResolvedValue(undefined),
  getBusinessSettings: vi.fn().mockResolvedValue(secretRow),
  getPaymentSetup: vi.fn().mockResolvedValue(secretRow),
  saveBusinessProfile: vi.fn().mockResolvedValue(secretRow),
  savePaymentSetup: vi.fn().mockResolvedValue(secretRow),
  saveRoundSettings: vi.fn().mockResolvedValue(secretRow),
  markStepComplete: vi.fn().mockResolvedValue(undefined),
  addSetupProperty: vi.fn().mockResolvedValue({ customerMatched: true }),
  bulkAddSetupProperties: vi.fn().mockResolvedValue({ created: 1, failed: 0, results: [{}], errors: [] }),
  previewActivation: vi.fn().mockResolvedValue({ rounds: [], total: 0 }),
};
const replaceTemplates = vi.fn().mockResolvedValue([{ id: "t1" }]);

vi.mock("../../services/setup.service", () => ({ createSetupService: vi.fn(() => svc) }));
vi.mock("../../services/settings.service", () => ({ createSettingsService: vi.fn(() => ({ replaceTemplates })) }));
vi.mock("../../middleware/requireAuth", () => ({ requireAuth: (_q: any, _s: any, n: any) => n() }));
vi.mock("../../middleware/requireTenantAccess", () => ({ requireTenantAccess: (_q: any, _s: any, n: any) => n() }));
vi.mock("../../middleware/requireRole", () => ({
  requireRole: () => (_q: any, _s: any, n: any) => n(),
  requireBusinessAccess: () => (_q: any, _s: any, n: any) => n(),
}));

import { setupRouter } from "../setup";

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.tenantPrisma = {};
    next();
  });
  app.use("/setup", setupRouter);
  app.use((err: any, _req: any, res: any, _next: any) => {
    res.status(err.statusCode ?? 500).json({ error: err.message, ...(err.code ? { code: err.code } : {}) });
  });
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
});

const expectNoSecrets = (body: Record<string, unknown>) => {
  expect(JSON.stringify(body)).not.toMatch(/Encrypted|secret-/);
  expect(body.vatRate).toBe(20);
};

it("GET /setup/step/1, /2 and /4 never return *Encrypted fields (D-1)", async () => {
  for (const step of [1, 2, 4]) {
    const res = await request(makeApp()).get(`/setup/step/${step}`);
    expect(res.status).toBe(200);
    expectNoSecrets(res.body);
  }
});

it("POST /setup/step/1 accepts the address and vatRate (B1) and returns the DTO", async () => {
  const res = await request(makeApp()).post("/setup/step/1").send({
    businessName: "Coates", addressLine1: "1 Audit St", addressLine2: null, town: "Alnwick", postcode: "NE66 1TD", vatRate: 5,
  });
  expect(res.status).toBe(200);
  expectNoSecrets(res.body);
  expect(svc.saveBusinessProfile).toHaveBeenCalledWith(expect.objectContaining({
    addressLine1: "1 Audit St", addressLine2: null, town: "Alnwick", postcode: "NE66 1TD", vatRate: 5,
  }));
});

it("POST /setup/step/1 400s on a vatRate outside 0–100", async () => {
  const res = await request(makeApp()).post("/setup/step/1").send({ businessName: "Coates", vatRate: 120 });
  expect(res.status).toBe(400);
});

it("POST /setup/step/2 rejects the removed connect booleans with FIELD_REMOVED (A6)", async () => {
  const res = await request(makeApp()).post("/setup/step/2").send({ paymentRule: "COLLECT_AFTER_VISIT", stripeConnected: true });
  expect(res.status).toBe(400);
  expect(res.body.code).toBe("FIELD_REMOVED");
  expect(svc.savePaymentSetup).not.toHaveBeenCalled();
});

it("POST /setup/step/2 accepts COLLECT_DAILY_BATCH and the payment defaults (GAP-008)", async () => {
  const res = await request(makeApp()).post("/setup/step/2").send({
    paymentRule: "COLLECT_DAILY_BATCH", defaultPaymentMethod: "BACS", invoiceDueDays: 14, noDirectDebitAction: "SEND_PAYMENT_LINK",
  });
  expect(res.status).toBe(200);
  expectNoSecrets(res.body);
  expect(svc.savePaymentSetup).toHaveBeenCalledWith({
    paymentRule: "COLLECT_DAILY_BATCH", debtHoldEnabled: undefined, vatInInvoices: undefined,
    defaultPaymentMethod: "BACS", invoiceDueDays: 14, noDirectDebitAction: "SEND_PAYMENT_LINK",
  });
});

it("POST /setup/step/2 400s on invoiceDueDays out of range", async () => {
  const res = await request(makeApp()).post("/setup/step/2").send({ invoiceDueDays: 91 });
  expect(res.status).toBe(400);
});

it("POST /setup/step/4 accepts the reminder fields (B2) and validates reminderTime", async () => {
  const ok = await request(makeApp()).post("/setup/step/4").send({
    defaultCycleLength: 28, reminderMode: "EVENING_BEFORE", reminderTime: "19:00", defaultCleanMethod: "TRADITIONAL", autoCreateNextVisit: true,
  });
  expect(ok.status).toBe(200);
  expectNoSecrets(ok.body);
  expect(svc.saveRoundSettings).toHaveBeenCalledWith(expect.objectContaining({
    reminderMode: "EVENING_BEFORE", reminderTime: "19:00", defaultCleanMethod: "TRADITIONAL", autoCreateNextVisit: true,
  }));

  const bad = await request(makeApp()).post("/setup/step/4").send({ defaultCycleLength: 28, reminderTime: "7pm" });
  expect(bad.status).toBe(400);
});

it("POST /setup/step/5 records step 5 after saving templates", async () => {
  const res = await request(makeApp()).post("/setup/step/5").send([{ name: "A", channel: "SMS", body: "x" }]);
  expect(res.status).toBe(200);
  expect(res.body).toEqual([{ id: "t1" }]);
  expect(svc.markStepComplete).toHaveBeenCalledWith(5);
});

const row = {
  customerName: "Jo", phone: "07700900201", fullAddress: "1 High St", postcode: "NE66 1AA",
  serviceAreaId: "a1", roundId: "r1", price: 20,
};

it("POST /setup/step/9 passes customerId and lastCleanedDate through (GAP-010, A2)", async () => {
  const res = await request(makeApp()).post("/setup/step/9").send({ ...row, customerId: "c1", lastCleanedDate: "2026-10-16" });
  expect(res.status).toBe(201);
  expect(res.body).toEqual({ customerMatched: true });
  expect(svc.addSetupProperty).toHaveBeenCalledWith(expect.objectContaining({ customerId: "c1", lastCleanedDate: "2026-10-16" }));
});

it("POST /setup/step/9/bulk reports a missing phone as { row, field, error } and forwards allowFrequencyMismatch (GAP-009)", async () => {
  const res = await request(makeApp()).post("/setup/step/9/bulk").send({
    properties: [{ ...row, phone: undefined }, { ...row, customerId: "c1" }],
    allowFrequencyMismatch: true,
  });
  expect(res.status).toBe(201);
  expect(res.body.errors).toEqual([
    { row: 0, field: "phone", error: expect.stringContaining("phone"), message: expect.stringContaining("phone") },
  ]);
  expect(svc.bulkAddSetupProperties).toHaveBeenCalledWith(
    [expect.objectContaining({ customerId: "c1", lastCleanedDate: null })],
    undefined,
    { allowFrequencyMismatch: true }
  );
});

it("GET /setup/step/11/preview validates the query and returns the service preview", async () => {
  svc.previewActivation.mockResolvedValue({ rounds: [{ roundId: "r1", name: "R", firstVisit: "2026-10-30", visits: 4 }], total: 4 });
  const ok = await request(makeApp()).get("/setup/step/11/preview?startDate=2026-10-30&cycleWeeks=4");
  expect(ok.status).toBe(200);
  expect(ok.body.total).toBe(4);
  expect(svc.previewActivation).toHaveBeenCalledWith({ startDate: "2026-10-30", cycleWeeks: 4 });

  expect((await request(makeApp()).get("/setup/step/11/preview?cycleWeeks=4")).status).toBe(400);
  expect((await request(makeApp()).get("/setup/step/11/preview?startDate=2026-10-30")).status).toBe(400);
  expect((await request(makeApp()).get("/setup/step/11/preview?startDate=2026-10-30&cycleWeeks=four")).status).toBe(400);
});
