import { describe, it, expect, vi } from "vitest";
import { evaluateDebtGate } from "../services/debt-gate";

const dec = (n: number) => ({ toNumber: () => n });

function makeTp(opts: {
  customer?: { holdNextClean: boolean } | null;
  settings?: Record<string, unknown> | null;
  invoices?: number[];
}) {
  return {
    customer: { findUnique: vi.fn().mockResolvedValue(opts.customer === undefined ? { holdNextClean: false } : opts.customer) },
    businessSettings: { findFirst: vi.fn().mockResolvedValue(opts.settings ?? null) },
    invoice: { findMany: vi.fn().mockResolvedValue((opts.invoices ?? []).map((a) => ({ amount: dec(a) }))) },
  } as never;
}

const enabled = (limits: { debtHoldMaxInvoices?: number | null; debtHoldMaxAmount?: number | null }) => ({
  debtHoldEnabled: true,
  debtHoldMaxInvoices: limits.debtHoldMaxInvoices ?? null,
  debtHoldMaxAmount: limits.debtHoldMaxAmount == null ? null : dec(limits.debtHoldMaxAmount),
});

describe("evaluateDebtGate", () => {
  it("blocks a customer on manual hold (holdNextClean), even with debt hold disabled", async () => {
    const gate = await evaluateDebtGate(makeTp({ customer: { holdNextClean: true } }), "c1");
    expect(gate).toEqual({ canStart: false, blockReason: expect.stringMatching(/payment hold/) });
  });

  it("allows when debt hold is disabled or settings/customer are missing", async () => {
    expect((await evaluateDebtGate(makeTp({ customer: null, settings: null }), "c1")).canStart).toBe(true);
    expect((await evaluateDebtGate(makeTp({ settings: { debtHoldEnabled: false } }), "c1")).canStart).toBe(true);
  });

  it("ACT-07: invoices whose direct debit is still being collected are excluded from the debt count", async () => {
    const tp = makeTp({ settings: enabled({}), invoices: [5] }) as unknown as { invoice: { findMany: ReturnType<typeof vi.fn> } };
    await evaluateDebtGate(tp as never, "c1");
    expect(tp.invoice.findMany).toHaveBeenCalledWith({
      where: {
        customerId: "c1",
        status: { in: ["DRAFT", "SENT"] },
        NOT: { visit: { is: { payment: { is: { method: "GOCARDLESS", status: { in: ["PENDING", "PROCESSING"] } } } } } },
      },
      select: { amount: true },
    });
  });

  it("allows when there is no outstanding debt", async () => {
    expect((await evaluateDebtGate(makeTp({ settings: enabled({}) }), "c1")).canStart).toBe(true);
  });

  it("blocks on any debt when neither limit is set", async () => {
    const gate = await evaluateDebtGate(makeTp({ settings: enabled({}), invoices: [5] }), "c1");
    expect(gate.canStart).toBe(false);
    expect(gate.blockReason).toContain("£5.00");
  });

  it("D-5: only a max amount set → a count of invoices alone does not block", async () => {
    const tp = makeTp({ settings: enabled({ debtHoldMaxAmount: 100 }), invoices: [10, 10, 10] });
    expect((await evaluateDebtGate(tp, "c1")).canStart).toBe(true);
    const over = makeTp({ settings: enabled({ debtHoldMaxAmount: 100 }), invoices: [60, 50] });
    expect((await evaluateDebtGate(over, "c1")).canStart).toBe(false);
  });

  it("D-5: only a max invoice count set → the amount alone does not block", async () => {
    const tp = makeTp({ settings: enabled({ debtHoldMaxInvoices: 2 }), invoices: [500, 500] });
    expect((await evaluateDebtGate(tp, "c1")).canStart).toBe(true);
    const over = makeTp({ settings: enabled({ debtHoldMaxInvoices: 2 }), invoices: [1, 1, 1] });
    expect((await evaluateDebtGate(over, "c1")).canStart).toBe(false);
  });
});
