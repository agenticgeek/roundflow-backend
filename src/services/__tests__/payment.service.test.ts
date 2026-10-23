import { describe, it, expect, vi } from "vitest";
import { computeBalanceOwed } from "../payment.service";

function makePrisma(sumAmount: number | null) {
  return {
    invoice: {
      aggregate: vi.fn().mockResolvedValue({ _sum: { amount: sumAmount } }),
    },
  };
}

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
