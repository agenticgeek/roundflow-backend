import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";
import { StripeSessionType } from "../../generated/tenant-client";

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
vi.mock("../../lib/crypto", () => ({
  decrypt: vi.fn(() => "sk_test_decrypted"),
}));
vi.mock("../../integrations/stripe/client", () => ({
  getStripeClient: vi.fn(() => ({ fake: "stripe-client" })),
}));

const queueGhlEvent = vi.fn().mockResolvedValue(undefined);
vi.mock("../../integrations/ghl/sync", () => ({
  queueGhlEvent: (...args: unknown[]) => queueGhlEvent(...args),
}));

const createOneTimeSession = vi.fn();
const createSetupSession = vi.fn();
vi.mock("../../integrations/stripe/checkout", () => ({
  createOneTimeSession: (...args: unknown[]) => createOneTimeSession(...args),
  createSetupSession: (...args: unknown[]) => createSetupSession(...args),
}));

import { paymentsRouter } from "../payments";

function makeTenantPrisma() {
  return {
    businessSettings: { findFirst: vi.fn() },
    invoice: { findUnique: vi.fn(), updateMany: vi.fn().mockResolvedValue({}) },
    stripeSession: { findFirst: vi.fn(), create: vi.fn() },
    customer: { findUniqueOrThrow: vi.fn(), findUnique: vi.fn() },
    payment: { findUnique: vi.fn(), update: vi.fn().mockResolvedValue({}) },
  };
}

function makeApp(tenantPrisma: ReturnType<typeof makeTenantPrisma>) {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.tenantPrisma = tenantPrisma;
    next();
  });
  app.use("/payments", paymentsRouter);
  app.use((err: any, _req: any, res: any, _next: any) => {
    res.status(err.statusCode ?? 500).json({ error: err.message ?? "Internal error" });
  });
  return app;
}

