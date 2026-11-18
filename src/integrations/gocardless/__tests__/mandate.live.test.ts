// Opt-in smoke test against the REAL GoCardless sandbox API. Run via
// `npm run test:live`, never part of `npm test` / `npm run test:coverage`.
// Requires GOCARDLESS_SANDBOX_ACCESS_TOKEN (a real sandbox access token).
// Skips cleanly — not failing — when that env var isn't set.
import { describe, it, expect } from "vitest";
import { getGcClient } from "../client";
import { createMandateSetupLink } from "../mandate";

const sandboxToken = process.env.GOCARDLESS_SANDBOX_ACCESS_TOKEN;

describe.skipIf(!sandboxToken)("GoCardless Direct Debit setup link (real sandbox API)", () => {
  it("creates a real sandbox billing request flow", async () => {
    const client = getGcClient(sandboxToken!, "sandbox");

    const result = await createMandateSetupLink(
      client,
      { id: `roundflow-live-smoke-${Date.now()}`, name: "Smoke Test", email: "smoke@example.com" },
      "RoundFlow live smoke test",
    );

    expect(result.billingRequestId).toMatch(/^BRQ/);
    expect(result.url).toContain("gocardless.com");
  });
});

describe.skipIf(!!sandboxToken)("GoCardless Direct Debit setup link (real sandbox API) — skipped", () => {
  it("is skipped because GOCARDLESS_SANDBOX_ACCESS_TOKEN is not set", () => {
    expect(sandboxToken).toBeUndefined();
  });
});
