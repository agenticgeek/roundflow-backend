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

const getKpis = vi.fn();
const getBoard = vi.fn();
const getBucketCounts = vi.fn();
const sendReminder = vi.fn();
const sendPaymentLink = vi.fn();
const flagBadDebt = vi.fn();
const flagHold = vi.fn();
vi.mock("../../services/debt.service", () => ({
  createDebtService: vi.fn(() => ({ getKpis, getBoard, getBucketCounts, sendReminder, sendPaymentLink, flagBadDebt, flagHold })),
}));

vi.mock("../../lib/crypto", () => ({
  decrypt: vi.fn(() => "sk_test_decrypted"),
}));
vi.mock("../../integrations/stripe/client", () => ({
  getStripeClient: vi.fn(() => ({ fake: "stripe-client" })),
}));
const createOneTimeSession = vi.fn();
vi.mock("../../integrations/stripe/checkout", () => ({
  createOneTimeSession: (...args: unknown[]) => createOneTimeSession(...args),
}));
const queueGhlEvent = vi.fn().mockResolvedValue(undefined);
vi.mock("../../integrations/ghl/sync", () => ({
  queueGhlEvent: (...args: unknown[]) => queueGhlEvent(...args),
}));

import { debtRouter } from "../debt";

function makeTenantPrisma() {
  return {
    invoice: { findUnique: vi.fn() },
    businessSettings: { findFirst: vi.fn() },
    stripeSession: { findFirst: vi.fn(), create: vi.fn() },
  };
}

function makeApp(tp: ReturnType<typeof makeTenantPrisma> = makeTenantPrisma()) {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.tenantPrisma = tp;
    next();
  });
  app.use("/debt", debtRouter);
  app.use((err: any, _req: any, res: any, _next: any) => {
    res.status(err.statusCode ?? 500).json({ error: err.message ?? "Internal error" });
  });
  return app;
}

function makeAppWithUndefinedBody(tp: ReturnType<typeof makeTenantPrisma> = makeTenantPrisma()) {
  const app = express();
  app.use((req: any, _res, next) => {
    req.tenantPrisma = tp;
    req.body = undefined;
    next();
  });
  app.use("/debt", debtRouter);
  app.use((err: any, _req: any, res: any, _next: any) => {
    res.status(err.statusCode ?? 500).json({ error: err.message ?? "Internal error" });
  });
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /debt/kpis", () => {
  it("returns the kpis", async () => {
    getKpis.mockResolvedValue({ totalOutstanding: 100 });
    const res = await request(makeApp()).get("/debt/kpis");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ totalOutstanding: 100 });
  });
});

describe("GET /debt/board", () => {
  it("400s when bucket is missing", async () => {
    const res = await request(makeApp()).get("/debt/board");
    expect(res.status).toBe(400);
  });

  it("passes through optional roundId/paymentMethod/search and paginated results", async () => {
    getBoard.mockResolvedValue({ items: [], total: 0 });
    const res = await request(makeApp()).get("/debt/board?bucket=overdue&roundId=round-1&paymentMethod=STRIPE&page=2&pageSize=10&search=smith");
    expect(res.status).toBe(200);
    expect(getBoard).toHaveBeenCalledWith("overdue", "round-1", "STRIPE", 2, 10, "smith");
  });

  it("defaults roundId/paymentMethod/search to undefined and uses default pagination", async () => {
    getBoard.mockResolvedValue({ items: [], total: 0 });
    const res = await request(makeApp()).get("/debt/board?bucket=overdue");
    expect(res.status).toBe(200);
    expect(getBoard).toHaveBeenCalledWith("overdue", undefined, undefined, 1, 50, undefined);
  });
});

describe("GET /debt/board/counts", () => {
  it("returns all 7 bucket counts with no filters", async () => {
    getBucketCounts.mockResolvedValue({
      BAD_DEBT: 1, ON_HOLD: 2, FAILED_GC: 3, DUE_BEFORE_CLEAN: 4,
      SEVEN_DAYS_OVER: 5, FOURTEEN_DAYS_OVER: 6, ALL: 7,
    });
    const res = await request(makeApp()).get("/debt/board/counts");
    expect(res.status).toBe(200);
    expect(res.body.ALL).toBe(7);
    expect(getBucketCounts).toHaveBeenCalledWith(undefined, undefined, undefined);
  });

  it("passes through roundId/paymentMethod/search filters", async () => {
    getBucketCounts.mockResolvedValue({});
    const res = await request(makeApp()).get("/debt/board/counts?roundId=round-1&paymentMethod=STRIPE&search=smith");
    expect(res.status).toBe(200);
    expect(getBucketCounts).toHaveBeenCalledWith("round-1", "STRIPE", "smith");
  });
});

