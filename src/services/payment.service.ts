import type { TenantPrismaClient } from "../lib/tenant-prisma-manager";
import { AppError } from "../lib/app-error";
import { InvoiceStatus, PaymentStatus } from "../generated/tenant-client";
import { queueGhlEvent } from "../integrations/ghl/sync";

export type PaymentOutcome = "PAID" | "FAILED";

// "Owed" = sum of invoices actually sent to the customer and not yet settled
// (DRAFT isn't owed yet; PAID/VOID aren't owed anymore). Never stored — always
// computed fresh at the moment it's needed (e.g. before writing the GHL
// balance_owed custom field). See docs/ARCHITECTURE_LATEST.md §10.6.
export async function computeBalanceOwed(prisma: TenantPrismaClient, customerId: string): Promise<number> {
  const result = await prisma.invoice.aggregate({
    where: { customerId, status: InvoiceStatus.SENT },
    _sum: { amount: true },
  });
  return Number(result._sum.amount ?? 0);
}

// Single place for "what happens once a payment is known to be settled or
// failed" — regardless of whether that came from the GoCardless webhook, the
// Stripe webhook, or a manual reconciliation action (BACS/cheque). Updates
// the Payment row, flips the linked Invoice to PAID on success, and queues
// the matching GHL outbox event so the tag always follows the status.
export function createPaymentService(prisma: TenantPrismaClient) {
  return {
    applyOutcome: async (paymentId: string, outcome: PaymentOutcome) => {
      const payment = await prisma.payment.findUnique({ where: { id: paymentId } });
      if (!payment) throw new AppError(404, "Payment not found");

      const updated = await prisma.payment.update({
        where: { id: paymentId },
        data: {
          status: outcome === "PAID" ? PaymentStatus.PAID : PaymentStatus.FAILED,
          paidAt: outcome === "PAID" ? new Date() : payment.paidAt,
        },
      });

      if (outcome === "PAID" && payment.visitId) {
        await prisma.invoice.updateMany({
          where: { visitId: payment.visitId, status: { not: "PAID" } },
          data: { status: "PAID" },
        });
      }

      const eventType = outcome === "PAID" ? "payment.collected" : "payment.failed";
      queueGhlEvent(prisma, eventType, payment.customerId).catch(console.error);

      return updated;
    },
  };
}
