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

// New, whole files added for property geocoding (2026-10-29) — no pre-existing
// untested legacy code to drag the ratio down, so gated at 100% like
// AUDIT_REMEDIATION_FILES above. The *callers* of these files
// (customer.service.ts, round.service.ts, visit.service.ts, the mobile
// services) mix this change into large, previously-untested files and are
// deliberately NOT added here, for the same reason AUDIT_REMEDIATION_FILES
// excludes round.service.ts/customer.service.ts. See
// docs/handoff/backend/2026-10-29-property-geocoding-handoff.md.
const GEOCODING_FILES = [
  "src/integrations/geocoding/client.ts",
  "src/jobs/geocodeBackfill.ts",
];

// Team invites (2026-10-30): send/list/cancel/resend/accept plus the Supabase
// email helper. Whole files, gated at 100%. POST /technicians (sendInvite)
// also uses src/lib/invites.ts but technicians.ts itself stays ungated — it is
// a larger, previously-untested file, like the callers excluded above.
const INVITE_FILES = [
  "src/routes/invites.ts",
  "src/lib/invites.ts",
  "src/lib/email.ts",
  "src/lib/app-error.ts",
];

// Phase 1 audit remediation (2026-10-30). New whole files — plus the few
// touched files that reached genuine 100% — gated per-file. Ungated touched
// files (customer.service.ts, round.service.ts, the big route files, …) are
// held to "every added/changed line covered" by `npm run test:diff-coverage`
// (scripts/diff-coverage.mjs) instead. See
// docs/handoff/backend/2026-10-30-phase1-audit-remediation-plan.md.
const PHASE1_AUDIT_FILES = [
  "src/lib/schedule.ts",
  "src/services/visit-assignment.ts",
  "src/jobs/backfills.ts",
  "src/jobs/visitGeneration.ts",
  "src/mobile/ownership.ts",
  "src/mobile/idempotency.ts",
  "src/mobile/media-urls.ts",
  "src/services/visit-completion.ts",
  "src/services/visit-photos.service.ts",
  "src/mobile/services/upsell.service.ts",
  "src/mobile/services/chat.service.ts",
  "src/lib/settings-dto.ts",
  "src/lib/settings-validators.ts",
  "src/lib/customer-match.ts",
  "src/lib/oauth-state.ts",
  "src/lib/env-check.ts",
  "src/lib/row-error.ts",
  "src/lib/signed-read-url.ts",
  "src/lib/error-handler.ts",
  "src/integrations/ghl/connection.ts",
  "src/services/activation-plan.ts",
  "src/jobs/preCleanReminders.ts",
  "src/jobs/kpiThresholds.ts",
  "src/jobs/idempotencyPurge.ts",
  "src/jobs/outboxWorker.ts",
  "src/services/customer-payment-status.ts",
  "src/services/service-plan-lifecycle.ts",
  "src/services/photo-gallery.service.ts",
  "src/services/technician-kpi.service.ts",
  "src/services/technician-incident.service.ts",
  "src/services/technician-availability.service.ts",
  "src/services/kpi-threshold.service.ts",
  "src/routes/kpi-thresholds.ts",
  "src/routes/technician-incidents.ts",
  "src/services/payment-hold.ts",
  "src/services/message-templates.ts",
  "src/services/message.service.ts",
  "src/services/payment.service.ts",
  "src/mobile/services/debt-gate.ts",
  "src/routes/messages.ts",
  "src/routes/ghlWebhook.ts",
  "src/routes/reports.ts",
  "src/server/bootstrap.ts",
  "src/swagger.ts",
];

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    exclude: ["dist/**", "**/*.live.test.ts"],
    setupFiles: ["src/test/env.setup.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      include: [...PAYMENT_DOMAIN_FILES, ...AUDIT_REMEDIATION_FILES, ...GEOCODING_FILES, ...INVITE_FILES, ...PHASE1_AUDIT_FILES],
      thresholds: {
        100: true,
        perFile: true,
      },
    },
  },
});
