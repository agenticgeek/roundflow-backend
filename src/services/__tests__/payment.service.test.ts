import { describe, it, expect, vi, beforeEach } from "vitest";

const queueGhlEvent = vi.fn();
vi.mock("../../integrations/ghl/sync", () => ({ queueGhlEvent: (...a: unknown[]) => queueGhlEvent(...a) }));
const releaseHoldIfSettled = vi.fn();
vi.mock("../payment-hold", () => ({ releaseHoldIfSettled: (...a: unknown[]) => releaseHoldIfSettled(...a) }));

import { computeBalanceOwed, createPaymentService } from "../payment.service";

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

describe("applyOutcome", () => {
  function tp(payment: Record<string, unknown> | null) {
    return {
      payment: { findUnique: vi.fn().mockResolvedValue(payment), update: vi.fn().mockResolvedValue({ id: "p1" }) },
      invoice: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    };
  }

  it("404s for an unknown payment", async () => {
    await expect(createPaymentService(tp(null) as any).applyOutcome("x", "PAID")).rejects.toMatchObject({ statusCode: 404 });
  });

  it("PAID: stamps paidAt on payment + invoice, queues GHL and runs the hold auto-release", async () => {
    const prisma = tp({ id: "p1", visitId: "v1", customerId: "c1", paidAt: null });
    await createPaymentService(prisma as any).applyOutcome("p1", "PAID");
    const paidAt = prisma.payment.update.mock.calls[0][0].data.paidAt;
    expect(paidAt).toBeInstanceOf(Date);
    expect(prisma.invoice.updateMany).toHaveBeenCalledWith({
      where: { visitId: "v1", status: { not: "PAID" } },
      data: { status: "PAID", paidAt },
    });
    expect(queueGhlEvent).toHaveBeenCalledWith(prisma, "payment.collected", "c1");
    expect(releaseHoldIfSettled).toHaveBeenCalledWith(prisma, "c1");
  });

  it("PAID without a visit doesn't touch invoices", async () => {
    const prisma = tp({ id: "p1", visitId: null, customerId: "c1", paidAt: null });
    await createPaymentService(prisma as any).applyOutcome("p1", "PAID");
    expect(prisma.invoice.updateMany).not.toHaveBeenCalled();
  });

  it("FAILED keeps paidAt, queues payment.failed and never releases the hold", async () => {
    const old = new Date("2026-01-01T00:00:00Z");
    const prisma = tp({ id: "p1", visitId: "v1", customerId: "c1", paidAt: old });
    queueGhlEvent.mockRejectedValue(new Error("outbox"));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await createPaymentService(prisma as any).applyOutcome("p1", "FAILED");
    expect(prisma.payment.update).toHaveBeenCalledWith({ where: { id: "p1" }, data: { status: "FAILED", paidAt: old } });
    expect(queueGhlEvent).toHaveBeenCalledWith(prisma, "payment.failed", "c1");
    expect(releaseHoldIfSettled).not.toHaveBeenCalled();
    await new Promise((r) => setImmediate(r));
    err.mockRestore();
  });
});
