import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";
import { Prisma } from "../../generated/tenant-client";

const tenantFindUnique = vi.fn();
vi.mock("../../lib/prisma", () => ({
  prisma: { tenant: { findUnique: (...args: unknown[]) => tenantFindUnique(...args) } },
}));

const constructEvent = vi.fn();
vi.mock("../../integrations/stripe/client", () => ({
  getStripeClient: vi.fn(() => ({ webhooks: { constructEvent: (...args: unknown[]) => constructEvent(...args) } })),
}));

const queueGhlEvent = vi.fn().mockResolvedValue(undefined);
vi.mock("../../integrations/ghl/sync", () => ({
  queueGhlEvent: (...args: unknown[]) => queueGhlEvent(...args),
}));

function makeTenantPrisma() {
  return {
    webhookEvent: { create: vi.fn().mockResolvedValue({}) },
    stripeSession: { findUnique: vi.fn(), update: vi.fn().mockResolvedValue({}), updateMany: vi.fn().mockResolvedValue({}) },
    customer: { update: vi.fn().mockResolvedValue({}) },
    invoice: { findUnique: vi.fn(), update: vi.fn().mockResolvedValue({}) },
    payment: { create: vi.fn().mockResolvedValue({}), update: vi.fn().mockResolvedValue({}), findFirst: vi.fn() },
    $transaction: vi.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
  };
}

const getTenantPrismaForSchema = vi.fn();
vi.mock("../../lib/tenant-prisma-manager", () => ({
  getTenantPrismaForSchema: (...args: unknown[]) => getTenantPrismaForSchema(...args),
}));

import { stripeWebhookRouter } from "../stripeWebhook";

function makeApp() {
  const app = express();
  app.use("/webhooks/stripe", express.raw({ type: "application/json" }), stripeWebhookRouter);
  return app;
}

function send(app: express.Express, body: unknown = { id: "evt_1" }) {
  return request(app)
    .post("/webhooks/stripe")
    .set("stripe-signature", "sig_test")
    .set("Content-Type", "application/json")
    .send(JSON.stringify(body));
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("POST /webhooks/stripe — config and signature", () => {
  it("500s when STRIPE_CONNECT_WEBHOOK_SECRET is not configured", async () => {
    const original = process.env.STRIPE_CONNECT_WEBHOOK_SECRET;
    delete process.env.STRIPE_CONNECT_WEBHOOK_SECRET;
    try {
      const res = await send(makeApp());
      expect(res.status).toBe(500);
    } finally {
      process.env.STRIPE_CONNECT_WEBHOOK_SECRET = original;
    }
  });

  it("400s when signature verification fails", async () => {
    constructEvent.mockImplementation(() => {
      throw new Error("bad signature");
    });
    const res = await send(makeApp());
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "Webhook signature verification failed" });
  });

  it("200s and does nothing for an event with no connected account", async () => {
    constructEvent.mockReturnValue({ id: "evt_1", account: null, type: "checkout.session.completed" });
    const res = await send(makeApp());
    expect(res.status).toBe(200);
    expect(tenantFindUnique).not.toHaveBeenCalled();
  });

  it("200s and does nothing when the connected account has no matching tenant", async () => {
    constructEvent.mockReturnValue({ id: "evt_1", account: "acct_unknown", type: "checkout.session.completed" });
    tenantFindUnique.mockResolvedValue(null);
    const res = await send(makeApp());
    expect(res.status).toBe(200);
    expect(getTenantPrismaForSchema).not.toHaveBeenCalled();
  });
});

describe("POST /webhooks/stripe — idempotency", () => {
  it("200s without processing when the event was already recorded (unique constraint)", async () => {
    constructEvent.mockReturnValue({ id: "evt_1", account: "acct_1", type: "checkout.session.completed" });
    tenantFindUnique.mockResolvedValue({ id: "tenant-1", schemaName: "tenant_1" });
    const tp = makeTenantPrisma();
    tp.webhookEvent.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("duplicate", { code: "P2002", clientVersion: "6.19.3" })
    );
    getTenantPrismaForSchema.mockReturnValue(tp);

    const res = await send(makeApp());
    expect(res.status).toBe(200);
    expect(tp.stripeSession.findUnique).not.toHaveBeenCalled();
  });

  it("500s and logs when recording the event fails for a non-duplicate reason", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    constructEvent.mockReturnValue({ id: "evt_1", account: "acct_1", type: "checkout.session.completed" });
    tenantFindUnique.mockResolvedValue({ id: "tenant-1", schemaName: "tenant_1" });
    const tp = makeTenantPrisma();
    tp.webhookEvent.create.mockRejectedValue(new Error("connection reset"));
    getTenantPrismaForSchema.mockReturnValue(tp);

    const res = await send(makeApp());
    expect(res.status).toBe(500);
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("failed to record webhook event"),
      expect.any(Error)
    );
    consoleSpy.mockRestore();
  });
});

