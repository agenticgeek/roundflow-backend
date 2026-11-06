import type { TenantPrismaClient } from "../lib/tenant-prisma-manager";
import { AppError } from "../lib/app-error";
import { InvoiceStatus, PaymentMethod, PaymentStatus, Prisma } from "../generated/tenant-client";
import { queueGhlEvent } from "../integrations/ghl/sync";
import { releaseHoldIfSettled } from "./payment-hold";
import { notifyInvoicePaid, notifyPaymentEvent, notifyPaymentFailed } from "./notify";
import { canTransition } from "./payment-state";

export type PaymentOutcome = "PAID" | "FAILED";

const PAYMENT_EVENT_TITLES: Partial<Record<PaymentStatus, string>> = {
  [PaymentStatus.REFUNDED]: "Payment refunded",
  [PaymentStatus.DISPUTED]: "Payment disputed",
  [PaymentStatus.PAID]: "Payment dispute won",
};

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

export type PaymentTarget = PaymentStatus;

export interface TransitionOptions {
  /** Manual actions: an illegal transition throws 409 INVALID_PAYMENT_TRANSITION instead of being ignored. */
  strict?: boolean;
  /** Short reason shown in the activity log / office notification (e.g. "Stripe charge.refunded"). */
  note?: string;
  /** The invoice to follow when the payment has no visit (invoices without a visit are matched by id). */
  invoiceId?: string;
}

export interface TransitionResult {
  payment: Prisma.PaymentGetPayload<object>;
  changed: boolean;
  from: PaymentStatus;
  /** The invoice whose status this transition flipped, if any. */
  invoice: { id: string; invoiceNumber: string; customerId: string } | null;
}

type Tx = Prisma.TransactionClient;

// Invoice follows the payment (same visit): PAID settles it; a dispute reopens it (the money was taken back);
// a refund voids it (the customer has their money back; credit notes / part payments are deferred, BE-08).
async function followInvoice(
  tx: Tx,
  payment: { visitId: string | null },
  target: PaymentStatus,
  paidAt: Date | null,
  invoiceId?: string
) {
  const where = payment.visitId ? { visitId: payment.visitId } : invoiceId ? { id: invoiceId } : null;
  if (!where) return null;
  let count = 0;
  if (target === PaymentStatus.PAID) {
    count = (
      await tx.invoice.updateMany({
        where: { ...where, status: { in: [InvoiceStatus.DRAFT, InvoiceStatus.SENT] } },
        data: { status: InvoiceStatus.PAID, paidAt },
      })
    ).count;
  } else if (target === PaymentStatus.DISPUTED) {
    count = (await tx.invoice.updateMany({ where: { ...where, status: InvoiceStatus.PAID }, data: { status: InvoiceStatus.SENT, paidAt: null } })).count;
  } else if (target === PaymentStatus.REFUNDED) {
    count = (
      await tx.invoice.updateMany({
        where: { ...where, status: { in: [InvoiceStatus.PAID, InvoiceStatus.SENT] } },
        data: { status: InvoiceStatus.VOID },
      })
    ).count;
  }
  if (count === 0) return null;
  return tx.invoice.findFirst({ where, select: { id: true, invoiceNumber: true, customerId: true } });
}

const AUDITED: Partial<Record<PaymentStatus, { type: string; label: string }>> = {
  [PaymentStatus.REFUNDED]: { type: "PAYMENT_REFUNDED", label: "refunded" },
  [PaymentStatus.DISPUTED]: { type: "PAYMENT_DISPUTED", label: "disputed" },
};

// Single place for "what happens once a payment changes state" — regardless of whether that came from the
// GoCardless webhook, the Stripe webhook, or a manual reconciliation action (BACS/cheque). The status change, the
// invoice change and the audit row commit together in ONE transaction using a conditional update
// (`where: { id, status: <what we read> }`), so two concurrent webhooks cannot both win and a late FAILED can
// never overwrite PAID (see payment-state.ts). Notifications, the GHL tag and the hold release run after commit.
export function createPaymentService(prisma: TenantPrismaClient) {
  const transition = async (paymentId: string, target: PaymentStatus, opts: TransitionOptions = {}): Promise<TransitionResult> => {
    const result = await prisma.$transaction(async (tx): Promise<TransitionResult> => {
      const current = await tx.payment.findUnique({ where: { id: paymentId } });
      if (!current) throw new AppError(404, "Payment not found");
      const unchanged: TransitionResult = { payment: current, changed: false, from: current.status, invoice: null };
      if (current.status === target) return unchanged;
      if (!canTransition(current.status, target)) {
        if (opts.strict) {
          throw new AppError(409, `A ${current.status} payment cannot become ${target}`, "INVALID_PAYMENT_TRANSITION");
        }
        return unchanged;
      }

      const paidAt = target === PaymentStatus.PAID ? new Date() : current.paidAt;
      const won = await tx.payment.updateMany({ where: { id: paymentId, status: current.status }, data: { status: target, paidAt } });
      if (won.count === 0) return unchanged; // a concurrent event already moved it; it owns the side effects

      const invoice = await followInvoice(tx, current, target, paidAt, opts.invoiceId);
      const audit = AUDITED[target];
      if (audit || (current.status === PaymentStatus.DISPUTED && target === PaymentStatus.PAID)) {
        const label = audit?.label ?? "dispute won";
        await tx.activityLog.create({
          data: {
            type: audit?.type ?? "PAYMENT_DISPUTE_WON",
            message: `Payment ${label}${opts.note ? ` (${opts.note})` : ""}`,
            entityId: paymentId,
            details: { from: current.status, to: target, customerId: current.customerId },
          },
        });
      }
      return { payment: { ...current, status: target, paidAt }, changed: true, from: current.status, invoice };
    });

    if (!result.changed) return result;
    const { payment, invoice } = result;
    if (target === PaymentStatus.PAID) {
      queueGhlEvent(prisma, "payment.collected", payment.customerId).catch(console.error);
      // A3 auto-release: last unpaid invoice settled -> lift the payment hold.
      await releaseHoldIfSettled(prisma, payment.customerId);
      if (invoice && result.from !== PaymentStatus.DISPUTED) await notifyInvoicePaid(prisma, invoice);
    } else if (target === PaymentStatus.FAILED) {
      queueGhlEvent(prisma, "payment.failed", payment.customerId).catch(console.error);
      await notifyPaymentFailed(prisma, payment.customerId);
    }
    if (target === PaymentStatus.REFUNDED || target === PaymentStatus.DISPUTED || result.from === PaymentStatus.DISPUTED) {
      await notifyPaymentEvent(prisma, {
        customerId: payment.customerId,
        invoiceId: invoice?.id,
        title: PAYMENT_EVENT_TITLES[target] as string, // only REFUNDED / DISPUTED / dispute-won PAID reach here
        body: opts.note,
      });
    }
    return result;
  };

  return {
    transition,

    // PAID / FAILED outcome of a settlement or a manual reconciliation. Illegal transitions are ignored (webhook
    // safe); the manual route passes the strict transition itself.
    applyOutcome: async (paymentId: string, outcome: PaymentOutcome) =>
      (await transition(paymentId, outcome === "PAID" ? PaymentStatus.PAID : PaymentStatus.FAILED)).payment,

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
