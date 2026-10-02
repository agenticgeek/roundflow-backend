import type Stripe from "stripe";
import type { TenantPrismaClient } from "../../lib/tenant-prisma-manager";

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
