import { describe, it, expect, vi, beforeEach } from "vitest";

const queueGhlEvent = vi.fn();
vi.mock("../../integrations/ghl/sync", () => ({ queueGhlEvent: (...a: unknown[]) => queueGhlEvent(...a) }));
const releaseHoldIfSettled = vi.fn();
vi.mock("../payment-hold", () => ({ releaseHoldIfSettled: (...a: unknown[]) => releaseHoldIfSettled(...a) }));
vi.mock("../notify", async () => (await import("../../test/notify-mock.js")).notifyMockModule());

import { computeBalanceOwed, createPaymentService } from "../payment.service";
import { notifyInvoicePaid, notifyPaymentEvent, notifyPaymentFailed } from "../notify";

function makePrisma(sumAmount: number | null) {
  return {
    invoice: {
      aggregate: vi.fn().mockResolvedValue({ _sum: { amount: sumAmount } }),
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  queueGhlEvent.mockResolvedValue(undefined);
  releaseHoldIfSettled.mockResolvedValue(false);
});

describe("computeBalanceOwed", () => {
  it("sums only SENT invoices for the customer", async () => {
    const prisma = makePrisma(87.5);

    const result = await computeBalanceOwed(prisma as any, "cust-1");

    expect(prisma.invoice.aggregate).toHaveBeenCalledWith({
      where: { customerId: "cust-1", status: "SENT" },
      _sum: { amount: true },
    });
    expect(result).toBe(87.5);
  });

  it("returns 0 when the customer has no outstanding SENT invoices", async () => {
    const prisma = makePrisma(null);

    const result = await computeBalanceOwed(prisma as any, "cust-1");

    expect(result).toBe(0);
  });
});

function tx(payment: Record<string, unknown> | null) {
  const client: any = {
    payment: {
      findUnique: vi.fn().mockResolvedValue(payment),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    invoice: {
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      findFirst: vi.fn().mockResolvedValue({ id: "inv1", invoiceNumber: "INV-1", customerId: "c1" }),
    },
    activityLog: { create: vi.fn().mockResolvedValue({}) },
  };
  client.$transaction = vi.fn(async (fn: (t: unknown) => unknown) => fn(client));
  return client;
}
const base = { id: "p1", visitId: "v1", customerId: "c1", paidAt: null as Date | null, status: "PENDING" };

describe("transition / applyOutcome (BE-07)", () => {
  it("404s for an unknown payment", async () => {
    await expect(createPaymentService(tx(null) as any).applyOutcome("x", "PAID")).rejects.toMatchObject({ statusCode: 404 });
  });

  it("PENDING -> PAID: conditional update inside one transaction, invoice settled, GHL + hold release + notification", async () => {
    const prisma = tx({ ...base });
    const out = await createPaymentService(prisma as any).applyOutcome("p1", "PAID");
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    const upd = prisma.payment.updateMany.mock.calls[0][0];
    expect(upd.where).toEqual({ id: "p1", status: "PENDING" });
    expect(upd.data.status).toBe("PAID");
    expect(upd.data.paidAt).toBeInstanceOf(Date);
    expect(prisma.invoice.updateMany).toHaveBeenCalledWith({
      where: { visitId: "v1", status: { in: ["DRAFT", "SENT"] } },
      data: { status: "PAID", paidAt: upd.data.paidAt },
    });
    expect(out.status).toBe("PAID");
    expect(queueGhlEvent).toHaveBeenCalledWith(prisma, "payment.collected", "c1");
    expect(releaseHoldIfSettled).toHaveBeenCalledWith(prisma, "c1");
    expect(notifyInvoicePaid).toHaveBeenCalledWith(prisma, { id: "inv1", invoiceNumber: "INV-1", customerId: "c1" });
    expect(notifyPaymentFailed).not.toHaveBeenCalled();
  });

  it("PAID with an invoice that was already PAID does not notify; PAID without a visit leaves invoices alone", async () => {
    const already = tx({ ...base });
    already.invoice.updateMany.mockResolvedValue({ count: 0 });
    await createPaymentService(already as any).applyOutcome("p1", "PAID");
    expect(notifyInvoicePaid).not.toHaveBeenCalled();
    expect(already.invoice.findFirst).not.toHaveBeenCalled();

    const noVisit = tx({ ...base, visitId: null });
    await createPaymentService(noVisit as any).applyOutcome("p1", "PAID");
    expect(noVisit.invoice.updateMany).not.toHaveBeenCalled();
  });

  it("a payment without a visit follows the invoice given by id", async () => {
    const prisma = tx({ ...base, visitId: null });
    await createPaymentService(prisma as any).transition("p1", "PAID" as any, { invoiceId: "inv9" });
    expect(prisma.invoice.updateMany).toHaveBeenCalledWith({
      where: { id: "inv9", status: { in: ["DRAFT", "SENT"] } },
      data: { status: "PAID", paidAt: expect.any(Date) },
    });
    expect(prisma.invoice.findFirst).toHaveBeenCalledWith({ where: { id: "inv9" }, select: { id: true, invoiceNumber: true, customerId: true } });
  });

  it("a late FAILED never overwrites PAID: nothing is written and no side effect fires", async () => {
    const prisma = tx({ ...base, status: "PAID" });
    const out = await createPaymentService(prisma as any).applyOutcome("p1", "FAILED");
    expect(out.status).toBe("PAID");
    expect(prisma.payment.updateMany).not.toHaveBeenCalled();
    expect(queueGhlEvent).not.toHaveBeenCalled();
    expect(notifyPaymentFailed).not.toHaveBeenCalled();
  });

  it("the same outcome twice is a no-op (replayed webhook)", async () => {
    const prisma = tx({ ...base, status: "PAID" });
    await createPaymentService(prisma as any).applyOutcome("p1", "PAID");
    expect(prisma.payment.updateMany).not.toHaveBeenCalled();
    expect(releaseHoldIfSettled).not.toHaveBeenCalled();
  });

  it("strict mode (manual action) rejects an illegal transition with 409 INVALID_PAYMENT_TRANSITION", async () => {
    const prisma = tx({ ...base, status: "CANCELLED" });
    await expect(createPaymentService(prisma as any).transition("p1", "PAID" as any, { strict: true })).rejects.toMatchObject({
      statusCode: 409,
      code: "INVALID_PAYMENT_TRANSITION",
    });
    expect(prisma.payment.updateMany).not.toHaveBeenCalled();
  });

  it("losing the conditional update to a concurrent event changes nothing", async () => {
    const prisma = tx({ ...base });
    prisma.payment.updateMany.mockResolvedValue({ count: 0 });
    const res = await createPaymentService(prisma as any).transition("p1", "PAID" as any);
    expect(res.changed).toBe(false);
    expect(prisma.invoice.updateMany).not.toHaveBeenCalled();
    expect(queueGhlEvent).not.toHaveBeenCalled();
  });

  it("FAILED keeps paidAt, queues payment.failed, tells the office and never releases the hold", async () => {
    const old = new Date("2026-01-01T00:00:00Z");
    const prisma = tx({ ...base, paidAt: old });
    queueGhlEvent.mockRejectedValue(new Error("outbox"));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await createPaymentService(prisma as any).applyOutcome("p1", "FAILED");
    expect(prisma.payment.updateMany.mock.calls[0][0].data).toEqual({ status: "FAILED", paidAt: old });
    expect(queueGhlEvent).toHaveBeenCalledWith(prisma, "payment.failed", "c1");
    expect(notifyPaymentFailed).toHaveBeenCalledWith(prisma, "c1");
    expect(releaseHoldIfSettled).not.toHaveBeenCalled();
    await new Promise((r) => setImmediate(r));
    err.mockRestore();
  });

  it("FAILED -> PAID (retry succeeded) settles the invoice", async () => {
    const prisma = tx({ ...base, status: "FAILED" });
    await createPaymentService(prisma as any).applyOutcome("p1", "PAID");
    expect(prisma.payment.updateMany.mock.calls[0][0].where).toEqual({ id: "p1", status: "FAILED" });
    expect(notifyInvoicePaid).toHaveBeenCalled();
  });

  it("PROCESSING / CANCELLED change the payment only (no invoice, no notification)", async () => {
    for (const target of ["PROCESSING", "CANCELLED"]) {
      const prisma = tx({ ...base });
      const res = await createPaymentService(prisma as any).transition("p1", target as any);
      expect(res.changed).toBe(true);
      expect(prisma.invoice.updateMany).not.toHaveBeenCalled();
      expect(prisma.activityLog.create).not.toHaveBeenCalled();
    }
    expect(notifyPaymentEvent).not.toHaveBeenCalled();
    expect(queueGhlEvent).not.toHaveBeenCalled();
  });

  it("REFUNDED: voids the invoice, writes an activity row and notifies the office", async () => {
    const prisma = tx({ ...base, status: "PAID", paidAt: new Date() });
    await createPaymentService(prisma as any).transition("p1", "REFUNDED" as any, { note: "Stripe charge.refunded" });
    expect(prisma.invoice.updateMany).toHaveBeenCalledWith({
      where: { visitId: "v1", status: { in: ["PAID", "SENT"] } },
      data: { status: "VOID" },
    });
    expect(prisma.activityLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ type: "PAYMENT_REFUNDED", message: "Payment refunded (Stripe charge.refunded)", entityId: "p1" }),
    });
    expect(notifyPaymentEvent).toHaveBeenCalledWith(prisma, { customerId: "c1", invoiceId: "inv1", title: "Payment refunded", body: "Stripe charge.refunded" });
    expect(notifyInvoicePaid).not.toHaveBeenCalled();
  });

  it("DISPUTED: reopens the invoice (SENT), logs and notifies; a won dispute (DISPUTED -> PAID) settles it again", async () => {
    const opened = tx({ ...base, status: "PAID", paidAt: new Date() });
    await createPaymentService(opened as any).transition("p1", "DISPUTED" as any);
    expect(opened.invoice.updateMany).toHaveBeenCalledWith({ where: { visitId: "v1", status: "PAID" }, data: { status: "SENT", paidAt: null } });
    expect(opened.activityLog.create).toHaveBeenCalledWith({ data: expect.objectContaining({ type: "PAYMENT_DISPUTED", message: "Payment disputed" }) });
    expect(notifyPaymentEvent).toHaveBeenCalledWith(opened, expect.objectContaining({ title: "Payment disputed", body: undefined }));

    vi.clearAllMocks();
    const won = tx({ ...base, status: "DISPUTED" });
    await createPaymentService(won as any).transition("p1", "PAID" as any, { note: "Stripe dispute won" });
    expect(won.activityLog.create).toHaveBeenCalledWith({ data: expect.objectContaining({ type: "PAYMENT_DISPUTE_WON", message: "Payment dispute won (Stripe dispute won)" }) });
    expect(notifyPaymentEvent).toHaveBeenCalledWith(won, expect.objectContaining({ title: "Payment dispute won" }));
    expect(notifyInvoicePaid).not.toHaveBeenCalled();
  });

  it("an event with no invoice change still audits and notifies without an invoiceId", async () => {
    const prisma = tx({ ...base, status: "PAID", visitId: null });
    await createPaymentService(prisma as any).transition("p1", "REFUNDED" as any);
    expect(prisma.invoice.updateMany).not.toHaveBeenCalled();
    expect(notifyPaymentEvent).toHaveBeenCalledWith(prisma, { customerId: "c1", invoiceId: undefined, title: "Payment refunded", body: undefined });
    const noInvoice = tx({ ...base, status: "PAID" });
    noInvoice.invoice.updateMany.mockResolvedValue({ count: 0 });
    await createPaymentService(noInvoice as any).transition("p1", "DISPUTED" as any, { note: "n" });
    expect(noInvoice.invoice.findFirst).not.toHaveBeenCalled();
  });
});
