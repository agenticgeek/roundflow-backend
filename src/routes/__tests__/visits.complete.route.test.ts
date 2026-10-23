import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";
import { PaymentMethod, VisitStatus } from "../../generated/tenant-client";

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

const queueGhlEvent = vi.fn().mockResolvedValue(undefined);
vi.mock("../../integrations/ghl/sync", () => ({
  queueGhlEvent: (...args: unknown[]) => queueGhlEvent(...args),
}));

const decrypt = vi.fn((..._args: unknown[]) => "decrypted-access-token");
vi.mock("../../lib/crypto", () => ({
  decrypt: (...args: unknown[]) => decrypt(...args),
}));

const getGcClient = vi.fn((..._args: unknown[]) => ({ fake: "gc-client" }));
vi.mock("../../integrations/gocardless/client", () => ({
  getGcClient: (...args: unknown[]) => getGcClient(...args),
}));

const createGcPayment = vi.fn();
vi.mock("../../integrations/gocardless/payment", () => ({
  createGcPayment: (...args: unknown[]) => createGcPayment(...args),
}));

import { visitsRouter } from "../visits";

function makeTenantPrisma() {
  return {
    visit: { findUnique: vi.fn(), update: vi.fn() },
    businessSettings: { findFirst: vi.fn() },
    payment: { create: vi.fn().mockResolvedValue({}) },
  };
}

function makeApp(tp: ReturnType<typeof makeTenantPrisma> = makeTenantPrisma()) {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.tenantPrisma = tp;
    next();
  });
  app.use("/visits", visitsRouter);
  app.use((err: any, _req: any, res: any, _next: any) => {
    res.status(err.statusCode ?? 500).json({ error: err.message ?? "Internal error" });
  });
  return app;
}

