import { defineConfig } from "vitest/config";

// Payment-domain files that are entirely about money movement (Stripe/
// GoCardless integration, webhooks, invoicing, debt collection) are held to
// 100% line/branch/function/statement coverage, enforced per-file. Files
// that mix payment routes into a larger, mostly-unrelated feature (settings,
// customers, visits) are thoroughly tested but intentionally NOT included
// here — gating the whole file would force testing large amounts of
// unrelated, currently-untested code. See docs/handoff/backend for the full
// rationale.
const PAYMENT_DOMAIN_FILES = [
  "src/routes/payments.ts",
  "src/routes/stripeWebhook.ts",
  "src/routes/gocardlessWebhook.ts",
  "src/routes/invoices.ts",
  "src/routes/debt.ts",
  "src/integrations/stripe/client.ts",
  "src/integrations/stripe/checkout.ts",
  "src/integrations/stripe/oauth.ts",
  "src/integrations/gocardless/client.ts",
  "src/integrations/gocardless/mandate.ts",
  "src/integrations/gocardless/payment.ts",
  "src/services/invoice.service.ts",
  "src/services/debt.service.ts",
  "src/lib/crypto.ts",
];

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    exclude: ["dist/**", "**/*.live.test.ts"],
    setupFiles: ["src/test/env.setup.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      include: PAYMENT_DOMAIN_FILES,
      thresholds: {
        100: true,
        perFile: true,
      },
    },
  },
});
