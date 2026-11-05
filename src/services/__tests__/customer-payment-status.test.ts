import { it, expect } from "vitest";
import { deriveCustomerPaymentStatus, invoiceAmountDue } from "../customer-payment-status";
import { InvoiceStatus, PaymentStatus } from "../../generated/tenant-client";

const now = new Date("2026-10-30T12:00:00Z");
const inv = (status: InvoiceStatus, dueDate: Date | null = null, amount = 10) => ({ status, dueDate, amount });

it.each([
  ["ON_HOLD wins over everything", { onHold: true, latestPaymentStatus: PaymentStatus.FAILED, invoices: [inv(InvoiceStatus.SENT)] }, "ON_HOLD"],
  ["FAILED when the latest payment failed", { onHold: false, latestPaymentStatus: PaymentStatus.FAILED, invoices: [] }, "FAILED"],
  ["OVERDUE for a past-due SENT invoice", { onHold: false, latestPaymentStatus: PaymentStatus.PENDING, invoices: [inv(InvoiceStatus.SENT, new Date("2026-10-01"))] }, "OVERDUE"],
  ["UNPAID for a SENT invoice not yet due", { onHold: false, latestPaymentStatus: null, invoices: [inv(InvoiceStatus.SENT, new Date("2026-11-30"))] }, "UNPAID"],
  ["UNPAID for a SENT invoice with no due date", { onHold: false, latestPaymentStatus: undefined, invoices: [inv(InvoiceStatus.SENT)] }, "UNPAID"],
  ["PAID when the invoices are paid (drafts/voids ignored)", { onHold: false, latestPaymentStatus: PaymentStatus.PAID, invoices: [inv(InvoiceStatus.PAID), inv(InvoiceStatus.VOID), inv(InvoiceStatus.DRAFT)] }, "PAID"],
  ["NONE with only draft/void invoices", { onHold: false, latestPaymentStatus: null, invoices: [inv(InvoiceStatus.DRAFT)] }, "NONE"],
  ["NONE with no invoices", { onHold: false, latestPaymentStatus: null, invoices: [] }, "NONE"],
] as const)("deriveCustomerPaymentStatus: %s", (_label, input, expected) => {
  expect(deriveCustomerPaymentStatus({ ...input, invoices: [...input.invoices], now })).toBe(expected);
});

it("invoiceAmountDue sums SENT invoices only", () => {
  expect(
    invoiceAmountDue([inv(InvoiceStatus.SENT, null, 12.5), inv(InvoiceStatus.SENT, null, 7.5), inv(InvoiceStatus.PAID, null, 100)])
  ).toBe(20);
  expect(invoiceAmountDue([])).toBe(0);
});
