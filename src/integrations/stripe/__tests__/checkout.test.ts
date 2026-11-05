import { describe, it, expect, vi } from "vitest";
const getStripeClientMock = vi.fn();
vi.mock("../client", () => ({ getStripeClient: (...a: unknown[]) => getStripeClientMock(...a) }));
import { createOneTimeSession, createSetupSession, getInvoiceCheckoutLink } from "../checkout";
import { encrypt } from "../../../lib/crypto";
import type Stripe from "stripe";
import type { TenantPrismaClient } from "../../../lib/tenant-prisma-manager";

function makeStripe(sessionOverrides: Record<string, unknown> = {}) {
  return {
    customers: {
      create: vi.fn().mockResolvedValue({ id: "cus_new_123" }),
    },
    checkout: {
      sessions: {
        create: vi.fn().mockResolvedValue({
          id: "cs_test_123",
          url: "https://checkout.stripe.com/pay/cs_test_123",
          expires_at: 1_700_000_000,
          ...sessionOverrides,
        }),
      },
    },
  } as unknown as Stripe;
}

function makeTenantPrisma(customerOverrides: Record<string, unknown> = {}) {
  const customer = {
    findUniqueOrThrow: vi.fn().mockResolvedValue({
      id: "cust-1",
      name: "John Smith",
      email: "john@example.com",
      phone: "07000000000",
      stripeCustomerId: null,
      ...customerOverrides,
    }),
    update: vi.fn().mockResolvedValue({}),
  };
  return { customer } as unknown as TenantPrismaClient;
}

describe("createOneTimeSession", () => {
  it("creates a Stripe customer when the RoundFlow customer has none yet", async () => {
    const stripe = makeStripe();
    const tp = makeTenantPrisma();

    const result = await createOneTimeSession(stripe, tp, {
      tenantId: "tenant-1",
      customerId: "cust-1",
      invoiceId: "inv-1",
      invoiceNumber: "INV-2026-001",
      amountPence: 3500,
      successUrl: "https://app.test/success",
      cancelUrl: "https://app.test/cancel",
    });

    expect(stripe.customers.create).toHaveBeenCalledWith({
      name: "John Smith",
      email: "john@example.com",
      phone: "07000000000",
      metadata: { roundflowCustomerId: "cust-1" },
    });
    expect(tp.customer.update).toHaveBeenCalledWith({
      where: { id: "cust-1" },
      data: { stripeCustomerId: "cus_new_123" },
    });
    expect(stripe.checkout.sessions.create).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "payment",
        customer: "cus_new_123",
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: "gbp",
              unit_amount: 3500,
              product_data: { name: "Invoice INV-2026-001" },
            },
          },
        ],
        metadata: { tenantId: "tenant-1", invoiceId: "inv-1", customerId: "cust-1" },
        success_url: "https://app.test/success",
        cancel_url: "https://app.test/cancel",
      })
    );
    expect(result).toEqual({
      stripeSessionId: "cs_test_123",
      url: "https://checkout.stripe.com/pay/cs_test_123",
      expiresAt: new Date(1_700_000_000 * 1000),
    });
  });

  it("reuses an existing stripeCustomerId without calling Stripe to create one", async () => {
    const stripe = makeStripe();
    const tp = makeTenantPrisma({ stripeCustomerId: "cus_existing" });

    await createOneTimeSession(stripe, tp, {
      tenantId: "tenant-1",
      customerId: "cust-1",
      invoiceId: "inv-1",
      invoiceNumber: "INV-2026-001",
      amountPence: 1000,
      successUrl: "https://app.test/success",
      cancelUrl: "https://app.test/cancel",
    });

    expect(stripe.customers.create).not.toHaveBeenCalled();
    expect(tp.customer.update).not.toHaveBeenCalled();
    expect(stripe.checkout.sessions.create).toHaveBeenCalledWith(
      expect.objectContaining({ customer: "cus_existing" })
    );
  });

  it("omits email/phone when the customer has none, and handles a null expires_at", async () => {
    const stripe = makeStripe({ expires_at: null });
    const tp = makeTenantPrisma({ email: null, phone: null });

    const result = await createOneTimeSession(stripe, tp, {
      tenantId: "tenant-1",
      customerId: "cust-1",
      invoiceId: "inv-1",
      invoiceNumber: "INV-2026-001",
      amountPence: 1000,
      successUrl: "https://app.test/success",
      cancelUrl: "https://app.test/cancel",
    });

    expect(stripe.customers.create).toHaveBeenCalledWith(
      expect.objectContaining({ email: undefined, phone: undefined })
    );
    expect(result.expiresAt).toBeNull();
  });
});

