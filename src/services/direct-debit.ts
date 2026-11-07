import { PaymentMethod, type Prisma } from "../generated/tenant-client";
import { COLLECTING_STATUSES } from "./payment-state";

// ACT-07: an invoice whose GoCardless direct debit is still being collected (payment PENDING or PROCESSING) is not
// overdue debt: the money is on its way. These fragments exclude / select such invoices so debt aging, the debt
// board and the debt gate ignore them until the debit fails or is cancelled.

/** Prisma `where` fragment: the invoice is NOT currently being collected by direct debit. */
export const NOT_COLLECTING_INVOICE: Prisma.InvoiceWhereInput = {
  NOT: {
    visit: {
      is: { payment: { is: { method: PaymentMethod.GOCARDLESS, status: { in: [...COLLECTING_STATUSES] } } } },
    },
  },
};
