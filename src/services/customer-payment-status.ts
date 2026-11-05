import { InvoiceStatus, PaymentStatus, Prisma } from "../generated/tenant-client";

// GAP-021: the customer badge (list + detail) comes from invoices, not from
// the latest Payment row. Precedence, first match wins:
//   ON_HOLD  customer.holdNextClean, or an open visit on payment hold
//   FAILED   the customer's most recent payment failed
//   OVERDUE  an unpaid SENT invoice is past its dueDate
//   UNPAID   any unpaid SENT invoice
//   PAID     at least one invoice and every non-draft, non-void one is paid
//   NONE     no invoices (render blank / "No invoices", never "Paid")
export type CustomerPaymentStatus = "NONE" | "PAID" | "UNPAID" | "OVERDUE" | "ON_HOLD" | "FAILED";

export interface InvoiceLike {
  status: InvoiceStatus;
  dueDate: Date | null;
  amount: Prisma.Decimal | number;
}

export function deriveCustomerPaymentStatus(input: {
  onHold: boolean;
  latestPaymentStatus: PaymentStatus | null | undefined;
  invoices: InvoiceLike[];
  now: Date;
}): CustomerPaymentStatus {
  if (input.onHold) return "ON_HOLD";
  if (input.latestPaymentStatus === PaymentStatus.FAILED) return "FAILED";
  const unpaid = input.invoices.filter((i) => i.status === InvoiceStatus.SENT);
  if (unpaid.some((i) => i.dueDate != null && i.dueDate < input.now)) return "OVERDUE";
  if (unpaid.length > 0) return "UNPAID";
  if (input.invoices.some((i) => i.status === InvoiceStatus.PAID)) return "PAID";
  return "NONE";
}

// Sum of unpaid (SENT) invoice totals.
export function invoiceAmountDue(invoices: InvoiceLike[]): number {
  return Number(
    invoices
      .filter((i) => i.status === InvoiceStatus.SENT)
      .reduce((sum, i) => sum.add(i.amount), new Prisma.Decimal(0))
  );
}
