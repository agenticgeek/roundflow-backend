import { describe, it, expect, vi, beforeEach } from "vitest";
import { PaymentMethod, PaymentStatus, Prisma, VisitStatus } from "../../generated/tenant-client";

const decrypt = vi.fn((..._args: unknown[]) => "decrypted-token");
vi.mock("../../lib/crypto", () => ({ decrypt: (...args: unknown[]) => decrypt(...args) }));
const getGcClient = vi.fn((..._args: unknown[]) => ({ fake: "gc" }));
vi.mock("../../integrations/gocardless/client", () => ({ getGcClient: (...args: unknown[]) => getGcClient(...args) }));
const createGcPayment = vi.fn();
vi.mock("../../integrations/gocardless/payment", () => ({ createGcPayment: (...args: unknown[]) => createGcPayment(...args) }));

import {
  createVisitCompletionService,
  parseCompletionPayment,
  VISIT_COMPLETED_MESSAGE_EVENT,
} from "../visit-completion";

// Each create/update returns a tagged op so the transaction contents are inspectable.
function makeTp() {
  const tp = {
    visit: {
      findUnique: vi.fn(),
      update: vi.fn((args: any) => ({ op: "visit.update", args })),
    },
    payment: { create: vi.fn((args: any) => ({ op: "payment.create", args })) },
    activityLog: { create: vi.fn((args: any) => ({ op: "activityLog.create", args })) },
    propertyNote: { create: vi.fn((args: any) => ({ op: "propertyNote.create", args })) },
    integrationOutbox: { create: vi.fn((args: any) => ({ op: "outbox.create", args })) },
    businessSettings: { findFirst: vi.fn() },
    $transaction: vi.fn(async (ops: any[]) =>
      ops.map((o) => {
        if (o.op === "visit.update") return { id: o.args.where.id, status: o.args.data.status };
        if (o.op === "payment.create") return { id: "pay-1", ...o.args.data };
        return {};
      })
    ),
  };
  return tp;
}

function baseVisit(overrides: Record<string, unknown> = {}) {
  return {
    id: "visit-12345678",
    status: VisitStatus.IN_PROGRESS,
    price: new Prisma.Decimal(35),
    paymentMethod: null,
    propertyId: "prop-1",
    servicePlan: null,
    payment: null,
    property: {
      customer: { id: "cust-1", name: "Tom", paymentMethod: null, gocardlessMandateId: null, gocardlessMandateStatus: null },
    },
    ...overrides,
  };
}

const ops = (tp: ReturnType<typeof makeTp>) => tp.$transaction.mock.calls[0][0].map((o: any) => o.op);

beforeEach(() => vi.clearAllMocks());

describe("parseCompletionPayment", () => {
  it("returns undefined when nothing is sent", () => {
    expect(parseCompletionPayment({})).toBeUndefined();
    expect(parseCompletionPayment({ payment: null, cashConfirmed: false })).toBeUndefined();
  });

  it("maps the deprecated cashConfirmed: true alias to CASH", () => {
    expect(parseCompletionPayment({ cashConfirmed: true })).toEqual({ method: "CASH" });
  });

  it("rejects a non-boolean cashConfirmed", () => {
    expect(() => parseCompletionPayment({ cashConfirmed: "yes" })).toThrow(/cashConfirmed/);
  });

  it.each([[[]], ["CASH"], [5]])("rejects a non-object payment %j", (payment) => {
    expect(() => parseCompletionPayment({ payment })).toThrow(expect.objectContaining({ code: "INVALID_PAYMENT" }));
  });

  it.each([{}, { method: "PAYPAL" }, { method: 3 }])("rejects an invalid method %j", (payment) => {
    expect(() => parseCompletionPayment({ payment })).toThrow(expect.objectContaining({ code: "INVALID_PAYMENT" }));
  });

  it.each([0, -1, 10000, "12", Number.NaN])("rejects amount %j", (amount) => {
    expect(() => parseCompletionPayment({ payment: { method: "CASH", amount } })).toThrow(/payment.amount/);
  });

  it("rounds a valid amount to pennies and ignores a null amount", () => {
    expect(parseCompletionPayment({ payment: { method: "CASH", amount: 12.345 } })).toEqual({ method: "CASH", amount: 12.35, chequeNumber: undefined });
    expect(parseCompletionPayment({ payment: { method: "NONE", amount: null, chequeNumber: null } })).toEqual({ method: "NONE", amount: undefined, chequeNumber: undefined });
  });

  it.each([5, "x".repeat(51)])("rejects chequeNumber %j", (chequeNumber) => {
    expect(() => parseCompletionPayment({ payment: { method: "CHEQUE", chequeNumber } })).toThrow(/chequeNumber/);
  });

  it("requires a chequeNumber for CHEQUE (blank counts as missing)", () => {
    expect(() => parseCompletionPayment({ payment: { method: "CHEQUE" } })).toThrow(expect.objectContaining({ code: "CHEQUE_NUMBER_REQUIRED" }));
    expect(() => parseCompletionPayment({ payment: { method: "CHEQUE", chequeNumber: "  " } })).toThrow(expect.objectContaining({ code: "CHEQUE_NUMBER_REQUIRED" }));
  });

  it("accepts a cheque with a trimmed number", () => {
    expect(parseCompletionPayment({ payment: { method: "CHEQUE", chequeNumber: " 000123 " } })).toEqual({ method: "CHEQUE", amount: undefined, chequeNumber: "000123" });
  });
});

