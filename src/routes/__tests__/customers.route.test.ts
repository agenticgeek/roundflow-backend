import { it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";

const searchCustomers = vi.fn();
const getVisitHistory = vi.fn();
const setBadDebt = vi.fn();
const addPropertyToCustomer = vi.fn();
const getCustomerDetail = vi.fn();
const updateCustomer = vi.fn();
vi.mock("../../services/customer.service", () => ({
  createCustomerService: vi.fn(() => ({
    searchCustomers,
    getVisitHistory,
    setBadDebt,
    addPropertyToCustomer,
    getCustomerDetail,
    updateCustomer,
  })),
}));
const logActivity = vi.fn();
vi.mock("../../services/reports.service", () => ({
  createReportsService: vi.fn(() => ({ logActivity })),
}));
vi.mock("../../integrations/ghl/sync", () => ({ queueGhlEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../../middleware/requireAuth", () => ({ requireAuth: (_q: any, _s: any, n: any) => n() }));
vi.mock("../../middleware/requireTenantAccess", () => ({ requireTenantAccess: (_q: any, _s: any, n: any) => n() }));
vi.mock("../../middleware/requireRole", () => ({ requireBusinessAccess: () => (_q: any, _s: any, n: any) => n() }));

import { customersRouter } from "../customers";
import { AppError } from "../../lib/app-error";

function makeApp(profile: any = { id: "prof1", role: "ADMIN" }) {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.tenantPrisma = {};
    req.profile = profile;
    next();
  });
  app.use("/customers", customersRouter);
  app.use((err: any, _req: any, res: any, _next: any) => {
    if (err instanceof AppError) return res.status(err.statusCode).json({ error: err.message });
    res.status(500).json({ error: String(err) });
  });
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  logActivity.mockResolvedValue(undefined);
});

// ── GET /customers/search ───────────────────────────────────────────────────

it("GET /customers/search returns picker rows and isn't routed to /:id", async () => {
  searchCustomers.mockResolvedValue([{ id: "c1" }]);
  const res = await request(makeApp()).get("/customers/search?q=coates");
  expect(res.status).toBe(200);
  expect(res.body).toEqual([{ id: "c1" }]);
  expect(searchCustomers).toHaveBeenCalledWith("coates");
  expect(getCustomerDetail).not.toHaveBeenCalled();
});

it.each([["/customers/search"], ["/customers/search?q=%20"], ["/customers/search?q=a&q=b"], ["/customers/search?q=a%00b"], [`/customers/search?q=${"x".repeat(256)}`]])(
  "GET %s → 400",
  async (url) => {
    expect((await request(makeApp()).get(url)).status).toBe(400);
    expect(searchCustomers).not.toHaveBeenCalled();
  }
);

// ── GET /customers/:id/visits ───────────────────────────────────────────────

it("GET /customers/:id/visits pages the visit history", async () => {
  getVisitHistory.mockResolvedValue({ rows: [], pagination: {} });
  expect((await request(makeApp()).get("/customers/c1/visits?page=2&pageSize=20")).status).toBe(200);
  expect(getVisitHistory).toHaveBeenCalledWith("c1", 2, 20);
  expect((await request(makeApp()).get("/customers/c1/visits?page=x")).status).toBe(400);
});

// ── PATCH /customers/:id messagesOptOut ─────────────────────────────────────

it("PATCH /customers/:id forwards messagesOptOut and 400s for a non-boolean", async () => {
  updateCustomer.mockResolvedValue({ customerId: "c1", propertyId: null, servicePlanId: null });
  const ok = await request(makeApp()).patch("/customers/c1").send({ messagesOptOut: true });
  expect(ok.status).toBe(200);
  expect(updateCustomer).toHaveBeenCalledWith("c1", expect.objectContaining({ messagesOptOut: true }));
  expect((await request(makeApp()).patch("/customers/c1").send({ messagesOptOut: "yes" })).status).toBe(400);
});

// ── PATCH /customers/:id/bad-debt ───────────────────────────────────────────

it("PATCH /customers/:id/bad-debt sets the flag and logs the reason", async () => {
  setBadDebt.mockResolvedValue({ id: "c1", badDebt: true });
  const res = await request(makeApp()).patch("/customers/c1/bad-debt").send({ flag: true, reason: "Moved away" });
  expect(res.status).toBe(200);
  expect(res.body).toEqual({ id: "c1", badDebt: true });
  expect(setBadDebt).toHaveBeenCalledWith("c1", true);
  expect(logActivity).toHaveBeenCalledWith(
    "CUSTOMER_BAD_DEBT_FLAGGED",
    "Customer c1 flagged as bad debt: Moved away",
    "prof1",
    "ADMIN"
  );
});

it("PATCH /customers/:id/bad-debt clearing without a reason or profile; a logging failure doesn't fail the request", async () => {
  setBadDebt.mockResolvedValue({ id: "c1", badDebt: false });
  logActivity.mockRejectedValue(new Error("db"));
  const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  const res = await request(makeApp(null)).patch("/customers/c1/bad-debt").send({ flag: false });
  expect(res.status).toBe(200);
  expect(logActivity).toHaveBeenCalledWith("CUSTOMER_BAD_DEBT_CLEARED", "Customer c1 cleared of bad debt", undefined, undefined);
  await new Promise((r) => setImmediate(r));
  expect(errSpy).toHaveBeenCalled();
  errSpy.mockRestore();
});

it.each([[{}], [{ flag: "yes" }], [{ flag: true, reason: 5 }]])("PATCH /customers/:id/bad-debt 400s for %j", async (body) => {
  expect((await request(makeApp()).patch("/customers/c1/bad-debt").send(body)).status).toBe(400);
  expect(setBadDebt).not.toHaveBeenCalled();
});

// ── POST /customers/:id/properties: lastCleanedDate ─────────────────────────

it("POST /customers/:id/properties passes lastCleanedDate through", async () => {
  addPropertyToCustomer.mockResolvedValue({ propertyId: "p1" });
  const res = await request(makeApp())
    .post("/customers/c1/properties")
    .send({ addressLine: "1 St", postcode: "NE66 1TD", serviceAreaId: "sa1", price: 20, lastCleanedDate: "2026-10-01" });
  expect(res.status).toBe(201);
  expect(addPropertyToCustomer.mock.calls[0][1].lastCleanedDate).toEqual(new Date("2026-10-01"));
});
