import type { TenantPrismaClient } from "../lib/tenant-prisma-manager";
import { AppError } from "../lib/app-error";
import { InvoiceStatus, PaymentMethod, PaymentStatus, Prisma } from "../generated/tenant-client";
import { queueGhlEvent } from "../integrations/ghl/sync";
import { releaseHoldIfSettled } from "./payment-hold";

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

export interface PaymentListFilters {
  status?: PaymentStatus;
  method?: PaymentMethod;
  from?: Date;
  to?: Date; // inclusive day (YYYY-MM-DD at UTC midnight)
}

function paymentWhere(f: PaymentListFilters): Prisma.PaymentWhereInput {
  const where: Prisma.PaymentWhereInput = {};
  if (f.status) where.status = f.status;
  if (f.method) where.method = f.method;
  if (f.from || f.to) {
    where.createdAt = {
      ...(f.from ? { gte: f.from } : {}),
      ...(f.to ? { lt: new Date(f.to.getTime() + 86_400_000) } : {}),
    };
  }
  return where;
}

const paymentListInclude = {
  customer: { select: { id: true, name: true } },
  visit: { select: { date: true, invoice: { select: { id: true, invoiceNumber: true } } } },
} satisfies Prisma.PaymentInclude;

type PaymentListRow = Prisma.PaymentGetPayload<{ include: typeof paymentListInclude }>;

function toPaymentRow(p: PaymentListRow) {
  return {
    id: p.id,
    customer: { id: p.customer.id, name: p.customer.name },
    amount: p.amount.toNumber(),
    method: p.method,
    status: p.status,
    paidAt: p.paidAt,
    createdAt: p.createdAt,
    visitId: p.visitId,
    visitDate: p.visit?.date ?? null,
    invoiceId: p.visit?.invoice?.id ?? null,
    invoiceNumber: p.visit?.invoice?.invoiceNumber ?? null,
  };
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

      const paidAt = outcome === "PAID" ? new Date() : payment.paidAt;
      const updated = await prisma.payment.update({
        where: { id: paymentId },
        data: {
          status: outcome === "PAID" ? PaymentStatus.PAID : PaymentStatus.FAILED,
          paidAt,
        },
      });

      if (outcome === "PAID" && payment.visitId) {
        await prisma.invoice.updateMany({
          where: { visitId: payment.visitId, status: { not: "PAID" } },
          data: { status: "PAID", paidAt },
        });
      }

      const eventType = outcome === "PAID" ? "payment.collected" : "payment.failed";
      queueGhlEvent(prisma, eventType, payment.customerId).catch(console.error);

      // A3 auto-release: last unpaid invoice settled → lift the payment hold.
      if (outcome === "PAID") await releaseHoldIfSettled(prisma, payment.customerId);

      return updated;
    },

    // GET /payments (GAP-028) — newest first.
    listPayments: async (filters: PaymentListFilters, page: number, pageSize: number) => {
      const where = paymentWhere(filters);
      const [total, payments] = await Promise.all([
        prisma.payment.count({ where }),
        prisma.payment.findMany({
          where,
          include: paymentListInclude,
          orderBy: { createdAt: "desc" },
          take: pageSize,
          skip: (page - 1) * pageSize,
        }),
      ]);
      return {
        rows: payments.map(toPaymentRow),
        pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) },
      };
    },

    // GET /payments/export.csv — every matching row, flattened for CSV.
    exportPayments: async (filters: PaymentListFilters) => {
      const payments = await prisma.payment.findMany({
        where: paymentWhere(filters),
        include: paymentListInclude,
        orderBy: { createdAt: "desc" },
      });
      return payments.map((p) => {
        const row = toPaymentRow(p);
        return {
          id: row.id,
          customerId: row.customer.id,
          customerName: row.customer.name,
          amount: row.amount.toFixed(2),
          method: row.method,
          status: row.status,
          paidAt: row.paidAt,
          createdAt: row.createdAt,
          visitDate: row.visitDate,
          invoiceNumber: row.invoiceNumber,
        };
      });
    },
  };
}
