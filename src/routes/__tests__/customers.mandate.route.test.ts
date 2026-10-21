import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";

vi.mock("../../middleware/requireAuth", () => ({
  requireAuth: (_req: any, _res: any, next: any) => next(),
}));
vi.mock("../../middleware/requireTenantAccess", () => ({
  requireTenantAccess: (_req: any, _res: any, next: any) => {
    _req.profile = { tenantId: "tenant-1", role: "ADMIN" };
    next();
  },
}));
vi.mock("../../middleware/requireRole", () => ({
  requireRole: () => (_req: any, _res: any, next: any) => next(),
  requireBusinessAccess: () => (_req: any, _res: any, next: any) => next(),
}));

const decrypt = vi.fn((..._args: unknown[]) => "decrypted-access-token");
vi.mock("../../lib/crypto", () => ({
  decrypt: (...args: unknown[]) => decrypt(...args),
}));

const getGcClient = vi.fn((..._args: unknown[]) => ({ fake: "gc-client" }));
vi.mock("../../integrations/gocardless/client", () => ({
  getGcClient: (...args: unknown[]) => getGcClient(...args),
}));

const createRedirectFlow = vi.fn();
const completeRedirectFlow = vi.fn();
vi.mock("../../integrations/gocardless/mandate", () => ({
  createRedirectFlow: (...args: unknown[]) => createRedirectFlow(...args),
  completeRedirectFlow: (...args: unknown[]) => completeRedirectFlow(...args),
}));

import { customersRouter } from "../customers";

function makeTenantPrisma() {
  return {
    customer: { findUnique: vi.fn(), update: vi.fn().mockResolvedValue({}) },
    businessSettings: { findFirst: vi.fn() },
  };
}

function makeApp(tp: ReturnType<typeof makeTenantPrisma> = makeTenantPrisma()) {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.tenantPrisma = tp;
    next();
  });
  app.use("/customers", customersRouter);
  app.use((err: any, _req: any, res: any, _next: any) => {
    res.status(err.statusCode ?? 500).json({ error: err.message ?? "Internal error" });
  });
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.FRONTEND_URL = "https://app.test.roundflow.example";
});

describe("POST /customers/:id/mandate", () => {
  it("404s when the customer does not exist", async () => {
    const tp = makeTenantPrisma();
    tp.customer.findUnique.mockResolvedValue(null);

    const res = await request(makeApp(tp)).post("/customers/cust-1/mandate");

    expect(res.status).toBe(404);
  });

  it("409s when the customer already has an active mandate", async () => {
    const tp = makeTenantPrisma();
    tp.customer.findUnique.mockResolvedValue({ id: "cust-1", gocardlessMandateStatus: "active" });

    const res = await request(makeApp(tp)).post("/customers/cust-1/mandate");

    expect(res.status).toBe(409);
  });

  it("409s when GoCardless is not connected for this tenant", async () => {
    const tp = makeTenantPrisma();
    tp.customer.findUnique.mockResolvedValue({ id: "cust-1", gocardlessMandateStatus: null });
    tp.businessSettings.findFirst.mockResolvedValue({ gocardlessConnected: false });

    const res = await request(makeApp(tp)).post("/customers/cust-1/mandate");

    expect(res.status).toBe(409);
  });

  it("starts a redirect flow and returns its url on the happy path", async () => {
    const tp = makeTenantPrisma();
    tp.customer.findUnique.mockResolvedValue({ id: "cust-1", gocardlessMandateStatus: null });
    tp.businessSettings.findFirst.mockResolvedValue({
      gocardlessConnected: true, gocardlessAccessTokenEncrypted: "enc", gocardlessEnvironment: "sandbox",
    });
    createRedirectFlow.mockResolvedValue({ id: "RE123", redirectUrl: "https://pay-sandbox.gocardless.com/flow/RE123" });

    const res = await request(makeApp(tp)).post("/customers/cust-1/mandate");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ url: "https://pay-sandbox.gocardless.com/flow/RE123" });
    expect(decrypt).toHaveBeenCalledWith("enc");
    expect(getGcClient).toHaveBeenCalledWith("decrypted-access-token", "sandbox");
    expect(createRedirectFlow).toHaveBeenCalledWith(
      { fake: "gc-client" },
      expect.objectContaining({
        successRedirectUrl: "https://app.test.roundflow.example/customers/cust-1/mandate/success",
        sessionToken: "cust-1",
        description: "Direct Debit for window cleaning",
      })
    );
  });

  it("defaults the GoCardless environment to sandbox when unset", async () => {
    const tp = makeTenantPrisma();
    tp.customer.findUnique.mockResolvedValue({ id: "cust-1", gocardlessMandateStatus: null });
    tp.businessSettings.findFirst.mockResolvedValue({
      gocardlessConnected: true, gocardlessAccessTokenEncrypted: "enc", gocardlessEnvironment: null,
    });
    createRedirectFlow.mockResolvedValue({ id: "RE123", redirectUrl: "https://pay-sandbox.gocardless.com/flow/RE123" });

    await request(makeApp(tp)).post("/customers/cust-1/mandate");

    expect(getGcClient).toHaveBeenCalledWith("decrypted-access-token", "sandbox");
  });
});

describe("POST /customers/:id/mandate/complete", () => {
  it("400s when redirectFlowId is missing", async () => {
    const res = await request(makeApp()).post("/customers/cust-1/mandate/complete").send({});
    expect(res.status).toBe(400);
  });

  it("404s when the customer does not exist", async () => {
    const tp = makeTenantPrisma();
    tp.customer.findUnique.mockResolvedValue(null);

    const res = await request(makeApp(tp)).post("/customers/cust-1/mandate/complete").send({ redirectFlowId: "RE123" });

    expect(res.status).toBe(404);
  });

  it("409s when GoCardless is not connected", async () => {
    const tp = makeTenantPrisma();
    tp.customer.findUnique.mockResolvedValue({ id: "cust-1" });
    tp.businessSettings.findFirst.mockResolvedValue({ gocardlessAccessTokenEncrypted: null });

    const res = await request(makeApp(tp)).post("/customers/cust-1/mandate/complete").send({ redirectFlowId: "RE123" });

    expect(res.status).toBe(409);
  });

  it("completes the flow and saves the mandate as pending_customer_approval", async () => {
    const tp = makeTenantPrisma();
    tp.customer.findUnique.mockResolvedValue({ id: "cust-1" });
    tp.businessSettings.findFirst.mockResolvedValue({ gocardlessAccessTokenEncrypted: "enc", gocardlessEnvironment: "sandbox" });
    completeRedirectFlow.mockResolvedValue({ gcCustomerId: "CU123", mandateId: "MD123" });

    const res = await request(makeApp(tp)).post("/customers/cust-1/mandate/complete").send({ redirectFlowId: "RE123" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ mandateId: "MD123", status: "pending_customer_approval" });
    expect(completeRedirectFlow).toHaveBeenCalledWith({ fake: "gc-client" }, "RE123", "cust-1");
    expect(tp.customer.update).toHaveBeenCalledWith({
      where: { id: "cust-1" },
      data: { gocardlessCustomerId: "CU123", gocardlessMandateId: "MD123", gocardlessMandateStatus: "pending_customer_approval" },
    });
  });
});