describe("completeVisit", () => {
  it("404s when the visit is missing", async () => {
    const tp = makeTp();
    tp.visit.findUnique.mockResolvedValue(null);
    await expect(createVisitCompletionService(tp as any).completeVisit("v1")).rejects.toMatchObject({ statusCode: 404 });
  });

  it("is idempotent for an already COMPLETED visit (no writes)", async () => {
    const tp = makeTp();
    tp.visit.findUnique.mockResolvedValue(baseVisit({ status: VisitStatus.COMPLETED }));
    expect(await createVisitCompletionService(tp as any).completeVisit("v1")).toEqual({ id: "visit-12345678", status: "COMPLETED", payment: null });
    expect(tp.$transaction).not.toHaveBeenCalled();
  });

  it.each([VisitStatus.SKIPPED, VisitStatus.CANCELLED])("409s for a %s visit", async (status) => {
    const tp = makeTp();
    tp.visit.findUnique.mockResolvedValue(baseVisit({ status }));
    await expect(createVisitCompletionService(tp as any).completeVisit("v1")).rejects.toMatchObject({ statusCode: 409 });
  });

  it("D-2: a CASH visit without confirmation 400s before any write, and a retry with payment succeeds", async () => {
    const tp = makeTp();
    tp.visit.findUnique.mockResolvedValue(baseVisit({ paymentMethod: PaymentMethod.CASH }));
    const svc = createVisitCompletionService(tp as any);

    await expect(svc.completeVisit("v1", { payment: { method: "NONE" } })).rejects.toMatchObject({
      statusCode: 400, code: "PAYMENT_CONFIRMATION_REQUIRED",
    });
    expect(tp.visit.update).not.toHaveBeenCalled();
    expect(tp.$transaction).not.toHaveBeenCalled();

    const ok = await svc.completeVisit("v1", { payment: { method: "CASH" } });
    expect(ok.status).toBe("COMPLETED");
    expect(ok.payment).toEqual({ id: "pay-1", method: "CASH", status: "PAID", amount: 35 });
  });

  it("CASH writes status, PAID payment (default amount = price) and both outbox events in one transaction", async () => {
    const tp = makeTp();
    tp.visit.findUnique.mockResolvedValue(baseVisit());
    await createVisitCompletionService(tp as any).completeVisit("v1", { payment: { method: "CASH" } });

    expect(ops(tp)).toEqual(["visit.update", "payment.create", "outbox.create", "outbox.create"]);
    const pay = tp.payment.create.mock.calls[0][0].data;
    expect(pay).toMatchObject({ customerId: "cust-1", visitId: "visit-12345678", method: "CASH", status: "PAID" });
    expect(Number(pay.amount)).toBe(35);
    expect(pay.paidAt).toBeInstanceOf(Date);
    expect(tp.integrationOutbox.create).toHaveBeenCalledWith({
      data: { eventType: "visit.completed", payload: { customerId: "cust-1", visitId: "visit-12345678" } },
    });
    expect(tp.integrationOutbox.create).toHaveBeenCalledWith({
      data: { eventType: VISIT_COMPLETED_MESSAGE_EVENT, payload: { customerId: "cust-1", visitId: "visit-12345678", template: "Visit completed" } },
    });
  });

  it("skips the visit-completed message event for a customer who opted out of messages", async () => {
    const tp = makeTp();
    tp.visit.findUnique.mockResolvedValue(baseVisit({
      property: { customer: { id: "cust-1", name: "Tom", paymentMethod: null, gocardlessMandateId: null, gocardlessMandateStatus: null, messagesOptOut: true } },
    }));
    await createVisitCompletionService(tp as any).completeVisit("v1", { payment: { method: "CASH" } });
    expect(ops(tp)).toEqual(["visit.update", "payment.create", "outbox.create"]);
    expect(tp.payment.create.mock.calls[0][0].data.reference).toBeUndefined();
  });

  it("CASH uses the amount received when given (overrides a GoCardless plan)", async () => {
    const tp = makeTp();
    tp.visit.findUnique.mockResolvedValue(baseVisit({ paymentMethod: PaymentMethod.GOCARDLESS }));
    await createVisitCompletionService(tp as any).completeVisit("v1", { payment: { method: "CASH", amount: 30 } });
    expect(tp.payment.create.mock.calls[0][0].data.amount).toBe(30);
    expect(createGcPayment).not.toHaveBeenCalled();
  });

  it("CHEQUE creates a PENDING cheque payment and logs the cheque number", async () => {
    const tp = makeTp();
    tp.visit.findUnique.mockResolvedValue(baseVisit());
    const out = await createVisitCompletionService(tp as any).completeVisit("v1", {
      payment: { method: "CHEQUE", chequeNumber: "000123" }, actorProfileId: "prof-1", actorRole: "TECHNICIAN",
    });

    expect(ops(tp)).toEqual(["visit.update", "payment.create", "activityLog.create", "outbox.create", "outbox.create"]);
    const pay = tp.payment.create.mock.calls[0][0].data;
    expect(pay).toMatchObject({ method: "CHEQUE", status: "PENDING", reference: "000123" });
    expect(pay.paidAt).toBeUndefined();
    expect(tp.activityLog.create.mock.calls[0][0].data).toMatchObject({
      type: "CHEQUE_RECEIVED", actorId: "prof-1", actorRole: "TECHNICIAN",
      message: expect.stringContaining("Cheque 000123"),
    });
    expect(out.payment).toMatchObject({ method: "CHEQUE", status: PaymentStatus.PENDING });
  });

  it("CHEQUE with an explicit amount and no actor", async () => {
    const tp = makeTp();
    tp.visit.findUnique.mockResolvedValue(baseVisit());
    await createVisitCompletionService(tp as any).completeVisit("v1", { payment: { method: "CHEQUE", amount: 40, chequeNumber: "9" } });
    expect(tp.payment.create.mock.calls[0][0].data.amount).toBe(40);
    expect(tp.activityLog.create.mock.calls[0][0].data).toMatchObject({ actorId: null, actorRole: null, message: expect.stringContaining("£40.00") });
  });

  it.each([PaymentMethod.BACS, PaymentMethod.CHEQUE])("NONE/omitted keeps plan behaviour: PENDING for %s", async (method) => {
    const tp = makeTp();
    tp.visit.findUnique.mockResolvedValue(baseVisit({ servicePlan: { paymentMethod: method } }));
    await createVisitCompletionService(tp as any).completeVisit("v1");
    expect(tp.payment.create.mock.calls[0][0].data).toMatchObject({ method, status: "PENDING" });
    expect(tp.activityLog.create).not.toHaveBeenCalled();
  });

  it("resolves the method from the customer when visit and plan have none", async () => {
    const tp = makeTp();
    tp.visit.findUnique.mockResolvedValue(baseVisit({
      property: { customer: { id: "cust-1", name: "Tom", paymentMethod: PaymentMethod.BACS, gocardlessMandateId: null, gocardlessMandateStatus: null } },
    }));
    await createVisitCompletionService(tp as any).completeVisit("v1");
    expect(tp.payment.create.mock.calls[0][0].data.method).toBe("BACS");
  });

  it("creates no payment for STRIPE / no method", async () => {
    const tp = makeTp();
    tp.visit.findUnique.mockResolvedValue(baseVisit({ paymentMethod: PaymentMethod.STRIPE }));
    const out = await createVisitCompletionService(tp as any).completeVisit("v1");
    expect(ops(tp)).toEqual(["visit.update", "outbox.create", "outbox.create"]);
    expect(out.payment).toBeNull();
  });

  it("skips payment creation when the visit already has one", async () => {
    const tp = makeTp();
    tp.visit.findUnique.mockResolvedValue(baseVisit({ paymentMethod: PaymentMethod.CASH, payment: { id: "p0" } }));
    await createVisitCompletionService(tp as any).completeVisit("v1");
    expect(tp.payment.create).not.toHaveBeenCalled();
  });

  it("adds an INTERNAL property note when a note is given", async () => {
    const tp = makeTp();
    tp.visit.findUnique.mockResolvedValue(baseVisit());
    await createVisitCompletionService(tp as any).completeVisit("v1", { note: "Side gate stiff" });
    expect(tp.propertyNote.create).toHaveBeenCalledWith({ data: { propertyId: "prop-1", body: "Side gate stiff", type: "INTERNAL" } });
  });

  describe("GOCARDLESS", () => {
    const gcVisit = (customer: Record<string, unknown> = {}) =>
      baseVisit({
        paymentMethod: PaymentMethod.GOCARDLESS,
        property: { customer: { id: "cust-1", name: "Tom", paymentMethod: null, gocardlessMandateId: "MD1", gocardlessMandateStatus: "active", ...customer } },
      });

    it("charges before the transaction and stores the GC id", async () => {
      const tp = makeTp();
      tp.visit.findUnique.mockResolvedValue(gcVisit());
      tp.businessSettings.findFirst.mockResolvedValue({ gocardlessAccessTokenEncrypted: "enc", gocardlessEnvironment: "live" });
      createGcPayment.mockResolvedValue({ id: "PM1" });

      await createVisitCompletionService(tp as any).completeVisit("v1");

      expect(getGcClient).toHaveBeenCalledWith("decrypted-token", "live");
      expect(createGcPayment).toHaveBeenCalledWith({ fake: "gc" }, expect.objectContaining({ mandateId: "MD1", amountPence: 3500, reference: "12345678" }));
      expect(tp.payment.create.mock.calls[0][0].data).toMatchObject({ method: "GOCARDLESS", status: "PENDING", gocardlessId: "PM1" });
    });

    it("defaults the environment to sandbox", async () => {
      const tp = makeTp();
      tp.visit.findUnique.mockResolvedValue(gcVisit());
      tp.businessSettings.findFirst.mockResolvedValue({ gocardlessAccessTokenEncrypted: "enc", gocardlessEnvironment: null });
      createGcPayment.mockResolvedValue({ id: "PM1" });
      await createVisitCompletionService(tp as any).completeVisit("v1");
      expect(getGcClient).toHaveBeenCalledWith("decrypted-token", "sandbox");
    });

    it("a GoCardless failure leaves the visit untouched", async () => {
      const tp = makeTp();
      tp.visit.findUnique.mockResolvedValue(gcVisit());
      tp.businessSettings.findFirst.mockResolvedValue({ gocardlessAccessTokenEncrypted: "enc", gocardlessEnvironment: "live" });
      createGcPayment.mockRejectedValue(new Error("gc down"));
      await expect(createVisitCompletionService(tp as any).completeVisit("v1")).rejects.toThrow("gc down");
      expect(tp.$transaction).not.toHaveBeenCalled();
    });

    it("completes without charging when no token is stored", async () => {
      const tp = makeTp();
      tp.visit.findUnique.mockResolvedValue(gcVisit());
      tp.businessSettings.findFirst.mockResolvedValue(null);
      await createVisitCompletionService(tp as any).completeVisit("v1");
      expect(createGcPayment).not.toHaveBeenCalled();
      expect(tp.payment.create).not.toHaveBeenCalled();
    });

    it.each([{ gocardlessMandateStatus: "cancelled" }, { gocardlessMandateId: null }])("skips charging for %j", async (c) => {
      const tp = makeTp();
      tp.visit.findUnique.mockResolvedValue(gcVisit(c));
      await createVisitCompletionService(tp as any).completeVisit("v1");
      expect(tp.businessSettings.findFirst).not.toHaveBeenCalled();
      expect(tp.payment.create).not.toHaveBeenCalled();
    });
  });
});