describe("createSetupSession", () => {
  it("creates a setup-mode session for an existing Stripe customer", async () => {
    const stripe = makeStripe({ id: "seti_test_123", url: "https://checkout.stripe.com/pay/seti_test_123" });
    const tp = makeTenantPrisma({ stripeCustomerId: "cus_existing" });

    const result = await createSetupSession(stripe, tp, {
      tenantId: "tenant-1",
      customerId: "cust-1",
      successUrl: "https://app.test/setup-success",
      cancelUrl: "https://app.test/setup-cancel",
    });

    expect(stripe.checkout.sessions.create).toHaveBeenCalledWith({
      mode: "setup",
      customer: "cus_existing",
      metadata: { tenantId: "tenant-1", customerId: "cust-1" },
      success_url: "https://app.test/setup-success",
      cancel_url: "https://app.test/setup-cancel",
    });
    expect(result.stripeSessionId).toBe("seti_test_123");
  });

  it("creates a Stripe customer first when none exists yet", async () => {
    const stripe = makeStripe();
    const tp = makeTenantPrisma();

    await createSetupSession(stripe, tp, {
      tenantId: "tenant-1",
      customerId: "cust-1",
      successUrl: "https://app.test/setup-success",
      cancelUrl: "https://app.test/setup-cancel",
    });

    expect(stripe.customers.create).toHaveBeenCalledTimes(1);
    expect(stripe.checkout.sessions.create).toHaveBeenCalledWith(
      expect.objectContaining({ customer: "cus_new_123" })
    );
  });

  it("returns a null expiresAt when Stripe doesn't send expires_at", async () => {
    const stripe = makeStripe({ expires_at: null });
    const tp = makeTenantPrisma({ stripeCustomerId: "cus_existing" });

    const result = await createSetupSession(stripe, tp, {
      tenantId: "tenant-1",
      customerId: "cust-1",
      successUrl: "https://app.test/setup-success",
      cancelUrl: "https://app.test/setup-cancel",
    });

    expect(result.expiresAt).toBeNull();
  });
});

describe("getInvoiceCheckoutLink", () => {
  const input = {
    tenantId: "t1", invoiceId: "inv-1", customerId: "cust-1", invoiceNumber: "INV-1",
    amount: { toString: () => "33.5", valueOf: () => 33.5 } as never,
  };

  function linkPrisma(bs: Record<string, unknown> | null, existing: Record<string, unknown> | null = null) {
    return {
      businessSettings: { findFirst: vi.fn().mockResolvedValue(bs) },
      stripeSession: { findFirst: vi.fn().mockResolvedValue(existing), create: vi.fn().mockResolvedValue({}) },
      customer: {
        findUniqueOrThrow: vi.fn().mockResolvedValue({ id: "cust-1", name: "J", email: null, phone: null, stripeCustomerId: "cus_1" }),
        update: vi.fn(),
      },
    } as unknown as TenantPrismaClient;
  }

  it("409 STRIPE_NOT_CONNECTED when Stripe isn't connected (no static fallback)", async () => {
    await expect(getInvoiceCheckoutLink(linkPrisma(null), input)).rejects.toMatchObject({ statusCode: 409, code: "STRIPE_NOT_CONNECTED" });
    await expect(getInvoiceCheckoutLink(linkPrisma({ stripeConnected: true, stripeSecretKeyEncrypted: null }), input))
      .rejects.toMatchObject({ code: "STRIPE_NOT_CONNECTED" });
  });

  it("reuses a still-open PENDING session", async () => {
    const expiresAt = new Date(Date.now() + 60_000);
    const tp = linkPrisma({ stripeConnected: true, stripeSecretKeyEncrypted: encrypt("sk_test") }, { url: "https://old", expiresAt });
    await expect(getInvoiceCheckoutLink(tp, input)).resolves.toEqual({ url: "https://old", expiresAt });
    expect(tp.stripeSession.create).not.toHaveBeenCalled();
  });

  it("creates a session on the connected account and records it", async () => {
    const stripe = makeStripe();
    getStripeClientMock.mockReturnValue(stripe);
    const tp = linkPrisma({ stripeConnected: true, stripeSecretKeyEncrypted: encrypt("sk_conn") });
    const result = await getInvoiceCheckoutLink(tp, input);
    expect(getStripeClientMock).toHaveBeenCalledWith("sk_conn");
    expect(stripe.checkout.sessions.create).toHaveBeenCalledWith(expect.objectContaining({
      success_url: expect.stringMatching(/\/invoices\/inv-1\?payment=success$/),
      line_items: [expect.objectContaining({ price_data: expect.objectContaining({ unit_amount: 3350 }) })],
    }));
    expect(tp.stripeSession.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ stripeSessionId: "cs_test_123", type: "ONE_TIME", invoiceId: "inv-1", customerId: "cust-1" }),
    });
    expect(result.url).toBe("https://checkout.stripe.com/pay/cs_test_123");
  });

  it("falls back to an empty frontend URL when FRONTEND_URL is unset", async () => {
    const original = process.env.FRONTEND_URL;
    delete process.env.FRONTEND_URL;
    try {
      const stripe = makeStripe();
      getStripeClientMock.mockReturnValue(stripe);
      await getInvoiceCheckoutLink(linkPrisma({ stripeConnected: true, stripeSecretKeyEncrypted: encrypt("k") }), input);
      expect(stripe.checkout.sessions.create).toHaveBeenCalledWith(expect.objectContaining({ success_url: "/invoices/inv-1?payment=success" }));
    } finally {
      process.env.FRONTEND_URL = original;
    }
  });
});
