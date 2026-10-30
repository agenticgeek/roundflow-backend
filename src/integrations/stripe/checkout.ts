import type Stripe from "stripe";
import type { TenantPrismaClient } from "../../lib/tenant-prisma-manager";
import { AppError } from "../../lib/app-error";
import { decrypt } from "../../lib/crypto";
import { getStripeClient } from "./client";
import { Prisma, StripeSessionStatus, StripeSessionType } from "../../generated/tenant-client";

interface OneTimeSessionInput {
  tenantId: string;
  customerId: string;
  invoiceId: string;
  invoiceNumber: string;
  amountPence: number;       // integer pence
  successUrl: string;
  cancelUrl: string;
}

interface SetupSessionInput {
  tenantId: string;
  customerId: string;
  successUrl: string;
  cancelUrl: string;
}

interface SessionResult {
  stripeSessionId: string;
  url: string;
  expiresAt: Date | null;
}

// Ensures the RoundFlow customer has a matching Stripe Customer object.
// Returns the Stripe Customer ID, creating one if needed.
async function ensureStripeCustomer(
  stripe: Stripe,
  tp: TenantPrismaClient,
  customerId: string
): Promise<string> {
  const customer = await tp.customer.findUniqueOrThrow({ where: { id: customerId } });
  if (customer.stripeCustomerId) return customer.stripeCustomerId;

  const stripeCustomer = await stripe.customers.create({
    name: customer.name,
    email: customer.email ?? undefined,
    phone: customer.phone ?? undefined,
    metadata: { roundflowCustomerId: customerId },
  });

  await tp.customer.update({
    where: { id: customerId },
    data: { stripeCustomerId: stripeCustomer.id },
  });

  return stripeCustomer.id;
}

export async function createOneTimeSession(
  stripe: Stripe,
  tp: TenantPrismaClient,
  input: OneTimeSessionInput
): Promise<SessionResult> {
  const stripeCustomerId = await ensureStripeCustomer(stripe, tp, input.customerId);

  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    customer: stripeCustomerId,
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: "gbp",
          unit_amount: input.amountPence,
          product_data: { name: `Invoice ${input.invoiceNumber}` },
        },
      },
    ],
    metadata: {
      tenantId: input.tenantId,
      invoiceId: input.invoiceId,
      customerId: input.customerId,
    },
    success_url: input.successUrl,
    cancel_url: input.cancelUrl,
  });

  return {
    stripeSessionId: session.id,
    url: session.url!,
    expiresAt: session.expires_at ? new Date(session.expires_at * 1000) : null,
  };
}

// Payment link for one invoice (A5): a real Checkout Session on the tenant's
// connected Stripe account. Reuses a still-open PENDING session for the same
// invoice instead of minting a new one per click. No static fallback — a
// tenant without Stripe gets 409 STRIPE_NOT_CONNECTED.
export async function getInvoiceCheckoutLink(
  tp: TenantPrismaClient,
  input: { tenantId: string; invoiceId: string; customerId: string; invoiceNumber: string; amount: Prisma.Decimal }
): Promise<{ url: string; expiresAt: Date | null }> {
  const bs = await tp.businessSettings.findFirst({
    select: { stripeConnected: true, stripeSecretKeyEncrypted: true },
  });
  if (!bs?.stripeConnected || !bs.stripeSecretKeyEncrypted) {
    throw new AppError(409, "Stripe is not connected. Connect Stripe in Settings › Payments to send payment links.", "STRIPE_NOT_CONNECTED");
  }

  const existing = await tp.stripeSession.findFirst({
    where: {
      invoiceId: input.invoiceId,
      status: StripeSessionStatus.PENDING,
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
    },
  });
  if (existing) return { url: existing.url, expiresAt: existing.expiresAt };

  const stripe = getStripeClient(decrypt(bs.stripeSecretKeyEncrypted));
  const frontend = process.env.FRONTEND_URL?.split(",")[0].trim() ?? "";
  const result = await createOneTimeSession(stripe, tp, {
    tenantId: input.tenantId,
    customerId: input.customerId,
    invoiceId: input.invoiceId,
    invoiceNumber: input.invoiceNumber,
    amountPence: Math.round(Number(input.amount) * 100),
    successUrl: `${frontend}/invoices/${input.invoiceId}?payment=success`,
    cancelUrl: `${frontend}/invoices/${input.invoiceId}?payment=cancelled`,
  });
  await tp.stripeSession.create({
    data: {
      stripeSessionId: result.stripeSessionId,
      type: StripeSessionType.ONE_TIME,
      customerId: input.customerId,
      invoiceId: input.invoiceId,
      amountTotal: input.amount,
      currency: "gbp",
      url: result.url,
      expiresAt: result.expiresAt,
    },
  });
  return { url: result.url, expiresAt: result.expiresAt };
}

export async function createSetupSession(
  stripe: Stripe,
  tp: TenantPrismaClient,
  input: SetupSessionInput
): Promise<SessionResult> {
  const stripeCustomerId = await ensureStripeCustomer(stripe, tp, input.customerId);

  const session = await stripe.checkout.sessions.create({
    mode: "setup",
    customer: stripeCustomerId,
    metadata: {
      tenantId: input.tenantId,
      customerId: input.customerId,
    },
    success_url: input.successUrl,
    cancel_url: input.cancelUrl,
  });

  return {
    stripeSessionId: session.id,
    url: session.url!,
    expiresAt: session.expires_at ? new Date(session.expires_at * 1000) : null,
  };
}
