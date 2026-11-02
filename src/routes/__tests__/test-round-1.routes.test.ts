import { it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";

vi.mock("../../middleware/requireAuth", () => ({ requireAuth: (_q: any, _s: any, n: any) => n() }));
vi.mock("../../middleware/requireTenantAccess", () => ({ requireTenantAccess: (_q: any, _s: any, n: any) => n() }));
vi.mock("../../middleware/requireRole", () => ({ requireBusinessAccess: () => (_q: any, _s: any, n: any) => n() }));
vi.mock("../../services/reports.service", () => ({ createReportsService: () => ({ logActivity: vi.fn().mockResolvedValue(undefined) }) }));
vi.mock("../../integrations/ghl/sync", () => ({ queueGhlEvent: vi.fn().mockResolvedValue(undefined) }));

const createCustomerWithProperty = vi.fn();
const addPropertyToCustomer = vi.fn();
const getProperty = vi.fn();
vi.mock("../../services/customer.service", () => ({
  createCustomerService: () => ({ createCustomerWithProperty, addPropertyToCustomer, getProperty }),
}));

import { customersRouter } from "../customers";
import { propertiesRouter } from "../properties";
import { errorHandler } from "../../lib/error-handler";

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.tenantPrisma = {};
    next();
  });
  app.use("/customers", customersRouter);
  app.use("/properties", propertiesRouter);
  app.use(errorHandler);
  return app;
}

beforeEach(() => vi.clearAllMocks());

const prop = { addressLine: " 1 High St ", postcode: "X1 1AA", serviceAreaId: "sa1", price: 20, roundId: "r1", paymentMethod: "STRIPE" };

it("POST /customers without a property returns the customer as before", async () => {
  createCustomerWithProperty.mockResolvedValue({ customer: { id: "c1", name: "Jo" }, property: null });
  const res = await request(makeApp()).post("/customers").send({ name: "Jo" });
  expect(res.status).toBe(201);
  expect(res.body).toEqual({ id: "c1", name: "Jo" });
  expect(createCustomerWithProperty.mock.calls[0][0].property).toBeUndefined();
  await request(makeApp()).post("/customers").send({ name: "Jo", property: null });
  expect(createCustomerWithProperty.mock.calls[1][0].property).toBeUndefined();
});

it("POST /customers with a property validates it and merges propertyId/servicePlanId/assigned into the response", async () => {
  createCustomerWithProperty.mockResolvedValue({ customer: { id: "c1", name: "Jo" }, property: { propertyId: "p1", servicePlanId: "sp1", assigned: true } });
  const res = await request(makeApp()).post("/customers").send({ name: "Jo", property: prop });
  expect(res.status).toBe(201);
  expect(res.body).toEqual({ id: "c1", name: "Jo", propertyId: "p1", servicePlanId: "sp1", assigned: true });
  expect(createCustomerWithProperty.mock.calls[0][0].property).toMatchObject({ addressLine: "1 High St", postcode: "X1 1AA", serviceAreaId: "sa1", price: 20, roundId: "r1", paymentMethod: "STRIPE" });
  for (const bad of [{ ...prop, price: 0 }, { ...prop, addressLine: undefined }, { ...prop, serviceAreaId: undefined }, "nope"]) {
    const r = await request(makeApp()).post("/customers").send({ name: "Jo", property: bad });
    expect(r.status).toBe(400);
  }
  expect((await request(makeApp()).post("/customers").send({ name: "Jo", property: { ...prop, price: 0 } })).body.error).toContain("property.price");
});

it("POST /customers/:id/properties still parses the same fields", async () => {
  addPropertyToCustomer.mockResolvedValue({ propertyId: "p1" });
  const res = await request(makeApp()).post("/customers/c1/properties").send(prop);
  expect(res.status).toBe(201);
  expect(addPropertyToCustomer).toHaveBeenCalledWith("c1", expect.objectContaining({ addressLine: "1 High St", price: 20 }));
  expect((await request(makeApp()).post("/customers/c1/properties").send({ ...prop, price: -1 })).status).toBe(400);
});

it("GET /properties/:id returns the single property; 404 passes through", async () => {
  getProperty.mockResolvedValue({ id: "p2" });
  const res = await request(makeApp()).get("/properties/p2");
  expect(res.body).toEqual({ id: "p2" });
  expect(getProperty).toHaveBeenCalledWith("p2");
});
