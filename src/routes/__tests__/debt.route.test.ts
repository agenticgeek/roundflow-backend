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
const getInvoiceDetail = vi.fn();
vi.mock("../../services/debt.service", () => ({
  createDebtService: vi.fn(() => ({ getKpis, getBoard, getBucketCounts, sendReminder, sendPaymentLink, flagBadDebt, flagHold, getInvoiceDetail })),
}));

const queueGhlEvent = vi.fn().mockResolvedValue(undefined);
vi.mock("../../integrations/ghl/sync", () => ({
  queueGhlEvent: (...args: unknown[]) => queueGhlEvent(...args),
}));

import { debtRouter } from "../debt";
import { AppError } from "../../lib/app-error";

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
  it("sends with the auto channel and the template when the body is empty, and queues debt.overdue", async () => {
    sendReminder.mockResolvedValue({ id: "m1", messageId: "m1", channel: "SMS", customerId: "c1" });
    const tp = makeTenantPrisma();
    const res = await request(makeApp(tp)).post("/debt/inv-1/remind").send({});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: "m1", messageId: "m1", channel: "SMS" });
    expect(sendReminder).toHaveBeenCalledWith("inv-1", { channel: undefined, message: undefined });
    expect(queueGhlEvent).toHaveBeenCalledWith(tp, "debt.overdue", "c1");
  });

  it("tolerates an undefined body", async () => {
    sendReminder.mockResolvedValue({ id: "m1", messageId: "m1", channel: "SMS", customerId: "c1" });
    const res = await request(makeAppWithUndefinedBody()).post("/debt/inv-1/remind");
    expect(res.status).toBe(200);
  });

  it("passes an explicit channel (normalised) and a custom message; blank message = template", async () => {
    sendReminder.mockResolvedValue({ id: "m1", messageId: "m1", channel: "EMAIL", customerId: "c1" });
    await request(makeApp()).post("/debt/inv-1/remind").send({ channel: "email", message: "Pay up" });
    expect(sendReminder).toHaveBeenLastCalledWith("inv-1", { channel: "EMAIL", message: "Pay up" });
    await request(makeApp()).post("/debt/inv-1/remind").send({ channel: "AUTO", message: "  " });
    expect(sendReminder).toHaveBeenLastCalledWith("inv-1", { channel: undefined, message: undefined });
  });

  it("400s on an unknown channel or a non-string message", async () => {
    expect((await request(makeApp()).post("/debt/inv-1/remind").send({ channel: "FAX" })).status).toBe(400);
    expect((await request(makeApp()).post("/debt/inv-1/remind").send({ message: 5 })).status).toBe(400);
    expect(sendReminder).not.toHaveBeenCalled();
  });

  it("propagates service errors (e.g. 502 GHL_SEND_FAILED) and queues nothing", async () => {
    sendReminder.mockRejectedValue(new AppError(502, "GHL down", "GHL_SEND_FAILED"));
    const res = await request(makeApp()).post("/debt/inv-1/remind").send({});
    expect(res.status).toBe(502);
    expect(queueGhlEvent).not.toHaveBeenCalled();
  });

  it("logs (does not fail) when queuing the GHL event rejects", async () => {
    sendReminder.mockResolvedValue({ id: "m1", messageId: "m1", channel: "SMS", customerId: "c1" });
    queueGhlEvent.mockRejectedValueOnce(new Error("outbox down"));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await request(makeApp()).post("/debt/inv-1/remind").send({});
    expect(res.status).toBe(200);
    await new Promise((r) => setImmediate(r));
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });
});