describe("POST /webhooks/stripe — checkout.session.completed (ONE_TIME)", () => {
  function setup() {
    constructEvent.mockReturnValue({
      id: "evt_1",
      account: "acct_1",
      type: "checkout.session.completed",
      data: { object: { id: "cs_1", payment_intent: "pi_123" } },
    });
    tenantFindUnique.mockResolvedValue({ id: "tenant-1", schemaName: "tenant_1" });
    const tp = makeTenantPrisma();
    getTenantPrismaForSchema.mockReturnValue(tp);
    return tp;
  }

  it("does nothing when no matching StripeSession is found", async () => {
    const tp = setup();
    tp.stripeSession.findUnique.mockResolvedValue(null);

    const res = await send(makeApp());
    expect(res.status).toBe(200);
    await vi.waitFor(() => expect(tp.stripeSession.findUnique).toHaveBeenCalled());
    expect(tp.stripeSession.update).not.toHaveBeenCalled();
  });

  it("does nothing when the session has no linked invoice", async () => {
    const tp = setup();
    tp.stripeSession.findUnique.mockResolvedValue({ id: "sess-1", type: "ONE_TIME", invoiceId: null });

    await send(makeApp());
    await vi.waitFor(() => expect(tp.stripeSession.update).toHaveBeenCalled());
    expect(tp.invoice.findUnique).not.toHaveBeenCalled();
  });

  it("does nothing when the invoice is already PAID", async () => {
    const tp = setup();
    tp.stripeSession.findUnique.mockResolvedValue({ id: "sess-1", type: "ONE_TIME", invoiceId: "inv-1" });
    tp.invoice.findUnique.mockResolvedValue({ id: "inv-1", status: "PAID" });

    await send(makeApp());
    await vi.waitFor(() => expect(tp.invoice.findUnique).toHaveBeenCalled());
    expect(tp.payment.create).not.toHaveBeenCalled();
  });

  it("does nothing when the invoice no longer exists", async () => {
    const tp = setup();
    tp.stripeSession.findUnique.mockResolvedValue({ id: "sess-1", type: "ONE_TIME", invoiceId: "inv-1" });
    tp.invoice.findUnique.mockResolvedValue(null);

    await send(makeApp());
    await vi.waitFor(() => expect(tp.invoice.findUnique).toHaveBeenCalled());
    expect(tp.payment.create).not.toHaveBeenCalled();
  });

  it("creates a PAID Payment, marks the Invoice PAID, and queues a GHL event on the happy path", async () => {
    const tp = setup();
    tp.stripeSession.findUnique.mockResolvedValue({
      id: "sess-1", type: "ONE_TIME", invoiceId: "inv-1", amountTotal: 35, customerId: "cust-1",
    });
    tp.invoice.findUnique.mockResolvedValue({ id: "inv-1", status: "DRAFT", customerId: "cust-1", visitId: "visit-1", amount: 35 });

    await send(makeApp());

    await vi.waitFor(() => expect(tp.payment.create).toHaveBeenCalled());
    expect(tp.payment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ customerId: "cust-1", visitId: "visit-1", amount: 35, stripeId: "pi_123" }),
      })
    );
    expect(tp.invoice.update).toHaveBeenCalledWith({ where: { id: "inv-1" }, data: { status: "PAID" } });
    await vi.waitFor(() => expect(queueGhlEvent).toHaveBeenCalledWith(tp, "payment.collected", "cust-1"));
  });

  it("resolves the PaymentIntent id from an expanded object instead of a string", async () => {
    constructEvent.mockReturnValue({
      id: "evt_1",
      account: "acct_1",
      type: "checkout.session.completed",
      data: { object: { id: "cs_1", payment_intent: { id: "pi_expanded" } } },
    });
    tenantFindUnique.mockResolvedValue({ id: "tenant-1", schemaName: "tenant_1" });
    const tp = makeTenantPrisma();
    getTenantPrismaForSchema.mockReturnValue(tp);
    tp.stripeSession.findUnique.mockResolvedValue({ id: "sess-1", type: "ONE_TIME", invoiceId: "inv-1", amountTotal: null, customerId: "cust-1" });
    tp.invoice.findUnique.mockResolvedValue({ id: "inv-1", status: "DRAFT", customerId: "cust-1", visitId: null, amount: 35 });

    await send(makeApp());

    await vi.waitFor(() => expect(tp.payment.create).toHaveBeenCalled());
    expect(tp.payment.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ stripeId: "pi_expanded", amount: 35, visitId: undefined }) })
    );
  });

  it("falls back to a null PaymentIntent id when payment_intent is absent", async () => {
    constructEvent.mockReturnValue({
      id: "evt_1",
      account: "acct_1",
      type: "checkout.session.completed",
      data: { object: { id: "cs_1", payment_intent: null } },
    });
    tenantFindUnique.mockResolvedValue({ id: "tenant-1", schemaName: "tenant_1" });
    const tp = makeTenantPrisma();
    getTenantPrismaForSchema.mockReturnValue(tp);
    tp.stripeSession.findUnique.mockResolvedValue({ id: "sess-1", type: "ONE_TIME", invoiceId: "inv-1", amountTotal: 35, customerId: "cust-1" });
    tp.invoice.findUnique.mockResolvedValue({ id: "inv-1", status: "DRAFT", customerId: "cust-1", visitId: null, amount: 35 });

    await send(makeApp());

    await vi.waitFor(() => expect(tp.payment.create).toHaveBeenCalled());
    expect(tp.payment.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ stripeId: null }) })
    );
  });
});

