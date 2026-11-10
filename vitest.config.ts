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

// Wave 1 (2026-11-06): webhook crash guard, central notifier, notification
// preferences/feed/push. New whole files, gated at 100%.
const WAVE1_FILES = [
  "src/lib/webhook-guard.ts",
  "src/lib/notification-prefs.ts",
  "src/services/notify.ts",
  "src/routes/notifications.ts",
  "src/mobile/services/notification.service.ts",
  "src/mobile/services/push.ts",
];

// Wave 2A (2026-11-06): working days + carryover, Google geocoding, bulk invoice
// send. New whole files, gated at 100%.
const WAVE2A_FILES = [
  "src/lib/working-days.ts",
  "src/services/carryover.service.ts",
  "src/services/property-geocoding.ts",
  "src/services/invoice-send-batch.service.ts",
  "src/jobs/geocodeBackfillCli.ts",
  "src/integrations/pdf/render.ts",
  "src/jobs/kpiThresholds.ts",
];

// Wave 2B-1 (2026-11-07): money correctness and security hardening. New whole files, gated at 100%.
// tenant-provisioning.ts and tenant-prisma-manager.ts changed (schema-name guard, failed-migration report) and have
// full test files, so they are gated too.
const WAVE2B1_FILES = [
  "src/lib/schema-name.ts",
  "src/lib/request-id.ts",
  "src/lib/outbound.ts",
  "src/lib/rate-limit.ts",
  "src/lib/permissions.ts",
  "src/lib/idempotency.ts",
  "src/lib/outbox-backoff.ts",
  "src/lib/tenant-provisioning.ts",
  "src/lib/tenant-prisma-manager.ts",
  "src/middleware/requireAdmin.ts",
  "src/services/payment-state.ts",
  "src/services/direct-debit.ts",
  "src/services/webhook-events.service.ts",
  "src/jobs/webhookRetry.ts",
  "src/jobs/overdueSweep.ts",
  "src/routes/integrations.ts",
  "src/server/shutdown.ts",
];

// Wave 2B-2 (2026-11-06): native tenant email (SES mailer, sender identity, branding, SNS events, sending domain).
// New whole files, gated at 100%.
const WAVE2B2_FILES = [
  "src/lib/mailer/config.ts",
  "src/lib/mailer/contrast.ts",
  "src/lib/mailer/sender.ts",
  "src/lib/mailer/template.ts",
  "src/lib/mailer/ses.ts",
  "src/lib/mailer/sns.ts",
  "src/services/email.service.ts",
  "src/services/email-events.service.ts",
  "src/services/email-domain.service.ts",
  "src/services/email-settings.service.ts",
  "src/routes/sesWebhook.ts",
  "src/routes/settings-email.ts",
  "src/jobs/emailDomainRecheck.ts",
  "src/lib/tenant-jobs.ts",
];

// Flo AI (2026-11-10): admin-only, read-only assistant. New whole files, gated at 100%. The orchestration, answer
// builder, stream parser, figure check, SSE writer, service and routes append their own files to this list.
const FLO_FILES = [
  "src/integrations/anthropic/client.ts",
  "src/jobs/floPurge.ts",
  "src/services/flo/types.ts",
  "src/services/flo/modes.ts",
  "src/services/flo/limits.ts",
  "src/services/flo/scope-gate.ts",
  "src/services/flo/declines.ts",
  "src/services/flo/prose-lint.ts",
  "src/services/flo/system-prompt.ts",
  "src/services/flo/tool-registry.ts",
  "src/services/flo/tools/shared.ts",
  "src/services/flo/tools/get-day-overview.ts",
  "src/services/flo/tools/list-rounds-due.ts",
  "src/services/flo/tools/list-debtors.ts",
  "src/services/flo/tools/list-payments.ts",
  "src/services/flo/tools/compare-technicians.ts",
  "src/services/flo/tools/list-complaints.ts",
  "src/services/flo/tools/list-at-risk-customers.ts",
  "src/services/flo/tools/revenue-summary.ts",
  "src/services/flo/tools/list-skipped-visits.ts",
  "src/services/flo/tools/get-customer-summary.ts",
  // B4-B6: answer contract and builders, stream parser, figure check, orchestrator, service, SSE writer, routes.
  "src/services/flo/answer.ts",
  "src/services/flo/stream-parser.ts",
  "src/services/flo/figure-check.ts",
  "src/services/flo/orchestrator.ts",
  "src/services/flo/flo.service.ts",
  "src/services/flo/sse.ts",
  "src/routes/flo.ts",
];

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    exclude: ["dist/**", "**/*.live.test.ts"],
    setupFiles: ["src/test/env.setup.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      include: [...PAYMENT_DOMAIN_FILES, ...AUDIT_REMEDIATION_FILES, ...GEOCODING_FILES, ...INVITE_FILES, ...PHASE1_AUDIT_FILES, ...WAVE1_FILES, ...WAVE2A_FILES, ...WAVE2B1_FILES, ...WAVE2B2_FILES, ...FLO_FILES],
      thresholds: {
        100: true,
        perFile: true,
      },
    },
  },
});
