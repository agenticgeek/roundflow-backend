import { it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";

// BUG-07: STRIPE and CHEQUE must round-trip through the real route validators
// and the real service (only the DB client is faked).
vi.mock("../../services/reports.service", () => ({
  createReportsService: vi.fn(() => ({ logActivity: vi.fn().mockResolvedValue(undefined) })),
}));
vi.mock("../../integrations/geocoding/client", () => ({ geocodePostcode: vi.fn().mockResolvedValue(null) }));
vi.mock("../../middleware/requireAuth", () => ({ requireAuth: (_q: any, _s: any, n: any) => n() }));
vi.mock("../../middleware/requireTenantAccess", () => ({ requireTenantAccess: (_q: any, _s: any, n: any) => n() }));
vi.mock("../../middleware/requireRole", () => ({ requireBusinessAccess: () => (_q: any, _s: any, n: any) => n() }));

import { propertiesRouter } from "../properties";
import { servicePlansRouter } from "../service-plans";
import { errorHandler } from "../../lib/error-handler";

function makeTp() {
  const tp: any = {
    businessSettings: { findFirst: vi.fn().mockResolvedValue({ defaultPaymentMethod: "BACS" }) },
    serviceArea: { findUnique: vi.fn().mockResolvedValue({ id: "sa1" }) },
    round: { findUnique: vi.fn().mockResolvedValue(null) },
    service: { findUnique: vi.fn().mockResolvedValue({ id: "svc1", active: true }) },
    customer: { create: vi.fn().mockResolvedValue({ id: "c1" }) },
    property: { create: vi.fn().mockResolvedValue({ id: "p1" }), update: vi.fn().mockResolvedValue({}) },
    servicePlan: {
      create: vi.fn().mockResolvedValue({ id: "sp1" }),
      findUnique: vi.fn().mockResolvedValue({ id: "sp1", propertyId: "p1", property: { round: null } }),
      update: vi.fn().mockImplementation(({ data }: any) => Promise.resolve({ id: "sp1", ...data })),
    },
    $transaction: vi.fn((cb: any) => cb(tp)),
  };
  return tp;
}

function makeApp(tp: any) {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.tenantPrisma = tp;
    req.profile = { id: "prof1", role: "ADMIN" };
    next();
  });
  app.use("/properties", propertiesRouter);
  app.use("/service-plans", servicePlansRouter);
  app.use(errorHandler);
  return app;
}

const body = (paymentMethod?: string) => ({
  customerName: "Jo", addressLine: "1 High St", postcode: "CH41 1AA", serviceAreaId: "sa1", price: 20, ...(paymentMethod ? { paymentMethod } : {}),
});

beforeEach(() => vi.clearAllMocks());

it.each(["STRIPE", "CHEQUE"])("POST /properties saves %s on the customer and the plan", async (method) => {
  const tp = makeTp();
  const res = await request(makeApp(tp)).post("/properties").send(body(method));
  expect(res.status).toBe(201);
  expect(tp.customer.create.mock.calls[0][0].data.paymentMethod).toBe(method);
  expect(tp.servicePlan.create.mock.calls[0][0].data.paymentMethod).toBe(method);
});

it("POST /properties without a method falls back to the business default (A7)", async () => {
  const tp = makeTp();
  await request(makeApp(tp)).post("/properties").send(body());
  expect(tp.customer.create.mock.calls[0][0].data.paymentMethod).toBe("BACS");
  expect(tp.servicePlan.create.mock.calls[0][0].data.paymentMethod).toBe("BACS");
});

it("POST /properties rejects an unknown method and an inactive/unknown service", async () => {
  const tp = makeTp();
  expect((await request(makeApp(tp)).post("/properties").send(body("PAYPAL"))).status).toBe(400);
  tp.service.findUnique.mockResolvedValueOnce({ id: "svc1", active: false });
  const inactive = await request(makeApp(tp)).post("/properties").send({ ...body(), serviceId: "svc1" });
  expect(inactive.status).toBe(400);
  expect(inactive.body.code).toBe("SERVICE_INACTIVE");
  tp.service.findUnique.mockResolvedValueOnce(null);
  expect((await request(makeApp(tp)).post("/properties").send({ ...body(), serviceId: "ghost" })).status).toBe(404);
});

it.each(["STRIPE", "CHEQUE"])("PATCH /service-plans/:id saves %s", async (method) => {
  const tp = makeTp();
  const res = await request(makeApp(tp)).patch("/service-plans/sp1").send({ paymentMethod: method });
  expect(res.status).toBe(200);
  expect(tp.servicePlan.update.mock.calls[0][0].data.paymentMethod).toBe(method);
  expect(res.body.servicePlan.paymentMethod).toBe(method);
});