describe("POST /webhooks/stripe — checkout.session.completed (SETUP)", () => {
  function setup(setupIntent: unknown) {
    constructEvent.mockReturnValue({
      id: "evt_1",
      account: "acct_1",
      type: "checkout.session.completed",
      data: { object: { id: "cs_1", setup_intent: setupIntent } },
    });
    tenantFindUnique.mockResolvedValue({ id: "tenant-1", schemaName: "tenant_1" });
    const tp = makeTenantPrisma();
    tp.stripeSession.findUnique.mockResolvedValue({ id: "sess-1", type: "SETUP", customerId: "cust-1" });
    getTenantPrismaForSchema.mockReturnValue(tp);
    return tp;
  }

  it("saves setup_intent itself as the default payment method id when it's a plain (unexpanded) string", async () => {
    const tp = setup("seti_123");
    await send(makeApp());
    await vi.waitFor(() => expect(tp.customer.update).toHaveBeenCalledWith({
      where: { id: "cust-1" },
      data: { stripeDefaultPaymentMethodId: "seti_123" },
    }));
  });

  it("saves the default payment method from an expanded setup_intent object", async () => {
    const tp = setup({ payment_method: "pm_123" });
    await send(makeApp());
    await vi.waitFor(() => expect(tp.customer.update).toHaveBeenCalled());
    expect(tp.customer.update).toHaveBeenCalledWith({
      where: { id: "cust-1" },
      data: { stripeDefaultPaymentMethodId: "pm_123" },
    });
  });

  it("does nothing when setup_intent is absent", async () => {
    const tp = setup(null);
    await send(makeApp());
    await vi.waitFor(() => expect(tp.stripeSession.update).toHaveBeenCalled());
    expect(tp.customer.update).not.toHaveBeenCalled();
  });

  it("does nothing when the expanded setup_intent has no payment_method", async () => {
    const tp = setup({ payment_method: null });
    await send(makeApp());
    await vi.waitFor(() => expect(tp.stripeSession.update).toHaveBeenCalled());
    expect(tp.customer.update).not.toHaveBeenCalled();
  });
});

describe("POST /webhooks/stripe — checkout.session.expired", () => {
  it("marks the StripeSession EXPIRED", async () => {
    constructEvent.mockReturnValue({
      id: "evt_1",
      account: "acct_1",
      type: "checkout.session.expired",
      data: { object: { id: "cs_1" } },
    });
    tenantFindUnique.mockResolvedValue({ id: "tenant-1", schemaName: "tenant_1" });
    const tp = makeTenantPrisma();
    getTenantPrismaForSchema.mockReturnValue(tp);

    await send(makeApp());

    await vi.waitFor(() => expect(tp.stripeSession.updateMany).toHaveBeenCalledWith({
      where: { stripeSessionId: "cs_1" },
      data: { status: "EXPIRED" },
    }));
  });
});

