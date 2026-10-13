import { InvoiceStatus } from "../../generated/tenant-client";
import type { TenantPrismaClient } from "../../lib/tenant-prisma-manager";

export interface DebtGate {
  canStart: boolean;
  blockReason: string | null;
}

// Shared debt-hold evaluation. Used by GET /visits/:id (to surface
// canStart/blockReason before the tech taps Start) and PATCH /visits/:id/start
// (to enforce it with a 403). Mirrors the admin debt-hold policy on
// BusinessSettings. A null limit means "any outstanding debt blocks".
export async function evaluateDebtGate(
  prisma: TenantPrismaClient,
  customerId: string
): Promise<DebtGate> {
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

  const blockedByCount = maxCount === null ? true : count > maxCount;
  const blockedByAmount = maxAmount === null ? true : total > maxAmount;

  if (blockedByCount || blockedByAmount) {
    return {
      canStart: false,
      blockReason: `Customer has ${count} unpaid invoice(s) totalling £${total.toFixed(2)}, over the allowed limit.`,
    };
  }
  return { canStart: true, blockReason: null };
}
