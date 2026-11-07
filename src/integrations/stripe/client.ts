import Stripe from "stripe";

// BE-09: bounded Stripe calls (the SDK default is 80 s).
export const STRIPE_TIMEOUT_MS = 20_000;

export function getStripeClient(secretKey: string): Stripe {
  return new Stripe(secretKey, { apiVersion: "2026-08-26.dahlia", timeout: STRIPE_TIMEOUT_MS, maxNetworkRetries: 1 });
}