function baseVisit(overrides: Record<string, unknown> = {}) {
  return {
    id: "visit-1",
    status: VisitStatus.SCHEDULED,
    price: { toNumber: () => 35 },
    paymentMethod: null,
    servicePlan: null,
    payment: null,
    property: { customer: { id: "cust-1", paymentMethod: null, gocardlessMandateId: null, gocardlessMandateStatus: null } },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("PATCH /visits/:id/complete", () => {
  it("404s when the visit does not exist", async () => {
    const tp = makeTenantPrisma();
    tp.visit.findUnique.mockResolvedValue(null);
    const res = await request(makeApp(tp)).patch("/visits/visit-1/complete").send({});
    expect(res.status).toBe(404);
  });

  it("returns the current status idempotently when already COMPLETED", async () => {
    const tp = makeTenantPrisma();
    tp.visit.findUnique.mockResolvedValue(baseVisit({ status: VisitStatus.COMPLETED }));
    const res = await request(makeApp(tp)).patch("/visits/visit-1/complete").send({});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: "visit-1", status: VisitStatus.COMPLETED });
    expect(tp.visit.update).not.toHaveBeenCalled();
  });

  it("409s when the visit is SKIPPED", async () => {
    const tp = makeTenantPrisma();
    tp.visit.findUnique.mockResolvedValue(baseVisit({ status: VisitStatus.SKIPPED }));
    const res = await request(makeApp(tp)).patch("/visits/visit-1/complete").send({});
    expect(res.status).toBe(409);
  });

  describe("GOCARDLESS", () => {
    function gcVisit(customerOverrides: Record<string, unknown> = {}) {
      return baseVisit({
        paymentMethod: PaymentMethod.GOCARDLESS,
        property: {
          customer: {
            id: "cust-1",
            paymentMethod: null,
            gocardlessMandateId: "MD123",
            gocardlessMandateStatus: "active",
            ...customerOverrides,
          },
        },
      });
    }

    it("creates a PENDING payment and charges via GoCardless on the happy path", async () => {
      const tp = makeTenantPrisma();
      tp.visit.findUnique.mockResolvedValue(gcVisit());
      tp.visit.update.mockResolvedValue({ id: "visit-1", status: VisitStatus.COMPLETED });
      tp.businessSettings.findFirst.mockResolvedValue({ gocardlessAccessTokenEncrypted: "enc", gocardlessEnvironment: "sandbox" });
      createGcPayment.mockResolvedValue({ id: "PM123", status: "pending_submission" });

      const res = await request(makeApp(tp)).patch("/visits/visit-1/complete").send({});

      expect(res.status).toBe(200);
      expect(getGcClient).toHaveBeenCalledWith("decrypted-access-token", "sandbox");
      expect(createGcPayment).toHaveBeenCalledWith(
        { fake: "gc-client" },
        expect.objectContaining({ mandateId: "MD123", amountPence: 3500 })
      );
      expect(tp.payment.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ method: PaymentMethod.GOCARDLESS, status: "PENDING", gocardlessId: "PM123" }),
        })
      );
      expect(queueGhlEvent).toHaveBeenCalledWith(tp, "visit.completed", "cust-1", { visitId: "visit-1" });
    });

    it("skips charging when the mandate is not active", async () => {
      const tp = makeTenantPrisma();
      tp.visit.findUnique.mockResolvedValue(gcVisit({ gocardlessMandateStatus: "pending_customer_approval" }));
      tp.visit.update.mockResolvedValue({ id: "visit-1", status: VisitStatus.COMPLETED });

      const res = await request(makeApp(tp)).patch("/visits/visit-1/complete").send({});

      expect(res.status).toBe(200);
      expect(createGcPayment).not.toHaveBeenCalled();
      expect(tp.payment.create).not.toHaveBeenCalled();
    });

    it("skips charging when there is no mandate id at all", async () => {
      const tp = makeTenantPrisma();
      tp.visit.findUnique.mockResolvedValue(gcVisit({ gocardlessMandateId: null }));
      tp.visit.update.mockResolvedValue({ id: "visit-1", status: VisitStatus.COMPLETED });

      await request(makeApp(tp)).patch("/visits/visit-1/complete").send({});

      expect(createGcPayment).not.toHaveBeenCalled();
    });

    it("skips charging when GoCardless has no stored access token", async () => {
      const tp = makeTenantPrisma();
      tp.visit.findUnique.mockResolvedValue(gcVisit());
      tp.visit.update.mockResolvedValue({ id: "visit-1", status: VisitStatus.COMPLETED });
      tp.businessSettings.findFirst.mockResolvedValue({ gocardlessAccessTokenEncrypted: null });

      await request(makeApp(tp)).patch("/visits/visit-1/complete").send({});

      expect(createGcPayment).not.toHaveBeenCalled();
    });

    it("defaults the GoCardless environment to sandbox when unset", async () => {
      const tp = makeTenantPrisma();
      tp.visit.findUnique.mockResolvedValue(gcVisit());
      tp.visit.update.mockResolvedValue({ id: "visit-1", status: VisitStatus.COMPLETED });
      tp.businessSettings.findFirst.mockResolvedValue({ gocardlessAccessTokenEncrypted: "enc", gocardlessEnvironment: null });
      createGcPayment.mockResolvedValue({ id: "PM123", status: "pending_submission" });

      await request(makeApp(tp)).patch("/visits/visit-1/complete").send({});

      expect(getGcClient).toHaveBeenCalledWith("decrypted-access-token", "sandbox");
    });
  });

  describe("CASH", () => {
    it("400s when cashConfirmed is not provided", async () => {
      const tp = makeTenantPrisma();
      tp.visit.findUnique.mockResolvedValue(baseVisit({ paymentMethod: PaymentMethod.CASH }));
      tp.visit.update.mockResolvedValue({ id: "visit-1", status: VisitStatus.COMPLETED });

      const res = await request(makeApp(tp)).patch("/visits/visit-1/complete").send({});

      expect(res.status).toBe(400);
    });

    it("creates a PAID payment when cashConfirmed is true", async () => {
      const tp = makeTenantPrisma();
      tp.visit.findUnique.mockResolvedValue(baseVisit({ paymentMethod: PaymentMethod.CASH }));
      tp.visit.update.mockResolvedValue({ id: "visit-1", status: VisitStatus.COMPLETED });

      const res = await request(makeApp(tp)).patch("/visits/visit-1/complete").send({ cashConfirmed: true });

      expect(res.status).toBe(200);
      expect(tp.payment.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ method: PaymentMethod.CASH, status: "PAID" }),
        })
      );
    });
  });

  describe("BACS / CHEQUE", () => {
    it.each([PaymentMethod.BACS, PaymentMethod.CHEQUE])("creates a PENDING payment for %s", async (method) => {
      const tp = makeTenantPrisma();
      tp.visit.findUnique.mockResolvedValue(baseVisit({ paymentMethod: method }));
      tp.visit.update.mockResolvedValue({ id: "visit-1", status: VisitStatus.COMPLETED });

      const res = await request(makeApp(tp)).patch("/visits/visit-1/complete").send({});

      expect(res.status).toBe(200);
      expect(tp.payment.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ method, status: "PENDING" }) })
      );
    });
  });

  it("creates no payment when there is no resolvable payment method", async () => {
    const tp = makeTenantPrisma();
    tp.visit.findUnique.mockResolvedValue(baseVisit({ paymentMethod: null }));
    tp.visit.update.mockResolvedValue({ id: "visit-1", status: VisitStatus.COMPLETED });

    const res = await request(makeApp(tp)).patch("/visits/visit-1/complete").send({});

    expect(res.status).toBe(200);
    expect(tp.payment.create).not.toHaveBeenCalled();
  });

  it("resolves the effective payment method from servicePlan when the visit has none", async () => {
    const tp = makeTenantPrisma();
    tp.visit.findUnique.mockResolvedValue(baseVisit({ paymentMethod: null, servicePlan: { paymentMethod: PaymentMethod.CASH } }));
    tp.visit.update.mockResolvedValue({ id: "visit-1", status: VisitStatus.COMPLETED });

    const res = await request(makeApp(tp)).patch("/visits/visit-1/complete").send({ cashConfirmed: true });

    expect(res.status).toBe(200);
    expect(tp.payment.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ method: PaymentMethod.CASH }) })
    );
  });

  it("resolves the effective payment method from the customer when neither visit nor servicePlan has one", async () => {
    const tp = makeTenantPrisma();
    tp.visit.findUnique.mockResolvedValue(
      baseVisit({
        paymentMethod: null,
        servicePlan: null,
        property: { customer: { id: "cust-1", paymentMethod: PaymentMethod.CASH, gocardlessMandateId: null, gocardlessMandateStatus: null } },
      })
    );
    tp.visit.update.mockResolvedValue({ id: "visit-1", status: VisitStatus.COMPLETED });

    const res = await request(makeApp(tp)).patch("/visits/visit-1/complete").send({ cashConfirmed: true });

    expect(res.status).toBe(200);
    expect(tp.payment.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ method: PaymentMethod.CASH }) })
    );
  });

  it("skips creating a payment entirely when one already exists for this visit", async () => {
    const tp = makeTenantPrisma();
    tp.visit.findUnique.mockResolvedValue(baseVisit({ paymentMethod: PaymentMethod.CASH, payment: { id: "pay-existing" } }));
    tp.visit.update.mockResolvedValue({ id: "visit-1", status: VisitStatus.COMPLETED });

    const res = await request(makeApp(tp)).patch("/visits/visit-1/complete").send({ cashConfirmed: true });

    expect(res.status).toBe(200);
    expect(tp.payment.create).not.toHaveBeenCalled();
  });
});