describe("POST /debt/:id/payment-link", () => {
  it("passes the tenant, channel and message to the service and returns its result", async () => {
    sendPaymentLink.mockResolvedValue({ url: "https://checkout.stripe.com/x", messageId: "m1", channel: "SMS" });
    const res = await request(makeApp()).post("/debt/inv-1/payment-link").send({ channel: "sms", message: "Pay here" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ url: "https://checkout.stripe.com/x", messageId: "m1", channel: "SMS" });
    expect(sendPaymentLink).toHaveBeenCalledWith("inv-1", { tenantId: "tenant-1", channel: "SMS", message: "Pay here" });
  });

  it("works with no body at all (auto channel, template body)", async () => {
    sendPaymentLink.mockResolvedValue({ url: "u" });
    const res = await request(makeAppWithUndefinedBody()).post("/debt/inv-1/payment-link");
    expect(res.status).toBe(200);
    expect(sendPaymentLink).toHaveBeenCalledWith("inv-1", { tenantId: "tenant-1", channel: undefined, message: undefined });
  });

  it("400s on an unknown channel", async () => {
    const res = await request(makeApp()).post("/debt/inv-1/payment-link").send({ channel: "PIGEON" });
    expect(res.status).toBe(400);
  });

  it("surfaces 409 STRIPE_NOT_CONNECTED from the service", async () => {
    sendPaymentLink.mockRejectedValue(new AppError(409, "Stripe is not connected", "STRIPE_NOT_CONNECTED"));
    const res = await request(makeApp()).post("/debt/inv-1/payment-link").send({});
    expect(res.status).toBe(409);
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

  it("flags hold next clean with no extra fields", async () => {
    flagHold.mockResolvedValue({ customerId: "cust-1", holdNextClean: true });
    const res = await request(makeApp()).patch("/debt/inv-1/hold").send({ flag: true });
    expect(res.status).toBe(200);
    expect(flagHold).toHaveBeenCalledWith("inv-1", true, {
      reason: undefined, date: undefined, notify: undefined, message: undefined,
    });
  });

  it("400s when reason is not a string", async () => {
    const res = await request(makeApp()).patch("/debt/inv-1/hold").send({ flag: true, reason: 123 });
    expect(res.status).toBe(400);
    expect(flagHold).not.toHaveBeenCalled();
  });

  it("400s when notify is not a boolean", async () => {
    const res = await request(makeApp()).patch("/debt/inv-1/hold").send({ flag: true, notify: "yes" });
    expect(res.status).toBe(400);
    expect(flagHold).not.toHaveBeenCalled();
  });

  it("400s when date is not a valid ISO date", async () => {
    const res = await request(makeApp()).patch("/debt/inv-1/hold").send({ flag: true, date: "not-a-date" });
    expect(res.status).toBe(400);
    expect(flagHold).not.toHaveBeenCalled();
  });

  it("passes reason, date, notify and message through to the service", async () => {
    flagHold.mockResolvedValue({ customerId: "cust-1", holdNextClean: true, holdReason: "Non-payment", holdSince: new Date() });
    const res = await request(makeApp()).patch("/debt/inv-1/hold").send({
      flag: true, reason: "Non-payment", date: "2026-02-01T00:00:00.000Z", notify: true, message: "You're on hold",
    });
    expect(res.status).toBe(200);
    expect(flagHold).toHaveBeenCalledWith("inv-1", true, {
      reason: "Non-payment",
      date: new Date("2026-02-01T00:00:00.000Z"),
      notify: true,
      message: "You're on hold",
    });
  });

  it("clears the hold when flag is false", async () => {
    flagHold.mockResolvedValue({ customerId: "cust-1", holdNextClean: false, holdReason: null, holdSince: null });
    const res = await request(makeApp()).patch("/debt/inv-1/hold").send({ flag: false });
    expect(res.status).toBe(200);
    expect(flagHold).toHaveBeenCalledWith("inv-1", false, {
      reason: undefined, date: undefined, notify: undefined, message: undefined,
    });
  });
});

describe("GET /debt/:id", () => {
  it("returns the invoice detail", async () => {
    const detail = { invoiceId: "inv-1", customerName: "Jane", phone: "07123456789" };
    getInvoiceDetail.mockResolvedValue(detail);
    const res = await request(makeApp()).get("/debt/inv-1");
    expect(res.status).toBe(200);
    expect(res.body).toEqual(detail);
    expect(getInvoiceDetail).toHaveBeenCalledWith("inv-1");
  });

  it("404s when the service rejects with AppError(404)", async () => {
    getInvoiceDetail.mockRejectedValue(new AppError(404, "Invoice not found"));
    const res = await request(makeApp()).get("/debt/missing");
    expect(res.status).toBe(404);
  });
});