describe("POST /debt/:id/remind", () => {
  it("400s when channel or message is missing", async () => {
    const res = await request(makeApp()).post("/debt/inv-1/remind").send({ channel: "EMAIL" });
    expect(res.status).toBe(400);
  });

  it("400s when req.body is undefined", async () => {
    const res = await request(makeAppWithUndefinedBody()).post("/debt/inv-1/remind");
    expect(res.status).toBe(400);
  });

  it("queues a GHL debt.overdue event when the invoice has a customer", async () => {
    sendReminder.mockResolvedValue({ id: "msg-1" });
    const tp = makeTenantPrisma();
    tp.invoice.findUnique.mockResolvedValue({ customerId: "cust-1" });

    const res = await request(makeApp(tp)).post("/debt/inv-1/remind").send({ channel: "EMAIL", message: "Please pay" });

    expect(res.status).toBe(200);
    expect(queueGhlEvent).toHaveBeenCalledWith(tp, "debt.overdue", "cust-1");
  });

  it("skips queuing when the invoice has no customerId", async () => {
    sendReminder.mockResolvedValue({ id: "msg-1" });
    const tp = makeTenantPrisma();
    tp.invoice.findUnique.mockResolvedValue(null);

    const res = await request(makeApp(tp)).post("/debt/inv-1/remind").send({ channel: "EMAIL", message: "Please pay" });

    expect(res.status).toBe(200);
    expect(queueGhlEvent).not.toHaveBeenCalled();
  });
});

describe("POST /debt/:id/payment-link", () => {
  it("400s when message is missing", async () => {
    const res = await request(makeApp()).post("/debt/inv-1/payment-link").send({});
    expect(res.status).toBe(400);
  });

  it("400s when req.body is undefined", async () => {
    const res = await request(makeAppWithUndefinedBody()).post("/debt/inv-1/payment-link");
    expect(res.status).toBe(400);
  });

  it("falls back to the static link when Stripe is not connected", async () => {
    const tp = makeTenantPrisma();
    tp.businessSettings.findFirst.mockResolvedValue({ stripeConnected: false, stripeSecretKeyEncrypted: null });
    sendPaymentLink.mockResolvedValue({ id: "msg-1", paymentUrl: "https://pay.roundflow.app/i/INV-1" });

    const res = await request(makeApp(tp)).post("/debt/inv-1/payment-link").send({ message: "Please pay" });

    expect(res.status).toBe(200);
    expect(sendPaymentLink).toHaveBeenCalledWith("inv-1", "Please pay");
    expect(createOneTimeSession).not.toHaveBeenCalled();
  });

  it("falls back to the static link when the invoice no longer exists", async () => {
    const tp = makeTenantPrisma();
    tp.businessSettings.findFirst.mockResolvedValue({ stripeConnected: true, stripeSecretKeyEncrypted: "enc" });
    tp.invoice.findUnique.mockResolvedValue(null);
    sendPaymentLink.mockResolvedValue({ id: "msg-1", paymentUrl: "https://pay.roundflow.app/i/INV-1" });

    const res = await request(makeApp(tp)).post("/debt/inv-1/payment-link").send({ message: "Please pay" });

    expect(res.status).toBe(200);
    expect(sendPaymentLink).toHaveBeenCalledWith("inv-1", "Please pay");
  });

  it("falls back to the static link when the invoice is already PAID", async () => {
    const tp = makeTenantPrisma();
    tp.businessSettings.findFirst.mockResolvedValue({ stripeConnected: true, stripeSecretKeyEncrypted: "enc" });
    tp.invoice.findUnique.mockResolvedValue({ id: "inv-1", status: "PAID" });
    sendPaymentLink.mockResolvedValue({ id: "msg-1" });

    const res = await request(makeApp(tp)).post("/debt/inv-1/payment-link").send({ message: "Please pay" });

    expect(res.status).toBe(200);
    expect(sendPaymentLink).toHaveBeenCalledWith("inv-1", "Please pay");
  });

  it("falls back to the static link when the invoice is VOID", async () => {
    const tp = makeTenantPrisma();
    tp.businessSettings.findFirst.mockResolvedValue({ stripeConnected: true, stripeSecretKeyEncrypted: "enc" });
    tp.invoice.findUnique.mockResolvedValue({ id: "inv-1", status: "VOID" });
    sendPaymentLink.mockResolvedValue({ id: "msg-1" });

    const res = await request(makeApp(tp)).post("/debt/inv-1/payment-link").send({ message: "Please pay" });

    expect(res.status).toBe(200);
    expect(sendPaymentLink).toHaveBeenCalledWith("inv-1", "Please pay");
  });

  it("reuses an existing PENDING checkout session's url", async () => {
    const tp = makeTenantPrisma();
    tp.businessSettings.findFirst.mockResolvedValue({ stripeConnected: true, stripeSecretKeyEncrypted: "enc" });
    tp.invoice.findUnique.mockResolvedValue({ id: "inv-1", status: "DRAFT", customerId: "cust-1", invoiceNumber: "INV-1", amount: 35 });
    tp.stripeSession.findFirst.mockResolvedValue({ url: "https://checkout.stripe.com/pay/cs_existing" });
    sendPaymentLink.mockResolvedValue({ id: "msg-1", paymentUrl: "https://checkout.stripe.com/pay/cs_existing" });

    const res = await request(makeApp(tp)).post("/debt/inv-1/payment-link").send({ message: "Please pay" });

    expect(res.status).toBe(200);
    expect(sendPaymentLink).toHaveBeenCalledWith("inv-1", "Please pay", "https://checkout.stripe.com/pay/cs_existing");
    expect(createOneTimeSession).not.toHaveBeenCalled();
  });

  it("creates a new one-time checkout session when none is pending", async () => {
    const tp = makeTenantPrisma();
    tp.businessSettings.findFirst.mockResolvedValue({ stripeConnected: true, stripeSecretKeyEncrypted: "enc" });
    tp.invoice.findUnique.mockResolvedValue({ id: "inv-1", status: "DRAFT", customerId: "cust-1", invoiceNumber: "INV-1", amount: 35 });
    tp.stripeSession.findFirst.mockResolvedValue(null);
    createOneTimeSession.mockResolvedValue({
      stripeSessionId: "cs_new_123",
      url: "https://checkout.stripe.com/pay/cs_new_123",
      expiresAt: null,
    });
    sendPaymentLink.mockResolvedValue({ id: "msg-1", paymentUrl: "https://checkout.stripe.com/pay/cs_new_123" });

    const res = await request(makeApp(tp)).post("/debt/inv-1/payment-link").send({ message: "Please pay" });

    expect(res.status).toBe(200);
    expect(createOneTimeSession).toHaveBeenCalledWith(
      { fake: "stripe-client" },
      tp,
      expect.objectContaining({ tenantId: "tenant-1", customerId: "cust-1", invoiceId: "inv-1" })
    );
    expect(tp.stripeSession.create).toHaveBeenCalled();
    expect(sendPaymentLink).toHaveBeenCalledWith("inv-1", "Please pay", "https://checkout.stripe.com/pay/cs_new_123");
  });

  it("falls back to an empty-string frontend URL when FRONTEND_URL is unset", async () => {
    const original = process.env.FRONTEND_URL;
    delete process.env.FRONTEND_URL;
    try {
      const tp = makeTenantPrisma();
      tp.businessSettings.findFirst.mockResolvedValue({ stripeConnected: true, stripeSecretKeyEncrypted: "enc" });
      tp.invoice.findUnique.mockResolvedValue({ id: "inv-1", status: "DRAFT", customerId: "cust-1", invoiceNumber: "INV-1", amount: 35 });
      tp.stripeSession.findFirst.mockResolvedValue(null);
      createOneTimeSession.mockResolvedValue({
        stripeSessionId: "cs_new_123", url: "https://checkout.stripe.com/pay/cs_new_123", expiresAt: null,
      });
      sendPaymentLink.mockResolvedValue({ id: "msg-1" });

      const res = await request(makeApp(tp)).post("/debt/inv-1/payment-link").send({ message: "Please pay" });

      expect(res.status).toBe(200);
      expect(createOneTimeSession).toHaveBeenCalledWith(
        expect.anything(), expect.anything(),
        expect.objectContaining({ successUrl: "/invoices/inv-1?payment=success" })
      );
    } finally {
      process.env.FRONTEND_URL = original;
    }
  });
});

