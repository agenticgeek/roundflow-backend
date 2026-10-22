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

// Files added/rewritten during the 2026-10 frontend-audit remediation that
// happened to land at genuine 100% coverage as whole files (no pre-existing
// untested legacy code to drag the ratio down) — gated to keep them there.
// Sibling files touched in the same pass (round.service.ts, rounds.ts,
// dashboard.service.ts, dashboard.ts, complaints.ts, customer.service.ts)
// were NOT added here: each mixes the new/changed code with a large amount
// of pre-existing, previously-untested legacy code, and gating the whole
// file would fail CI against debt this pass didn't introduce.
const AUDIT_REMEDIATION_FILES = [
  "src/services/reports.service.ts",
  "src/services/complaint.service.ts",
  "src/lib/csv.ts",
  "src/routes/service-plans.ts",
  "src/lib/tenant-defaults.ts",
];

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    exclude: ["dist/**", "**/*.live.test.ts"],
    setupFiles: ["src/test/env.setup.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      include: [...PAYMENT_DOMAIN_FILES, ...AUDIT_REMEDIATION_FILES],
      thresholds: {
        100: true,
        perFile: true,
      },
    },
  },
});
