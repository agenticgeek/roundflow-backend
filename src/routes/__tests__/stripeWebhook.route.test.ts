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

const transition = vi.fn().mockResolvedValue({ changed: true });
vi.mock("../../services/payment.service", () => ({
  createPaymentService: () => ({ transition: (...args: unknown[]) => transition(...args) }),
}));
const notifyPaymentEvent = vi.fn().mockResolvedValue(undefined);
vi.mock("../../services/notify", () => ({ notifyPaymentEvent: (...a: unknown[]) => notifyPaymentEvent(...a) }));

function makeTenantPrisma() {
  return {
    webhookEvent: { create: vi.fn().mockResolvedValue({}), findUnique: vi.fn(), updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    stripeSession: { findUnique: vi.fn(), update: vi.fn().mockResolvedValue({}), updateMany: vi.fn().mockResolvedValue({}) },
    customer: { update: vi.fn().mockResolvedValue({}) },
    invoice: { findUnique: vi.fn(), updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    payment: { create: vi.fn().mockResolvedValue({}), update: vi.fn().mockResolvedValue({}), findUnique: vi.fn() },
    activityLog: { create: vi.fn().mockResolvedValue({}) },
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
  it("503 WEBHOOK_NOT_CONFIGURED (and logs) when STRIPE_CONNECT_WEBHOOK_SECRET is not configured", async () => {
    const original = process.env.STRIPE_CONNECT_WEBHOOK_SECRET;
    delete process.env.STRIPE_CONNECT_WEBHOOK_SECRET;
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const res = await send(makeApp());
      expect(res.status).toBe(503);
      expect(res.body).toEqual({ error: "Stripe webhook is not configured", code: "WEBHOOK_NOT_CONFIGURED" });
      expect(err).toHaveBeenCalledWith(expect.stringContaining("STRIPE_CONNECT_WEBHOOK_SECRET"));
    } finally {
      process.env.STRIPE_CONNECT_WEBHOOK_SECRET = original;
      err.mockRestore();
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

const dupError = () => new Prisma.PrismaClientKnownRequestError("duplicate", { code: "P2002", clientVersion: "6.19.3" });

function ready(tp = makeTenantPrisma()) {
  tenantFindUnique.mockResolvedValue({ id: "tenant-1", schemaName: "tenant_1" });
  getTenantPrismaForSchema.mockReturnValue(tp);
  return tp;
}
const ev = (type: string, object: unknown, id = "evt_1") => ({ id, account: "acct_1", type, data: { object } });
const deliver = (event: unknown) => {
  constructEvent.mockReturnValue(event);
  return send(makeApp());
};

describe("POST /webhooks/stripe — process-then-ack (BE-03)", () => {
  it("records the event RECEIVED with its payload, runs the effect, marks DONE, answers 200", async () => {
    const tp = ready();
    const event = ev("checkout.session.expired", { id: "cs_1" });
    const res = await deliver(event);
    expect(res.status).toBe(200);
    expect(tp.webhookEvent.create).toHaveBeenCalledWith({
      data: { source: "stripe", externalId: "evt_1", status: "RECEIVED", payload: event },
    });
    expect(tp.stripeSession.updateMany).toHaveBeenCalledWith({ where: { stripeSessionId: "cs_1" }, data: { status: "EXPIRED" } });
    expect(tp.webhookEvent.updateMany).toHaveBeenLastCalledWith({
      where: { source: "stripe", externalId: "evt_1" },
      data: expect.objectContaining({ status: "DONE" }),
    });
  });

  it("200s without processing when the event is already DONE", async () => {
    const tp = ready();
    tp.webhookEvent.create.mockRejectedValue(dupError());
    tp.webhookEvent.findUnique.mockResolvedValue({ status: "DONE" });
    const res = await deliver(ev("checkout.session.completed", { id: "cs_1" }));
    expect(res.status).toBe(200);
    expect(tp.stripeSession.findUnique).not.toHaveBeenCalled();
  });

  it("500s (and logs) when the event cannot be recorded, so Stripe retries", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const tp = ready();
    tp.webhookEvent.create.mockRejectedValue(new Error("connection reset"));
    const res = await deliver(ev("checkout.session.completed", { id: "cs_1" }));
    expect(res.status).toBe(500);
    expect(tp.stripeSession.findUnique).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it("a failed effect leaves the event FAILED and answers 500; Stripe's redelivery then reconciles it", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const tp = ready();
    tp.stripeSession.findUnique.mockResolvedValue({ id: "ss1", type: "ONE_TIME", invoiceId: "inv1", customerId: "c1", amountTotal: 50 });
    tp.invoice.findUnique.mockResolvedValue({ id: "inv1", customerId: "c1", visitId: "v1", amount: 50, status: "SENT" });
    tp.payment.findUnique.mockResolvedValue({ id: "pay-1", stripeId: "pi_1" });
    transition.mockRejectedValueOnce(new Error("transient"));
    const completed = ev("checkout.session.completed", { id: "cs_1", payment_intent: "pi_1" });

    const first = await deliver(completed);
    expect(first.status).toBe(500);
    expect(tp.webhookEvent.updateMany).toHaveBeenLastCalledWith({
      where: { source: "stripe", externalId: "evt_1" },
      data: expect.objectContaining({ status: "FAILED", attempts: { increment: 1 } }),
    });

    tp.webhookEvent.create.mockRejectedValue(dupError());
    tp.webhookEvent.findUnique.mockImplementation(async (args: { where: { source_externalId?: unknown } }) =>
      args.where.source_externalId ? { status: "FAILED" } : { id: "pay-1", stripeId: "pi_1" }
    );
    tp.stripeSession.findUnique.mockResolvedValue({ id: "ss1", type: "ONE_TIME", invoiceId: "inv1", customerId: "c1", amountTotal: 50 });
    const second = await deliver(completed);
    expect(second.status).toBe(200);
    expect(transition).toHaveBeenCalledTimes(2);
    expect(transition).toHaveBeenLastCalledWith("pay-1", "PAID", { invoiceId: "inv1", note: "Stripe checkout completed" });
    consoleSpy.mockRestore();
  });
});

describe("POST /webhooks/stripe — checkout.session.completed (ONE_TIME)", () => {
  const stripeSession = { id: "ss1", type: "ONE_TIME", invoiceId: "inv1", customerId: "c1", amountTotal: 50 };
  const invoice = { id: "inv1", customerId: "c1", visitId: "v1", amount: 50, status: "SENT" };
  const completed = (extra: Record<string, unknown> = {}) => ev("checkout.session.completed", { id: "cs_1", payment_intent: "pi_1", ...extra });

  it("does nothing when no matching StripeSession is found", async () => {
    const tp = ready();
    tp.stripeSession.findUnique.mockResolvedValue(null);
    await deliver(completed());
    expect(tp.stripeSession.update).not.toHaveBeenCalled();
    expect(transition).not.toHaveBeenCalled();
  });

  it("marks the session COMPLETE and settles the existing payment (found by stripeId) through the state machine", async () => {
    const tp = ready();
    tp.stripeSession.findUnique.mockResolvedValue(stripeSession);
    tp.invoice.findUnique.mockResolvedValue(invoice);
    tp.payment.findUnique.mockResolvedValue({ id: "pay-1", stripeId: "pi_1" });
    await deliver(completed());
    expect(tp.stripeSession.update).toHaveBeenCalledWith({
      where: { id: "ss1" },
      data: { status: "COMPLETE", completedAt: expect.any(Date) },
    });
    expect(tp.payment.findUnique).toHaveBeenCalledWith({ where: { stripeId: "pi_1" } });
    expect(tp.payment.create).not.toHaveBeenCalled();
    expect(transition).toHaveBeenCalledWith("pay-1", "PAID", { invoiceId: "inv1", note: "Stripe checkout completed" });
    expect(tp.invoice.updateMany).not.toHaveBeenCalled();
  });

  it("reuses the visit's Payment (visitId is unique) and stamps the stripeId on it", async () => {
    const tp = ready();
    tp.stripeSession.findUnique.mockResolvedValue(stripeSession);
    tp.invoice.findUnique.mockResolvedValue(invoice);
    tp.payment.findUnique.mockImplementation(async (args: { where: { stripeId?: string; visitId?: string } }) =>
      args.where.visitId ? { id: "pay-v", stripeId: null } : null
    );
    tp.payment.update.mockResolvedValue({ id: "pay-v", stripeId: "pi_1" });
    await deliver(completed());
    expect(tp.payment.update).toHaveBeenCalledWith({ where: { id: "pay-v" }, data: { stripeId: "pi_1" } });
    expect(transition).toHaveBeenCalledWith("pay-v", "PAID", expect.anything());
  });

  it("creates a PENDING payment (with the stripeId) when none exists, then settles it", async () => {
    const tp = ready();
    tp.stripeSession.findUnique.mockResolvedValue({ ...stripeSession, amountTotal: null });
    tp.invoice.findUnique.mockResolvedValue({ ...invoice, visitId: null });
    tp.payment.findUnique.mockResolvedValue(null);
    tp.payment.create.mockResolvedValue({ id: "pay-new" });
    await deliver(completed({ payment_intent: { id: "pi_obj" } }));
    expect(tp.payment.create).toHaveBeenCalledWith({
      data: { customerId: "c1", visitId: undefined, amount: 50, method: "STRIPE", status: "PENDING", stripeId: "pi_obj" },
    });
    expect(transition).toHaveBeenCalledWith("pay-new", "PAID", expect.anything());
  });

  it("a session without a payment intent creates the payment without a stripeId and without a stripeId lookup", async () => {
    const tp = ready();
    tp.stripeSession.findUnique.mockResolvedValue(stripeSession);
    tp.invoice.findUnique.mockResolvedValue({ ...invoice, visitId: null });
    tp.payment.create.mockResolvedValue({ id: "pay-new" });
    await deliver(completed({ payment_intent: null }));
    expect(tp.payment.findUnique).not.toHaveBeenCalled();
    expect(tp.payment.create).toHaveBeenCalledWith({ data: expect.objectContaining({ stripeId: null }) });
  });

  it("a concurrent create (unique stripeId) is re-read instead of failing", async () => {
    const tp = ready();
    tp.stripeSession.findUnique.mockResolvedValue(stripeSession);
    tp.invoice.findUnique.mockResolvedValue({ ...invoice, visitId: null });
    tp.payment.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: "pay-raced", stripeId: "pi_1" });
    tp.payment.create.mockRejectedValue(dupError());
    await deliver(completed());
    expect(transition).toHaveBeenCalledWith("pay-raced", "PAID", expect.anything());
  });

  it("a unique violation with nothing to re-read, or any other create error, fails the event (500)", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const a = ready();
    a.stripeSession.findUnique.mockResolvedValue(stripeSession);
    a.invoice.findUnique.mockResolvedValue({ ...invoice, visitId: null });
    a.payment.findUnique.mockResolvedValue(null);
    a.payment.create.mockRejectedValue(dupError());
    expect((await deliver(completed())).status).toBe(500);

    const b = ready();
    b.stripeSession.findUnique.mockResolvedValue(stripeSession);
    b.invoice.findUnique.mockResolvedValue({ ...invoice, visitId: null });
    b.payment.findUnique.mockResolvedValue(null);
    b.payment.create.mockRejectedValue(new Error("db"));
    expect((await deliver(completed({ payment_intent: null }))).status).toBe(500);
    consoleSpy.mockRestore();
  });

  it("when the payment was already PAID but the invoice is not, the invoice is settled directly", async () => {
    const tp = ready();
    tp.stripeSession.findUnique.mockResolvedValue(stripeSession);
    tp.invoice.findUnique.mockResolvedValue(invoice);
    tp.payment.findUnique.mockResolvedValue({ id: "pay-1", stripeId: "pi_1" });
    transition.mockResolvedValueOnce({ changed: false });
    await deliver(completed());
    expect(tp.invoice.updateMany).toHaveBeenCalledWith({
      where: { id: "inv1", status: { in: ["DRAFT", "SENT"] } },
      data: { status: "PAID", paidAt: expect.any(Date) },
    });
  });

  it("an unchanged payment on an already-PAID invoice is a no-op (replayed event)", async () => {
    const tp = ready();
    tp.stripeSession.findUnique.mockResolvedValue(stripeSession);
    tp.invoice.findUnique.mockResolvedValue({ ...invoice, status: "PAID" });
    tp.payment.findUnique.mockResolvedValue({ id: "pay-1", stripeId: "pi_1" });
    transition.mockResolvedValueOnce({ changed: false });
    await deliver(completed());
    expect(tp.invoice.updateMany).not.toHaveBeenCalled();
  });

  it("does nothing more when the session has no invoice, or the invoice is gone", async () => {
    const tp = ready();
    tp.stripeSession.findUnique.mockResolvedValue({ ...stripeSession, invoiceId: null });
    await deliver(completed());
    tp.stripeSession.findUnique.mockResolvedValue(stripeSession);
    tp.invoice.findUnique.mockResolvedValue(null);
    await deliver(completed());
    expect(transition).not.toHaveBeenCalled();
  });
});

describe("POST /webhooks/stripe — checkout.session.completed (SETUP)", () => {
  const setupSession = { id: "ss2", type: "SETUP", customerId: "c1" };
  const run = async (session: Record<string, unknown>) => {
    const tp = ready();
    tp.stripeSession.findUnique.mockResolvedValue(setupSession);
    await deliver(ev("checkout.session.completed", { id: "cs_2", ...session }));
    return tp;
  };

  it("saves the default payment method (setup_intent object)", async () => {
    const tp = await run({ setup_intent: { payment_method: "pm_1" } });
    expect(tp.customer.update).toHaveBeenCalledWith({ where: { id: "c1" }, data: { stripeDefaultPaymentMethodId: "pm_1" } });
    expect(transition).not.toHaveBeenCalled();
  });

  it("a bare (unexpanded) setup_intent string is saved as-is (existing behaviour); no setup_intent saves nothing", async () => {
    expect((await run({ setup_intent: "seti_1" })).customer.update).toHaveBeenCalledWith({
      where: { id: "c1" },
      data: { stripeDefaultPaymentMethodId: "seti_1" },
    });
    expect((await run({ setup_intent: null })).customer.update).not.toHaveBeenCalled();
    expect((await run({ setup_intent: { payment_method: null } })).customer.update).not.toHaveBeenCalled();
  });
});

describe("POST /webhooks/stripe — payment_intent.payment_failed", () => {
  const failed = (metadata: Record<string, string> | undefined = { invoiceId: "inv1" }) => ev("payment_intent.payment_failed", { id: "pi_1", metadata });
  const invoice = { id: "inv1", customerId: "c1", visitId: "v1", amount: 50 };

  it("ignores an intent without invoice metadata, or with an unknown invoice", async () => {
    const tp = ready();
    await deliver(failed(undefined));
    await deliver(failed({}));
    tp.invoice.findUnique.mockResolvedValue(null);
    await deliver(failed());
    expect(transition).not.toHaveBeenCalled();
  });

  it("moves the existing payment to FAILED via the state machine (a late FAILED cannot beat PAID there)", async () => {
    const tp = ready();
    tp.invoice.findUnique.mockResolvedValue(invoice);
    tp.payment.findUnique.mockResolvedValue({ id: "pay-1", stripeId: "pi_1" });
    await deliver(failed());
    expect(transition).toHaveBeenCalledWith("pay-1", "FAILED");
    expect(tp.payment.create).not.toHaveBeenCalled();
  });

  it("creates the payment first when none exists", async () => {
    const tp = ready();
    tp.invoice.findUnique.mockResolvedValue(invoice);
    tp.payment.findUnique.mockResolvedValue(null);
    tp.payment.create.mockResolvedValue({ id: "pay-new" });
    await deliver(failed());
    expect(tp.payment.create).toHaveBeenCalledWith({
      data: { customerId: "c1", visitId: "v1", amount: 50, method: "STRIPE", status: "PENDING", stripeId: "pi_1" },
    });
    expect(transition).toHaveBeenCalledWith("pay-new", "FAILED");
  });
});

describe("POST /webhooks/stripe — refunds and disputes (BE-08)", () => {
  const withPayment = () => {
    const tp = ready();
    tp.payment.findUnique.mockResolvedValue({ id: "pay-1", customerId: "c1", stripeId: "pi_1" });
    return tp;
  };

  it("charge.refunded (full) -> REFUNDED", async () => {
    withPayment();
    await deliver(ev("charge.refunded", { payment_intent: "pi_1", refunded: true, amount: 5000, amount_refunded: 5000 }));
    expect(transition).toHaveBeenCalledWith("pay-1", "REFUNDED", { note: "Stripe charge.refunded" });
  });

  it("charge.refunded (partial) changes no state: it is logged and the office is told to reconcile", async () => {
    const tp = withPayment();
    await deliver(ev("charge.refunded", { payment_intent: { id: "pi_1" }, refunded: false, amount: 5000, amount_refunded: 1250 }));
    expect(transition).not.toHaveBeenCalled();
    expect(tp.activityLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        type: "PAYMENT_PARTIAL_REFUND",
        message: "Partial refund of GBP 12.50 (charge GBP 50.00): reconcile manually",
        entityId: "pay-1",
      }),
    });
    expect(notifyPaymentEvent).toHaveBeenCalledWith(tp, {
      customerId: "c1",
      title: "Partial refund recorded",
      body: "Partial refund of GBP 12.50 (charge GBP 50.00): reconcile manually",
    });
  });

  it("charge.refunded for an unknown or missing payment intent is ignored", async () => {
    const tp = ready();
    tp.payment.findUnique.mockResolvedValue(null);
    await deliver(ev("charge.refunded", { payment_intent: "pi_x", refunded: true }));
    await deliver(ev("charge.refunded", { payment_intent: null, refunded: true }));
    expect(transition).not.toHaveBeenCalled();
    expect(tp.activityLog.create).not.toHaveBeenCalled();
  });

  it("charge.dispute.created -> DISPUTED with the reason", async () => {
    withPayment();
    await deliver(ev("charge.dispute.created", { payment_intent: "pi_1", reason: "fraudulent" }));
    expect(transition).toHaveBeenCalledWith("pay-1", "DISPUTED", { note: "Stripe dispute: fraudulent" });
  });

  it("charge.dispute.closed: won -> PAID again; lost -> recorded + office told, state unchanged; other statuses ignored", async () => {
    const tp = withPayment();
    await deliver(ev("charge.dispute.closed", { payment_intent: "pi_1", status: "won" }, "e1"));
    expect(transition).toHaveBeenCalledWith("pay-1", "PAID", { note: "Stripe dispute won" });

    transition.mockClear();
    await deliver(ev("charge.dispute.closed", { payment_intent: "pi_1", status: "lost" }, "e2"));
    expect(transition).not.toHaveBeenCalled();
    expect(tp.activityLog.create).toHaveBeenCalledWith({ data: expect.objectContaining({ type: "PAYMENT_DISPUTE_LOST", entityId: "pay-1" }) });
    expect(notifyPaymentEvent).toHaveBeenCalledWith(tp, expect.objectContaining({ customerId: "c1", title: "Payment dispute lost" }));

    tp.activityLog.create.mockClear();
    await deliver(ev("charge.dispute.closed", { payment_intent: "pi_1", status: "warning_closed" }, "e3"));
    expect(tp.activityLog.create).not.toHaveBeenCalled();
  });

  it("a dispute for an unknown payment is ignored", async () => {
    const tp = ready();
    tp.payment.findUnique.mockResolvedValue(null);
    await deliver(ev("charge.dispute.created", { payment_intent: null }));
    await deliver(ev("charge.dispute.created", { payment_intent: "pi_x" }));
    expect(transition).not.toHaveBeenCalled();
  });
});

describe("POST /webhooks/stripe — other event types", () => {
  it("200s and takes no action for an event type with no handler", async () => {
    const tp = ready();
    const res = await deliver(ev("customer.created", {}));
    expect(res.status).toBe(200);
    expect(tp.stripeSession.findUnique).not.toHaveBeenCalled();
  });
});

describe("POST /webhooks/stripe — BE-02 crash safety", () => {
  it("500s (and never crashes) when the tenant lookup throws", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    constructEvent.mockReturnValue({ id: "evt_1", account: "acct_1", type: "checkout.session.completed" });
    tenantFindUnique.mockRejectedValue(new Error("db down"));

    const res = await send(makeApp());
    expect(res.status).toBe(500);
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("stripeWebhook"), expect.any(Error));
    consoleSpy.mockRestore();
  });
});