describe("PATCH /debt/:id/bad-debt", () => {
  it("400s when flag is not a boolean", async () => {
    const res = await request(makeApp()).patch("/debt/inv-1/bad-debt").send({});
    expect(res.status).toBe(400);
  });

  it("400s when req.body is undefined", async () => {
    const res = await request(makeAppWithUndefinedBody()).patch("/debt/inv-1/bad-debt");
    expect(res.status).toBe(400);
  });

  it("flags bad debt", async () => {
    flagBadDebt.mockResolvedValue({ customerId: "cust-1", badDebt: true });
    const res = await request(makeApp()).patch("/debt/inv-1/bad-debt").send({ flag: true });
    expect(res.status).toBe(200);
    expect(flagBadDebt).toHaveBeenCalledWith("inv-1", true);
  });
});

describe("PATCH /debt/:id/hold", () => {
  it("400s when flag is not a boolean", async () => {
    const res = await request(makeApp()).patch("/debt/inv-1/hold").send({});
    expect(res.status).toBe(400);
  });

  it("400s when req.body is undefined", async () => {
    const res = await request(makeAppWithUndefinedBody()).patch("/debt/inv-1/hold");
    expect(res.status).toBe(400);
  });

  it("flags hold next clean", async () => {
    flagHold.mockResolvedValue({ customerId: "cust-1", holdNextClean: true });
    const res = await request(makeApp()).patch("/debt/inv-1/hold").send({ flag: true });
    expect(res.status).toBe(200);
    expect(flagHold).toHaveBeenCalledWith("inv-1", true);
  });
});
