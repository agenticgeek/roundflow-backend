import { describe, it, expect, vi, beforeEach } from "vitest";

const findTenant = vi.fn();
vi.mock("../../lib/prisma", () => ({ prisma: { tenant: { findUnique: (...a: unknown[]) => findTenant(...a) } } }));
const getInvoiceCheckoutLink = vi.fn();
vi.mock("../../integrations/stripe/checkout", () => ({ getInvoiceCheckoutLink: (...a: unknown[]) => getInvoiceCheckoutLink(...a) }));

import { invoicePaymentInfo } from "../invoice-payment-info";

const tp = {} as never;
const invoice = { id: "i1", customerId: "c1", invoiceNumber: "INV-1", amount: { toNumber: () => 30 } as never };
const bank = { accountName: "Coates", sortCode: "10-20-30", accountNumber: "12345678" };
const bankRows = [["Account name", "Coates"], ["Sort code", "10-20-30"], ["Account number", "12345678"]];
const connected = { stripeConnected: true, stripeConnectAccountId: "acct_1" };
const link = { label: "Pay online", url: "https://checkout.stripe.test/c/pay/cs_1" };

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  findTenant.mockResolvedValue({ id: "t1" });
  getInvoiceCheckoutLink.mockResolvedValue({ url: link.url, expiresAt: null });
});

describe("invoicePaymentInfo", () => {
  it("STRIPE customer: a Pay online link built for the tenant, and no bank details", async () => {
    const res = await invoicePaymentInfo(tp, { invoice, method: "STRIPE" as never, bank, settings: connected });
    expect(res).toEqual({ rows: [], cta: link });
    expect(findTenant).toHaveBeenCalledWith({ where: { stripeConnectAccountId: "acct_1" }, select: { id: true } });
    expect(getInvoiceCheckoutLink).toHaveBeenCalledWith(tp, { tenantId: "t1", invoiceId: "i1", customerId: "c1", invoiceNumber: "INV-1", amount: invoice.amount });
  });

  it("STRIPE customer but Stripe is not connected: bank details are the fallback, no link attempted", async () => {
    const res = await invoicePaymentInfo(tp, { invoice, method: "STRIPE" as never, bank, settings: { stripeConnected: false, stripeConnectAccountId: null } });
    expect(res).toEqual({ rows: bankRows });
    expect(getInvoiceCheckoutLink).not.toHaveBeenCalled();
  });

  it("STRIPE customer, no settings row at all: nothing to offer and no crash", async () => {
    expect(await invoicePaymentInfo(tp, { invoice, method: "STRIPE" as never, bank: null, settings: null })).toEqual({ rows: [] });
  });

  it("STRIPE customer whose link cannot be made: the send carries on with the bank fallback and logs it", async () => {
    getInvoiceCheckoutLink.mockRejectedValue(new Error("stripe down"));
    const res = await invoicePaymentInfo(tp, { invoice, method: "STRIPE" as never, bank, settings: connected });
    expect(res).toEqual({ rows: bankRows });
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("INV-1 emailed without a payment link"), "stripe down");
  });

  it("an account id with no matching tenant gives no link", async () => {
    findTenant.mockResolvedValue(null);
    const res = await invoicePaymentInfo(tp, { invoice, method: "STRIPE" as never, bank: null, settings: connected });
    expect(res).toEqual({ rows: [] });
    expect(getInvoiceCheckoutLink).not.toHaveBeenCalled();
  });

  it("BACS customer: bank details only, never a Stripe link even when Stripe is connected", async () => {
    const res = await invoicePaymentInfo(tp, { invoice, method: "BACS" as never, bank, settings: connected });
    expect(res).toEqual({ rows: bankRows });
    expect(getInvoiceCheckoutLink).not.toHaveBeenCalled();
  });

  it("BACS customer with no bank details saved: nothing extra", async () => {
    expect(await invoicePaymentInfo(tp, { invoice, method: "BACS" as never, bank: null, settings: connected })).toEqual({ rows: [] });
  });

  it("no default method: both the link and the bank details are offered", async () => {
    expect(await invoicePaymentInfo(tp, { invoice, method: null, bank, settings: connected })).toEqual({ rows: bankRows, cta: link });
  });

  it.each(["GOCARDLESS", "CASH", "CHEQUE"])("%s customer is not asked to pay another way", async (method) => {
    const res = await invoicePaymentInfo(tp, { invoice, method: method as never, bank, settings: connected });
    expect(res).toEqual({ rows: [] });
    expect(getInvoiceCheckoutLink).not.toHaveBeenCalled();
  });
});