describe("POST /webhooks/stripe — payment_intent.payment_failed", () => {
  function setup(piOverrides: Record<string, unknown> = {}) {
    constructEvent.mockReturnValue({
      id: "evt_1",
      account: "acct_1",
      type: "payment_intent.payment_failed",
      data: { object: { id: "pi_1", metadata: { invoiceId: "inv-1" }, ...piOverrides } },
    });
    tenantFindUnique.mockResolvedValue({ id: "tenant-1", schemaName: "tenant_1" });
    const tp = makeTenantPrisma();
    getTenantPrismaForSchema.mockReturnValue(tp);
    return tp;
  }

  it("does nothing when metadata has no invoiceId", async () => {
    constructEvent.mockReturnValue({
      id: "evt_1",
      account: "acct_1",
      type: "payment_intent.payment_failed",
      data: { object: { id: "pi_1", metadata: {} } },
    });
    tenantFindUnique.mockResolvedValue({ id: "tenant-1", schemaName: "tenant_1" });
    const tp = makeTenantPrisma();
    getTenantPrismaForSchema.mockReturnValue(tp);

    const res = await send(makeApp());
    expect(res.status).toBe(200);
    await vi.waitFor(() => expect(res.status).toBe(200));
    expect(tp.invoice.findUnique).not.toHaveBeenCalled();
  });

  it("does nothing when the invoice no longer exists", async () => {
    const tp = setup();
    tp.invoice.findUnique.mockResolvedValue(null);
    await send(makeApp());
    await vi.waitFor(() => expect(tp.invoice.findUnique).toHaveBeenCalled());
    expect(tp.payment.findFirst).not.toHaveBeenCalled();
  });

  it("updates an existing Payment row to FAILED", async () => {
    const tp = setup();
    tp.invoice.findUnique.mockResolvedValue({ id: "inv-1", customerId: "cust-1", visitId: "visit-1", amount: 35 });
    tp.payment.findFirst.mockResolvedValue({ id: "pay-1" });

    await send(makeApp());

    await vi.waitFor(() => expect(tp.payment.update).toHaveBeenCalledWith({
      where: { id: "pay-1" },
      data: { status: "FAILED" },
    }));
  });

  it("creates a new FAILED Payment row when none exists yet", async () => {
    const tp = setup();
    tp.invoice.findUnique.mockResolvedValue({ id: "inv-1", customerId: "cust-1", visitId: null, amount: 35 });
    tp.payment.findFirst.mockResolvedValue(null);

    await send(makeApp());

    await vi.waitFor(() => expect(tp.payment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ customerId: "cust-1", visitId: undefined, amount: 35, status: "FAILED", stripeId: "pi_1" }),
      })
    ));
  });
});

describe("POST /webhooks/stripe — unhandled event types and async failures", () => {
  it("200s and takes no action for an event type with no handler", async () => {
    constructEvent.mockReturnValue({ id: "evt_1", account: "acct_1", type: "customer.created", data: { object: {} } });
    tenantFindUnique.mockResolvedValue({ id: "tenant-1", schemaName: "tenant_1" });
    const tp = makeTenantPrisma();
    getTenantPrismaForSchema.mockReturnValue(tp);

    const res = await send(makeApp());
    expect(res.status).toBe(200);
  });

  it("logs, rather than crashes, when async event handling throws", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    constructEvent.mockReturnValue({
      id: "evt_1",
      account: "acct_1",
      type: "checkout.session.expired",
      data: { object: { id: "cs_1" } },
    });
    tenantFindUnique.mockResolvedValue({ id: "tenant-1", schemaName: "tenant_1" });
    const tp = makeTenantPrisma();
    tp.stripeSession.updateMany.mockRejectedValue(new Error("db down"));
    getTenantPrismaForSchema.mockReturnValue(tp);

    const res = await send(makeApp());
    expect(res.status).toBe(200);
    await vi.waitFor(() => expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("event evt_1 failed"),
      expect.any(Error)
    ));
    consoleSpy.mockRestore();
  });
});
