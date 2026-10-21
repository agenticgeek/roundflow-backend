import { describe, it, expect } from "vitest";
import Stripe from "stripe";
import { getStripeClient } from "../client";

describe("getStripeClient", () => {
  it("returns a Stripe instance configured with the given secret key", () => {
    const stripe = getStripeClient("sk_test_abc123");
    expect(stripe).toBeInstanceOf(Stripe);
  });
});