const connectedBusinessSettings = {
  stripeConnected: true,
  stripeSecretKeyEncrypted: "encrypted-secret",
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("POST /payments/stripe/checkout", () => {
  it("falls back to an empty-string frontend URL when FRONTEND_URL is unset", async () => {
    const original = process.env.FRONTEND_URL;
    delete process.env.FRONTEND_URL;
    try {
      const tp = makeTenantPrisma();
      tp.businessSettings.findFirst.mockResolvedValue(connectedBusinessSettings);
      tp.invoice.findUnique.mockResolvedValue({
        id: "inv-1", status: "DRAFT", customerId: "cust-1", invoiceNumber: "INV-2026-001", amount: 35,
      });
      tp.stripeSession.findFirst.mockResolvedValue(null);
      tp.customer.findUniqueOrThrow.mockResolvedValue({ id: "cust-1" });
      createOneTimeSession.mockResolvedValue({
        stripeSessionId: "cs_new_123",
        url: "https://checkout.stripe.com/pay/cs_new_123",
        expiresAt: null,
      });
      tp.stripeSession.create.mockResolvedValue({ id: "sess-new", url: "https://checkout.stripe.com/pay/cs_new_123" });

      const res = await request(makeApp(tp)).post("/payments/stripe/checkout").send({ invoiceId: "inv-1" });

      expect(res.status).toBe(201);
      expect(createOneTimeSession).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.objectContaining({ successUrl: "/invoices/inv-1?payment=success" })
      );
    } finally {
      process.env.FRONTEND_URL = original;
    }
  });


  it("400s when Stripe is not connected", async () => {
    const tp = makeTenantPrisma();
    tp.businessSettings.findFirst.mockResolvedValue({ stripeConnected: false, stripeSecretKeyEncrypted: null });
    tp.invoice.findUnique.mockResolvedValue({ id: "inv-1", status: "DRAFT", customerId: "cust-1", invoiceNumber: "INV-1", amount: 35 });
    tp.stripeSession.findFirst.mockResolvedValue(null);
    tp.customer.findUniqueOrThrow.mockResolvedValue({ id: "cust-1" });

    const res = await request(makeApp(tp)).post("/payments/stripe/checkout").send({ invoiceId: "inv-1" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Stripe is not connected/);
  });

  it("404s when the invoice does not exist", async () => {
    const tp = makeTenantPrisma();
    tp.businessSettings.findFirst.mockResolvedValue(connectedBusinessSettings);
    tp.invoice.findUnique.mockResolvedValue(null);

    const res = await request(makeApp(tp)).post("/payments/stripe/checkout").send({ invoiceId: "inv-1" });

    expect(res.status).toBe(404);
  });

  it("409s when the invoice is already PAID", async () => {
    const tp = makeTenantPrisma();
    tp.businessSettings.findFirst.mockResolvedValue(connectedBusinessSettings);
    tp.invoice.findUnique.mockResolvedValue({ id: "inv-1", status: "PAID" });

    const res = await request(makeApp(tp)).post("/payments/stripe/checkout").send({ invoiceId: "inv-1" });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already paid/);
  });

  it("409s when the invoice is VOID", async () => {
    const tp = makeTenantPrisma();
    tp.businessSettings.findFirst.mockResolvedValue(connectedBusinessSettings);
    tp.invoice.findUnique.mockResolvedValue({ id: "inv-1", status: "VOID" });

    const res = await request(makeApp(tp)).post("/payments/stripe/checkout").send({ invoiceId: "inv-1" });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/void/);
  });

  it("returns the existing PENDING session instead of creating a new one", async () => {
    const tp = makeTenantPrisma();
    tp.businessSettings.findFirst.mockResolvedValue(connectedBusinessSettings);
    tp.invoice.findUnique.mockResolvedValue({ id: "inv-1", status: "DRAFT", customerId: "cust-1", invoiceNumber: "INV-1", amount: 35 });
    tp.stripeSession.findFirst.mockResolvedValue({ id: "sess-1", url: "https://checkout.stripe.com/pay/cs_existing" });

    const res = await request(makeApp(tp)).post("/payments/stripe/checkout").send({ invoiceId: "inv-1" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ url: "https://checkout.stripe.com/pay/cs_existing", sessionId: "sess-1" });
    expect(createOneTimeSession).not.toHaveBeenCalled();
  });

  it("creates a new one-time checkout session on the happy path", async () => {
    const tp = makeTenantPrisma();
    tp.businessSettings.findFirst.mockResolvedValue(connectedBusinessSettings);
    tp.invoice.findUnique.mockResolvedValue({
      id: "inv-1", status: "DRAFT", customerId: "cust-1", invoiceNumber: "INV-2026-001", amount: 35,
    });
    tp.stripeSession.findFirst.mockResolvedValue(null);
    tp.customer.findUniqueOrThrow.mockResolvedValue({ id: "cust-1" });
    createOneTimeSession.mockResolvedValue({
      stripeSessionId: "cs_new_123",
      url: "https://checkout.stripe.com/pay/cs_new_123",
      expiresAt: new Date("2026-01-01T00:00:00Z"),
    });
    tp.stripeSession.create.mockResolvedValue({ id: "sess-new", url: "https://checkout.stripe.com/pay/cs_new_123" });

    const res = await request(makeApp(tp)).post("/payments/stripe/checkout").send({ invoiceId: "inv-1" });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ url: "https://checkout.stripe.com/pay/cs_new_123", sessionId: "sess-new" });
    expect(createOneTimeSession).toHaveBeenCalledWith(
      { fake: "stripe-client" },
      tp,
      expect.objectContaining({
        tenantId: "tenant-1",
        customerId: "cust-1",
        invoiceId: "inv-1",
        invoiceNumber: "INV-2026-001",
        amountPence: 3500,
      })
    );
    expect(tp.stripeSession.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          stripeSessionId: "cs_new_123",
          type: StripeSessionType.ONE_TIME,
        }),
      })
    );
  });
});

