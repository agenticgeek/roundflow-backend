import Stripe from "stripe";

export function getStripeClient(secretKey: string): Stripe {
  return new Stripe(secretKey, { apiVersion: "2026-08-26.dahlia" });
}
