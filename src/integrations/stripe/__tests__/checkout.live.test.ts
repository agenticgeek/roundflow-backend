// Opt-in smoke test against REAL Stripe test-mode APIs. Run via
// `npm run test:live`, never part of `npm test` / `npm run test:coverage`.
// Requires STRIPE_LIVE_TEST_SECRET_KEY (a real "sk_test_..." key from a
// Stripe test-mode account, or a Connect-connected test account's own key).
// Skips cleanly — not failing — when that env var isn't set.
import { describe, it, expect } from "vitest";
import { getStripeClient } from "../client";

const liveKey = process.env.STRIPE_LIVE_TEST_SECRET_KEY;

describe.skipIf(!liveKey)("Stripe Checkout (real test-mode API)", () => {
  it("creates a real test-mode Checkout Session", async () => {
    const stripe = getStripeClient(liveKey!);
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: [
        {
          quantity: 1,
          price_data: { currency: "gbp", unit_amount: 3500, product_data: { name: "RoundFlow live smoke test" } },
        },
      ],
      success_url: "https://example.com/success",
      cancel_url: "https://example.com/cancel",
    });

    expect(session.id).toMatch(/^cs_test_/);
    expect(session.url).toContain("checkout.stripe.com");
  });

  it("verifies a webhook signature it generated itself (no network call)", () => {
    const stripe = getStripeClient(liveKey!);
    const secret = "whsec_live_smoke_test_secret";
    const payload = JSON.stringify({ id: "evt_live_smoke", object: "event", type: "checkout.session.completed" });
    const header = stripe.webhooks.generateTestHeaderString({ payload, secret });

    const event = stripe.webhooks.constructEvent(payload, header, secret);

    expect(event.id).toBe("evt_live_smoke");
    expect(event.type).toBe("checkout.session.completed");
  });
});

describe.skipIf(!!liveKey)("Stripe Checkout (real test-mode API) — skipped", () => {
  it("is skipped because STRIPE_LIVE_TEST_SECRET_KEY is not set", () => {
    expect(liveKey).toBeUndefined();
  });
});
