import { prisma } from "../lib/prisma";
import type { TenantPrismaClient } from "../lib/tenant-prisma-manager";
import { forEachTenant } from "../lib/tenant-jobs";
import { InvoiceStatus, PaymentMethod, PaymentStatus } from "../generated/tenant-client";

// BE-08: nightly sweep that WRITES the OVERDUE payment status (it was defined but never set). A payment is
// overdue when its invoice was sent and its due date has passed while the payment is still unsettled (NOT_DUE /
// PENDING). Direct debits (GoCardless) are excluded: they are being collected, not late (ACT-07). Deliberately NO
// reminders, GHL tags or notifications are sent from here: reminders stay manual (debt "remind") until a cadence
// is designed. The invoice itself stays SENT; "overdue" on an invoice is derived (see InvoiceService list).

const startOfUtcDay = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));

/** Marks the tenant's overdue payments; returns how many changed. */
export async function sweepOverduePayments(tp: TenantPrismaClient, now = new Date()): Promise<number> {
  const { count } = await tp.payment.updateMany({
    where: {
      status: { in: [PaymentStatus.NOT_DUE, PaymentStatus.PENDING] },
      method: { not: PaymentMethod.GOCARDLESS },
      visit: { is: { invoice: { is: { status: InvoiceStatus.SENT, dueDate: { lt: startOfUtcDay(now) } } } } },
    },
    data: { status: PaymentStatus.OVERDUE },
  });
  if (count > 0) {
    await tp.activityLog.create({
      data: { type: "PAYMENTS_MARKED_OVERDUE", message: `${count} unpaid ${count === 1 ? "payment" : "payments"} passed the invoice due date and ${count === 1 ? "was" : "were"} marked overdue`, details: { count } },
    });
  }
  return count;
}

export async function runOverdueSweep(now = new Date()): Promise<void> {
  const tenants = await prisma.tenant.findMany({ select: { schemaName: true } });
  const results = await forEachTenant(tenants, (tp) => sweepOverduePayments(tp, now));
  for (const r of results) {
    if (r.status === "rejected") console.error("[overdueSweep] tenant failed:", r.reason);
  }
}