describe("POST /payments/stripe/setup", () => {
  it("400s when Stripe is not connected", async () => {
    const tp = makeTenantPrisma();
    tp.businessSettings.findFirst.mockResolvedValue({ stripeConnected: false, stripeSecretKeyEncrypted: null });
    tp.customer.findUnique.mockResolvedValue({ id: "cust-1" });

    const res = await request(makeApp(tp)).post("/payments/stripe/setup").send({ customerId: "cust-1" });

    expect(res.status).toBe(400);
  });

  it("404s when the customer does not exist", async () => {
    const tp = makeTenantPrisma();
    tp.businessSettings.findFirst.mockResolvedValue(connectedBusinessSettings);
    tp.customer.findUnique.mockResolvedValue(null);

    const res = await request(makeApp(tp)).post("/payments/stripe/setup").send({ customerId: "cust-1" });

    expect(res.status).toBe(404);
  });

  it("creates a new setup session on the happy path", async () => {
    const tp = makeTenantPrisma();
    tp.businessSettings.findFirst.mockResolvedValue(connectedBusinessSettings);
    tp.customer.findUnique.mockResolvedValue({ id: "cust-1" });
    createSetupSession.mockResolvedValue({
      stripeSessionId: "seti_123",
      url: "https://checkout.stripe.com/pay/seti_123",
      expiresAt: null,
    });
    tp.stripeSession.create.mockResolvedValue({ id: "sess-setup", url: "https://checkout.stripe.com/pay/seti_123" });

    const res = await request(makeApp(tp)).post("/payments/stripe/setup").send({ customerId: "cust-1" });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ url: "https://checkout.stripe.com/pay/seti_123", sessionId: "sess-setup" });
    expect(createSetupSession).toHaveBeenCalledWith(
      { fake: "stripe-client" },
      tp,
      expect.objectContaining({ tenantId: "tenant-1", customerId: "cust-1" })
    );
    expect(tp.stripeSession.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ type: StripeSessionType.SETUP }),
      })
    );
  });
});

describe("PATCH /payments/:id/status", () => {
  it("400s when status is not PAID or FAILED", async () => {
    const tp = makeTenantPrisma();
    const res = await request(makeApp(tp)).patch("/payments/pay-1/status").send({ status: "PENDING" });
    expect(res.status).toBe(400);
  });

  it("404s when the payment does not exist", async () => {
    const tp = makeTenantPrisma();
    tp.payment.findUnique.mockResolvedValue(null);
    const res = await request(makeApp(tp)).patch("/payments/pay-1/status").send({ status: "PAID" });
    expect(res.status).toBe(404);
  });

  it("409s for a GoCardless payment (webhook-only, no manual override)", async () => {
    const tp = makeTenantPrisma();
    tp.payment.findUnique.mockResolvedValue({ id: "pay-1", method: "GOCARDLESS", status: "PENDING" });
    const res = await request(makeApp(tp)).patch("/payments/pay-1/status").send({ status: "PAID" });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/BACS and cheque/);
  });

  it("409s when the payment is already PAID", async () => {
    const tp = makeTenantPrisma();
    tp.payment.findUnique.mockResolvedValue({ id: "pay-1", method: "BACS", status: "PAID" });
    const res = await request(makeApp(tp)).patch("/payments/pay-1/status").send({ status: "FAILED" });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already paid/);
  });

  it("marks a BACS payment PAID, flips the invoice, and queues payment.collected", async () => {
    const tp = makeTenantPrisma();
    const row = { id: "pay-1", method: "BACS", status: "PENDING", customerId: "cust-1", visitId: "visit-1", paidAt: null };
    tp.payment.findUnique.mockResolvedValue(row);

    const res = await request(makeApp(tp)).patch("/payments/pay-1/status").send({ status: "PAID" });

    expect(res.status).toBe(200);
    expect(tp.payment.update).toHaveBeenCalledWith({
      where: { id: "pay-1" },
      data: { status: "PAID", paidAt: expect.any(Date) },
    });
    expect(tp.invoice.updateMany).toHaveBeenCalledWith({
      where: { visitId: "visit-1", status: { not: "PAID" } },
      data: { status: "PAID" },
    });
    expect(queueGhlEvent).toHaveBeenCalledWith(tp, "payment.collected", "cust-1");
  });

  it("marks a CHEQUE payment FAILED and queues payment.failed without touching the invoice", async () => {
    const tp = makeTenantPrisma();
    const row = { id: "pay-2", method: "CHEQUE", status: "PENDING", customerId: "cust-2", visitId: "visit-2", paidAt: null };
    tp.payment.findUnique.mockResolvedValue(row);

    const res = await request(makeApp(tp)).patch("/payments/pay-2/status").send({ status: "FAILED" });

    expect(res.status).toBe(200);
    expect(tp.payment.update).toHaveBeenCalledWith({
      where: { id: "pay-2" },
      data: { status: "FAILED", paidAt: null },
    });
    expect(tp.invoice.updateMany).not.toHaveBeenCalled();
    expect(queueGhlEvent).toHaveBeenCalledWith(tp, "payment.failed", "cust-2");
  });
});
