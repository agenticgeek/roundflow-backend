import { InvoiceStatus } from "../../generated/tenant-client";
import type { TenantPrismaClient } from "../../lib/tenant-prisma-manager";

export interface DebtGate {
  canStart: boolean;
  blockReason: string | null;
}

// Shared debt-hold evaluation. Used by GET /visits/:id (to surface
// canStart/blockReason before the tech taps Start) and PATCH /visits/:id/start
// (to enforce it with a 403). Mirrors the admin debt-hold policy on
// BusinessSettings.
//
// - A manual hold (Customer.holdNextClean, PATCH /debt/:id/hold) always blocks.
// - With debt hold enabled and NO limits set, any outstanding debt blocks.
// - With one or both limits set, a null limit means "no limit" on that
//   dimension (D-5: setting only a max amount must not block on any debt).
export async function evaluateDebtGate(
  prisma: TenantPrismaClient,
  customerId: string
): Promise<DebtGate> {
  const customer = await prisma.customer.findUnique({
    where: { id: customerId },
    select: { holdNextClean: true },
  });
  if (customer?.holdNextClean) {
    return { canStart: false, blockReason: "This customer's clean is on payment hold." };
  }

  const settings = await prisma.businessSettings.findFirst({
    select: { debtHoldEnabled: true, debtHoldMaxInvoices: true, debtHoldMaxAmount: true },
  });
  if (!settings?.debtHoldEnabled) return { canStart: true, blockReason: null };

  const invoices = await prisma.invoice.findMany({
    where: { customerId, status: { in: [InvoiceStatus.DRAFT, InvoiceStatus.SENT] } },
    select: { amount: true },
  });
  if (invoices.length === 0) return { canStart: true, blockReason: null };

  const count = invoices.length;
  const total = invoices.reduce((s, i) => s + i.amount.toNumber(), 0);
  const maxCount = settings.debtHoldMaxInvoices;
  const maxAmount = settings.debtHoldMaxAmount?.toNumber() ?? null;

  const blocked = maxCount === null && maxAmount === null
    ? true
    : (maxCount !== null && count > maxCount) || (maxAmount !== null && total > maxAmount);

  if (blocked) {
    return {
      canStart: false,
      blockReason: `Customer has ${count} unpaid invoice(s) totalling £${total.toFixed(2)}, over the allowed limit.`,
    };
  }
  return { canStart: true, blockReason: null };
}
