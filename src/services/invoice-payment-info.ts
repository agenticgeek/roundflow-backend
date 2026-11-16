import { PaymentMethod } from "../generated/tenant-client";
import type { Prisma } from "../generated/tenant-client";
import type { TenantPrismaClient } from "../lib/tenant-prisma-manager";
import { prisma as publicPrisma } from "../lib/prisma";
import { getInvoiceCheckoutLink } from "../integrations/stripe/checkout";

export interface InvoicePayBank {
  accountName: string;
  sortCode: string;
  accountNumber: string;
}

export interface InvoicePaymentInfo {
  /** Extra rows for the email's summary table (bank details). */
  rows: Array<[string, string]>;
  /** "Pay online" button, only when a Stripe Checkout link could be made. */
  cta?: { label: string; url: string };
}

/**
 * What an invoice email tells the customer about HOW to pay, driven by the customer's payment method:
 *   STRIPE → a "Pay online" Stripe Checkout link (bank details only as a fallback when no link could be made);
 *   BACS   → the tenant's bank details;
 *   no default method → whichever of the two is available;
 *   GOCARDLESS / CASH / CHEQUE → neither (a Direct Debit, cash or cheque customer is not asked to pay another way).
 * Never throws: a missing or failing Stripe link must not stop the invoice being sent.
 */
export async function invoicePaymentInfo(
  tp: TenantPrismaClient,
  input: {
    invoice: { id: string; customerId: string; invoiceNumber: string; amount: Prisma.Decimal };
    method: PaymentMethod | null;
    bank: InvoicePayBank | null;
    settings: { stripeConnected: boolean; stripeConnectAccountId: string | null } | null;
  }
): Promise<InvoicePaymentInfo> {
  const { invoice, method, bank, settings } = input;

  let cta: InvoicePaymentInfo["cta"];
  const offersLink = method === PaymentMethod.STRIPE || method === null;
  if (offersLink && settings?.stripeConnected && settings.stripeConnectAccountId) {
    try {
      const tenant = await publicPrisma.tenant.findUnique({ where: { stripeConnectAccountId: settings.stripeConnectAccountId }, select: { id: true } });
      if (tenant) {
        const link = await getInvoiceCheckoutLink(tp, {
          tenantId: tenant.id,
          invoiceId: invoice.id,
          customerId: invoice.customerId,
          invoiceNumber: invoice.invoiceNumber,
          amount: invoice.amount,
        });
        cta = { label: "Pay online", url: link.url };
      }
    } catch (err) {
      console.error(`[invoices] invoice ${invoice.invoiceNumber} emailed without a payment link:`, (err as Error).message);
    }
  }

  const offersBank = method === PaymentMethod.BACS || method === null || (method === PaymentMethod.STRIPE && !cta);
  const rows: Array<[string, string]> = offersBank && bank
    ? [["Account name", bank.accountName], ["Sort code", bank.sortCode], ["Account number", bank.accountNumber]]
    : [];
  return { rows, ...(cta ? { cta } : {}) };
}
