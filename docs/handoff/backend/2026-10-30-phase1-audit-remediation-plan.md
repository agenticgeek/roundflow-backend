# RoundFlow Backend: Phase 1 Audit Remediation Plan

**Date:** 2026-10-30
**Repo:** roundflow-backend
**Source:** Agentum AI Phase 1 Completion Audit (36 gaps), checked line by line against this repo.
**Companion docs:**
- Frontend API handoff: `docs/handoff/frontend/2026-10-30-phase1-audit-frontend-handoff.md`
- Frontend plan: `roundflow-frontend/docs/2026-10-30-phase1-audit-remediation-plan.md`
- Mobile app plan: `roundflow-app/docs/2026-10-30-phase1-audit-remediation-plan.md`

---

## 0. Summary

The audit was run from the browser against the published OpenAPI spec. That spec was missing 50 routes, including the whole `/mobile/*` API. So some findings are wrong (GAP-015 "no mobile API", GAP-033 "single tenant"). Others point at the wrong layer (GAP-004 and GAP-027 are frontend wiring).

Checking the code also found **two blockers the audit did not report**. They come first in this plan:

| # | Finding | Evidence | Effect |
|---|---|---|---|
| **X-1** | Generated visits never get a `technicianId` | `src/jobs/visitGeneration.ts:95-107`, `src/services/setup.service.ts:1129-1138`. `round.service.ts:288-332` (`setTechnicians`) only writes `RoundTechnician`. | Technician app shows no jobs (`mobile/services/home.service.ts` filters on `visit.technicianId`). Today's Work shows no technician. Reassign is disabled (GAP-013). Split doesn't work (GAP-012). |
| **X-2** | Setup service plans never get a `nextDueDate` | `setup.service.ts:713-720` and bulk create at `:853-862` don't set it. Activation never sets it. The nightly job skips null (`visitGeneration.ts:72,81`). | Recurrence stops after the activation window. "Next Due" shows "—" (GAP-021). |

**Swagger:** `src/swagger.ts` is being brought up to date in the same pass (all 50 missing routes, the stale "single-tenant" and "Phase-1 stub" text, and the generic `/settings/payment/{provider}/connect` replaced with the real routes). Every endpoint this plan adds or changes must update `swagger.ts` in the same PR (see §6).

---

## Implementation status (2026-10-30)

Everything below is implemented in the working tree (uncommitted). No shared environment has been migrated or backfilled yet. The migrations have only run on the local regression database, and only Stripe test mode has been exercised (see Verification). The frontend contracts as built are in the companion frontend handoff (Part 4 lists the differences from this plan).

**Done**

| Workstream | Status |
|---|---|
| A1 technician stamping, split, allocation, reassign | Done. `PUT /rounds/:id/technicians` (split + `?dryRun`), `GET /rounds/:id/allocation`, reassign from unassigned, `Visit.technicianOverride`. |
| A2 nextDueDate + activation | Done. `GET /setup/step/11/preview` and step 11 share one planner (`activation-plan.ts`). |
| A3 payment hold | Done. Hold/release stamps visits (`visitsUpdated`); auto-release on payment; ON_HOLD board lists every held customer. |
| A4 pause | Done. `VisitStatus.CANCELLED` + `cancelReason`. One pause/resume implementation (`service-plan-lifecycle.ts`), also used by the nightly job. |
| A5 messaging | Done. GHL delivery for payment link, remind, invoice send and `/messages/send`. GHL message id stored in `Message.externalId`. `ghl/status`, `ghl/test`, public GHL callback with signed state. |
| A6 Stripe/GoCardless connect | Done. Authorize returns JSON, callbacks return JSON on `Accept: application/json`, `FIELD_REMOVED` on step 2, startup env check. |
| A7 mark paid | Done. `POST /invoices/:id/mark-paid`; `Payment.reference` stores the reference and mobile cheque numbers. |
| A8 mobile hardening | Done. TECHNICIAN guard + ownership codes, shared transactional completion, `X-Idempotency-Key` (7-day TTL, purged nightly), chat `isMine`, upsells. |
| B1–B6, B8 | Done (B7 PayPal out of scope). Pre-clean reminders run every 15 min behind `PRECLEAN_REMINDERS_ENABLED`. KPI threshold check runs nightly. |
| Phase C/D | Done except GAP-007 (deferred, no schema change) and GAP-023 (web only, no `planner/stops` endpoint). |
| Follow-ups | `Customer.messagesOptOut` (PATCH `/customers/:id`; skipped by reminders and visit-completed messages). Outbox handlers `message.send` and `message.visit_completed` ("Visit completed" template). `Round.defaultServiceId` in the invoice line-text fallback. `PATCH /properties/:id` frequency changes reuse the B3 move. "Invoice Ready" copy fixed. |
| GAP-005 | `app.listen` before migrations; `/health` 503 `migrating`; `/health/ready`. A migration failure still exits 1. |
| Error handler | `src/lib/error-handler.ts` forwards extra `AppError` fields generically; the hand-rolled handlers in rounds/service-plans were removed. |
| Mobile contract follow-ups | Done (see `docs/Handoffs/MOBILE_API_HANDOFF.md`). Access-issue photos: `PhotoType.ACCESS_ISSUE`, `Photo.issueId`, and `photoPaths` on `POST /mobile/visits/:id/access-issues`. Signed read URLs (1 h) for the avatar (`avatarSignedUrl`), chat photos (`photoSignedUrls`) and visit photos (`signedUrl`), in `src/mobile/media-urls.ts` and `src/lib/signed-read-url.ts`. `code: "NO_PROFILE"` on the 403 from `requireTenantAccess`. `startedAt`/`arrivedAt`/`completedAt` on `/mobile/visits/today`. Effective `paymentMethod` (visit → plan → customer) on the visit detail. |
| Stripe Connect errors | A code Stripe rejects (bad, used or expired: `invalid_grant`) is now `400 STRIPE_CONNECT_FAILED` with Stripe's reason; a Stripe 5xx is `502 STRIPE_UNAVAILABLE` (`src/integrations/stripe/oauth.ts`). Both were 500s (D-11). |

**Deviations from the plan**

- No endpoint sets `Round.defaultServiceId` yet.
- `GET /settings/ghl/status` `connectedAt` is always null (not stored).
- `/settings/stripe/callback` stays bearer-authenticated and doesn't validate `state`. Only the GHL callback is public with signed state.
- Outbox message rows drain only for GHL-connected tenants. Until GHL is connected they stay pending.
- GAP-005: migrations still run in-process at startup (not moved to a Dockerfile/Railway release step), and per-request timing logs were not added.
- `src/lib/storage-read.ts` was merged into `src/lib/signed-read-url.ts`.
- Startup and cron wiring moved to `src/server/bootstrap.ts`, so `src/index.ts` is thin. Swagger paths are ordered literal-first so the 405 pre-filter can't block `/invoices/bulk`-style routes.

**New gates and tooling**

- `PHASE1_AUDIT_FILES` in `vitest.config.ts`: new files gated at 100% per file, including `bootstrap.ts`, `outboxWorker.ts` and `swagger.ts`.
- `npm run test:diff-coverage` (`scripts/diff-coverage.mjs`): fails if any added or changed line in `src/` is uncovered. It diffs against `HEAD` plus untracked files locally, and against `origin/main...HEAD` when `CI` is set (or `DIFF_BASE`).
- `src/__tests__/swagger.contract.test.ts`: registered routes match `openApiDocument.paths` both ways, and the 405 pre-filter blocks no served method.

**Migrations to apply** (applied automatically at startup by `migrateAllTenantSchemas`):
- `prisma/tenant/migrations/20261030000000_phase1_audit_remediation`
- `prisma/tenant/migrations/20261030010000_phase1_followups`
- `prisma/tenant/migrations/20261030020000_access_issue_photos` (additive: the `ACCESS_ISSUE` enum value and the nullable `Photo.issueId`)

**Backfills to run** after the migrations, per environment, `--dry-run` first:
`npx tsx scripts/backfill-next-due-date.ts`, `npx tsx scripts/backfill-visit-technicians.ts`, `npx tsx scripts/backfill-completed-steps.ts`.

**Verification (2026-10-30)**

| Check | Result |
|---|---|
| Backend unit and route tests | 102 files, 1,604 tests; every per-file 100% gate green; `tsc` and `npm run build` clean |
| Diff coverage | All 11,445 changed lines across 79 files covered |
| Swagger contract | Routes ⇄ spec parity and the 405 pre-filter, both directions |
| Web (`roundflow-frontend`) | 297 tests, per-file 100% gates and diff coverage green |
| Technician app (`roundflow-app`) | 168 tests at 100% coverage; `expo export` bundles |
| Regression suite (`roundflow-e2e`) | 32 of 36 gaps **FIXED**, 2 out of scope (GAP-006 PayPal, GAP-007 multi-method), 2 skipped (GAP-017, GAP-034: GHL keys not configured for this run) |

The regression suite runs the real backend and web against a **local Docker Postgres** (`roundflow-e2e`, `npm run stack:up`). It never reads the database URL from `roundflow-backend/.env` and refuses to start against a non-local database. Supabase is used for sign-in only; Stripe ran in test mode. Evidence (gap register CSV and screenshots) is written to `roundflow-e2e/reports/`.

**Remaining**

- Live sandbox runs for GHL (OAuth and private key) and GoCardless, and a real Stripe Connect code exchange (`E2E_STRIPE_OAUTH_CODE`). Stripe test-mode webhook and callback guards are covered by the regression suite.
- Backfill runs on api-dev (diff visit counts), then prod.
- Deploy env vars:
  - Backend: `PRECLEAN_REMINDERS_ENABLED=true` (when the tenant is ready), `STRIPE_SECRET_KEY`, `STRIPE_CLIENT_ID`, `STRIPE_CONNECT_WEBHOOK_SECRET`, `GHL_CLIENT_ID`, `GHL_CLIENT_SECRET`, `ENCRYPTION_KEY`, `PUBLIC_API_URL`, `FRONTEND_URL` (the startup log lists any that are missing).
  - Web: `VITE_STRIPE_CONNECT_CLIENT_ID`.
  - Register the redirect URIs in Stripe Connect and the GHL app.
- Frontend and mobile wiring of the breaking changes (frontend handoff Part 3) is done in the working trees; ship it with, or before, this deploy.

**Follow-ups (not blocking)**

- **Releasing a hold without an invoice.** Hold is per invoice (`PATCH /debt/:invoiceId/hold`), but the ON_HOLD bucket lists held customers who may have no SENT invoice. The board can't release those, so the web disables the action. This needs a customer-level hold endpoint (e.g. `PATCH /customers/:id/hold`).
- An endpoint to set `Round.defaultServiceId`; store `connectedAt` for GHL; validate `state` on `/settings/stripe/callback`.
- Move tenant migrations to a release step (GAP-005).
- Admin photo rows don't carry `issueId`, so the web can't group access-issue photos by report yet.

---

## 1. Test coverage rule (applies to every work item)

**Target: 100% line, branch, function and statement coverage on all code this plan creates or changes.**

This follows the convention already in `vitest.config.ts` (per-file 100% gates for payment, audit, geocoding and invite files):

1. **New files** go into a new `PHASE1_AUDIT_FILES` array in `vitest.config.ts`. They are gated at `100: true, perFile: true` like the existing lists. Put new logic in small new modules wherever possible (e.g. `src/services/visit-assignment.ts`) rather than growing legacy files. That keeps whole-file gating practical.
2. **Changed lines in legacy files** that are not whole-file gated (`setup.service.ts`, `customer.service.ts`, `round.service.ts`, `settings.ts`, `technicians.ts`, `mobile/routes.ts` …) get a **diff-coverage gate**: a CI step that runs `vitest run --coverage --coverage.include=<changed files>`, then fails if any added or modified line in `git diff origin/main...HEAD` is uncovered. Add a script `scripts/diff-coverage.mjs` (parse `coverage/lcov.info` and the git diff hunks) plus `npm run test:diff-coverage`, and wire it into CI.
3. If a legacy file reaches 100% as a side effect, move it into the gated list.
4. **Test layers per item:**
   - Service unit tests with a mocked Prisma (pattern: `src/services/__tests__/*.service.test.ts`).
   - Route tests with supertest for status codes, validation, roles and the 405 pre-filter (pattern: `src/routes/__tests__/*.route.test.ts`).
   - Job tests (`src/jobs/__tests__`).
   - A `*.live.test.ts` for each third-party integration change (GHL, Stripe, GoCardless), run with `npm run test:live` against sandboxes. Live tests don't count toward coverage but are required before sign-off.
5. **Migrations:** each tenant migration gets a test that runs `provisionTenantSchema` followed by `migrateAllTenantSchemas` on a throwaway schema in the live config. Every backfill script gets unit tests.
6. **Swagger contract test** (new, gated): `src/__tests__/swagger.contract.test.ts` loads the Express app's router stack and fails if any registered route is missing from `openApiDocument.paths`, or any documented path/method has no route. It also asserts the 405 pre-filter never blocks a registered method. This makes swagger drift a failing test instead of an audit finding.

**Definition of done for every item:** code, tests at 100% on the touched scope, swagger updated, frontend handoff section true, `npm test`, `npm run test:coverage` and `npx tsc --noEmit` all green.

---

## 2. Work items

Effort is backend hours, excluding QA. IDs map to the audit (GAP-xxx) or the new findings (X-x).

### Phase A: Blockers and foundations (must ship first; Today's Work, completion and invoicing depend on them)

#### A1. Stamp technicians on visits and split properties (X-1, GAP-012, GAP-013) · 10h
- **Schema (tenant migration):** `Property.assignedTechnicianId String?` (FK Technician, `onDelete: SetNull`). This is the per-property allocation within a round.
- **New module `src/services/visit-assignment.ts`** (gated 100%):
  - `resolveTechnicianForVisit({ property, roundTechnicianIds })`: if the property has an `assignedTechnicianId` still in the round's technicians, use it. Otherwise, if the round has exactly one technician, use that one. Otherwise return null.
  - `autoSplit(properties, technicianIds)`: deterministic balanced split. Sort by postcode, then street, then house number, and cut into contiguous chunks so each technician gets whole streets.
  - `restampFutureVisits(tp, roundId)`: set `technicianId` on all `SCHEDULED` visits dated today or later, using `resolveTechnicianForVisit`.
- **`PUT /rounds/:id/technicians`** accepts `{ technicianIds, split?: { mode: "SINGLE" | "AUTO" | "MANUAL", allocations?: [{ propertyId, technicianId }] } }`.
  - `SINGLE` requires exactly 1 id.
  - `AUTO` runs `autoSplit`.
  - `MANUAL` validates that each property is in the round and each technician is in `technicianIds`, and returns 400 listing any invalid entries.
  - It writes `RoundTechnician` and `Property.assignedTechnicianId` and calls `restampFutureVisits` in one transaction.
  - It returns the allocation summary per technician.
  - Keep the pending-invite 400. It is correct, and the web must show it (GAP-011, web-only).
- **Generation:** `visitGeneration.ts`, `POST /rounds/:id/generate-visits` and `activateSystem` set `technicianId` through `resolveTechnicianForVisit`.
- **New `GET /rounds/:id/allocation`:** current allocation, used to show the split screen.
- **Reassign (GAP-013):** `POST /rounds/:id/reassign` must accept `fromTechnicianId: null` (unassigned visits). With `scope: "REMAINING"` it updates SCHEDULED visits for the date. It also updates `Property.assignedTechnicianId` when `permanent: true`.
- **Backfill script `scripts/backfill-visit-technicians.ts`:** per tenant, restamp the future visits of every round.
- **Tests:**
  - Every `resolveTechnicianForVisit` branch (assigned and in round, assigned but removed, single tech, multiple techs with no allocation).
  - `autoSplit` with 1, 2 and 3 technicians, uneven streets, and an empty list.
  - MANUAL validation errors.
  - The transaction rolls back when restamping fails.
  - Generation stamps the technician.
  - Reassign from null.
  - Route 400s and 403 for TECHNICIAN.

#### A2. `nextDueDate` and activation window (X-2, GAP-016, GAP-021 part) · 5h
- Setup step 9 (single and bulk) and `POST /customers/:id/properties` set `nextDueDate`:
  - If `lastCleanedDate` is given: last cleaned + plan frequency, snapped to the round day.
  - Otherwise: the round's next `defaultDay` on or after today.
- `activateSystem`:
  - Loop with `visitDate < cycleEndDate` (exclusive end; that is the GAP-016 count mismatch).
  - After creating visits, set each plan's `nextDueDate` to the first occurrence after the last generated visit, so the nightly job continues the series.
- **New `GET /setup/step/11/preview?startDate&cycleWeeks`:** returns `{ rounds: [{ roundId, firstVisit, visits }], total }`, computed by the same function the activation uses. Share the function so preview and activation can't drift.
- **Backfill script `scripts/backfill-next-due-date.ts`:** for plans with a null `nextDueDate` and an ACTIVE status, set it to the date after the latest existing visit, or to the next round day.
- **Tests:**
  - The date maths across frequencies, weekday snapping, `lastCleanedDate` in the past and the future, and no `defaultDay`.
  - Preview count equals activation count (property test over random rounds).
  - The backfill is idempotent.

#### A3. Payment hold actually holds (GAP-026) · 6h
- `debt.service.flagHold(flag=true)`:
  - Set `Customer.holdNextClean`.
  - Set `paymentHold=true` on the customer's next `SCHEDULED` visit on each ACTIVE property.
  - With `flag=false`, clear both.
  - When an invoice becomes PAID (in `payment.service.applyOutcome`, the Stripe/GC webhooks and mark-paid) and the customer has no other unpaid invoices, clear the hold automatically if `BusinessSettings.debtHoldEnabled` is on.
- Generation sets `paymentHold` from `customer.holdNextClean`.
- `mobile/services/debt-gate.ts` treats `holdNextClean` as blocking.
- Debt KPIs and board counts: `holdNextClean` and the `ON_HOLD` tab count customers with `holdNextClean=true`, whatever their invoice status (today they only count `SENT` invoices).
- **Tests:** flag on and off; a customer with no future visit; multiple properties; auto-release on paid with and without other open invoices; KPI counts; the debt gate blocks.

#### A4. Paused properties excluded (GAP-020) · 5h
- **Schema:** add `VisitStatus.CANCELLED` and `Visit.cancelReason String?`.
- **Pause** (`pauseServicePlan` and `pauseService`):
  - Mark `SCHEDULED` visits inside `[pauseStartDate, pauseEndDate]` as `CANCELLED` with reason `PAUSED`. An open-ended pause covers all future visits.
  - A pause start date in the future keeps the plan `ACTIVE` with `pauseStartDate` set. The nightly job flips it to `PAUSED` on that date.
- **Resume**, manual or from the new nightly step at `pauseEndDate`:
  - Set the plan to `ACTIVE`.
  - Recompute `nextDueDate` to the first round day on or after the resume date.
  - Do not resurrect cancelled visits.
- Every reader of visit lists must exclude `CANCELLED` by default: planner, today, debt, reports, mobile. Grep for `VisitStatus.` and `status: {` on visits.
- **Tests:** pause windows that are inside, partly overlapping and open-ended; a future start; auto-resume; readers excluding CANCELLED; reports unaffected.

#### A5. Real message delivery for payment links, reminders and invoices (GAP-034, GAP-017 backend part) · 12h
- `debt.service.sendPaymentLink`, `sendReminder` and `invoice.service.sendInvoice` all go through `createMessageService.send` with `channel: "SMS" | "EMAIL" | "WHATSAPP"`. The default is `SMS` when the customer has a mobile, otherwise `EMAIL`.
  - The customer email is required only for EMAIL.
  - The `Message` row is written only after GHL accepts the message, with `externalId` set.
  - GHL errors map to 502, with `code: "GHL_SEND_FAILED"`.
- **Payment link:**
  - Create a real Stripe Checkout or Payment Link through `integrations/stripe/checkout.ts` on the tenant's connected account.
  - **Remove the static `pay.roundflow.app` fallback.**
  - If Stripe is not connected, return 409 `code: "STRIPE_NOT_CONNECTED"`.
- Templates: payment link and invoice messages use the tenant's message templates (`settings/message-templates`) with variable substitution. Unknown variables render as empty, never as `{{x}}`.
- **GHL connection:**
  - Make `GET /settings/ghl/callback` public, with tenant and profile resolved from a signed, expiring `state` (HMAC with `lib/crypto.ts`, 10 min TTL).
  - Make `GET /settings/ghl/authorize` return JSON `{ url }` so the web can call it with the bearer header.
  - Add `GET /settings/ghl/status` → `{ connected, method: "oauth" | "private" | null, locationId, locationName, webhookUrl, connectedAt }`.
  - Add `POST /settings/ghl/test` → calls GHL `/locations/:id` with the stored token and returns `{ ok, locationName }`, or 502 with GHL's message.
  - Remove `assertSetupComplete` from the GHL routes so messaging can be connected during the wizard.
- Visit completed message: `PATCH /mobile/visits/:id/complete` and `PATCH /visits/:id/complete` queue the "Visit completed" template through the outbox, skipping customers who opted out.
- **Tests:** each channel; no-mobile and no-email paths; a GHL 4xx/5xx; a template with missing variables; state signature valid, expired and tampered; status/test; Stripe not connected. Add a live test against the GHL sandbox location.

#### A6. Stripe and GoCardless connect that works end to end (GAP-036) · 10h
- **Stripe: done from the web on 2026-10-30.** The web now builds the Stripe consent URL itself (public `client_id` plus a sessionStorage `state`) and registers `<web origin>/settings/stripe/callback` as the redirect URI. That page calls `GET /settings/stripe/callback?code&state` with the bearer header and `redirect: 'manual'`. **The callback stays behind `requireAuth`**, and no token is ever in a URL. Backend follow-ups:
  - The success response is a 302 the web ignores. Optionally return `200 { status: "connected" }` when `Accept: application/json`.
  - `GET /settings/stripe/authorize` is now unused by the web. Delete it or keep it for API clients.
  - Ops: register both redirect URIs (prod and localhost) in Stripe → Connect → Settings, and set `VITE_STRIPE_CONNECT_CLIENT_ID` (= `STRIPE_CLIENT_ID`) on Vercel.
  - **GHL OAuth** still has the old shape. Apply the same pattern (web-built URL, web callback page calling `/settings/ghl/callback` with the header).
- Remove `assertSetupComplete` from the Stripe and GoCardless connect, disconnect and status routes, so the wizard's "Connect" buttons work.
- **Remove the raw `gocardlessConnected` / `stripeConnected` booleans from `POST /setup/step/2`.** Connection state can only change through real connect flows. Return 400 if they are sent, `code: "FIELD_REMOVED"`, during one release, then strip them.
- **Webhooks:**
  - `POST /webhooks/stripe` with the secret unset returns 503 `code: "WEBHOOK_NOT_CONFIGURED"` and logs an error, instead of a 500.
  - A DB error while recording the event returns 500, so Stripe retries. Keep that.
  - Add a startup check that logs a warning listing missing `STRIPE_*` and `GOCARDLESS_*` env vars.
- **Env:** set `STRIPE_CONNECT_WEBHOOK_SECRET` (and verify the GoCardless webhook secret) on api-dev and prod. Add it to the deploy checklist in `docs/handoff/backend/2026-10-22-payments-hardening-handoff.md`.
- **Tests:** the authorize JSON; the callback with a valid, expired or tampered state; connect allowed before setup completes; the step-2 boolean rejection; webhook 503 with no secret. Live: Stripe test-mode Connect onboarding and a GoCardless sandbox mandate and payment, as part of the required sign-off run.

#### A7. Mark invoice paid manually (GAP-027) · 4h
- **New `POST /invoices/:id/mark-paid`** `{ method: "BACS" | "CHEQUE" | "CASH", reference?: string, paidAt?: ISO date, amount?: number }`:
  - Creates or updates the visit's `Payment` row (status `PAID`).
  - Sets the invoice to `PAID` with `paidAt`.
  - Writes an activity log entry.
  - Runs the A3 auto-release.
  - Returns 409 if already PAID or VOID, and 400 if `amount` differs from the invoice total (no part payments in Phase 1).
- Keep `PATCH /payments/:id/status` as is.
- **Tests:** each method; already paid; void; amount mismatch; creating a payment row when none exists; the activity log; the role check.

#### A8. Harden the mobile job actions (GAP-015 backend part) · 6h
The routes exist. These are the changes:
- **Ownership:** every `/mobile/visits/:id/*` action checks `visit.technicianId === me.technicianId`, otherwise 403 `code: "NOT_YOUR_VISIT"` (today `job-tracker.service.ts:9` ignores the technician). This depends on A1.
- **`PATCH /mobile/visits/:id/complete`** accepts `payment?: { method: "CASH" | "CHEQUE" | "NONE", amount?: number, chequeNumber?: string }`:
  - CASH or CHEQUE create a `PAID` (cash) or `PENDING` (cheque, cleared by mark-paid) Payment.
  - It replaces the cash-only `cashConfirmed` flag. Keep `cashConfirmed` as a deprecated alias for one release.
- **`POST /mobile/visits/:id/debt-payment`** accepts `method: "CASH" | "CHEQUE"`.
- **Idempotency for offline replay:** all `/mobile/visits/:id/*` writes accept an `X-Idempotency-Key` header. Add a new `IdempotencyRecord { key, technicianId, route, responseStatus, responseBody, createdAt }` table with a 7-day TTL purge in the nightly job. A repeated key returns the stored response without re-executing. The app queues actions while offline (app plan, Phase 4). New middleware `src/mobile/idempotency.ts`, gated at 100%.
- **Documentation:** the mobile handoff (`docs/Handoffs/MOBILE_API_HANDOFF.md`) says to send `x-tenant-id` and uses a localhost base URL. Both are stale; the tenant comes from the profile. Update it.
- Remove `/mobile` from the "not in OpenAPI" list (done in the swagger pass).
- **Tests:** an ownership 403 on every action; each payment method; the deprecated alias; debt-payment with a cheque; an idempotent replay returning the stored response; a key reused by a different technician (403); TTL purge.

### Phase B: High

#### B1. Business profile address, postcode, VAT rate (GAP-001) · 4h
- `BusinessSettings` gets `addressLine1`, `addressLine2`, `town`, `postcode` and `vatRate Decimal(5,2) @default(20)`.
- Accept them in `POST /setup/step/1` and `PATCH /settings/business-profile`, and return them from both GETs.
- Invoice VAT uses `vatRate` instead of the hardcoded 20 (`invoice.service.ts`).
- The invoice PDF header shows the address.
- **Tests:** round trip; VAT at 0, 5 and 20; PDF header snapshot.

#### B2. Pre-clean reminder, clean method, auto next visit (GAP-003) · 6h
- `BusinessSettings` gets:
  - `reminderMode` enum `EVENING_BEFORE | MORNING_OF | NONE`
  - `reminderTime` (`HH:mm`, default `19:00`)
  - `defaultCleanMethod` enum `TRADITIONAL | WATER_FED_POLE | BOTH`
  - `autoCreateNextVisit Boolean @default(true)`
- Deprecate `preCleanReminderTimings`, mapping old values on read.
- Accept the new fields in `POST /setup/step/4` and `PATCH /settings/round-settings`.
- **New job `src/jobs/preCleanReminders.ts`** (every 15 min):
  - For tenants whose local time has reached `reminderTime`, queue the "Pre-clean reminder" template through the outbox. That is visits tomorrow for `EVENING_BEFORE` and today for `MORNING_OF`.
  - It is idempotent per visit, using `Visit.reminderSentAt`.
- Retire the GHL-workflow reminder driven by `next_clean_date`, or keep it as a fallback only when the tenant has none set. Decide with the GHL owner (see `GHL_AUTOMATION_OWNER_HANDOFF.md`).
- `autoCreateNextVisit=false`: the nightly job skips the tenant.
- **Tests:** each mode; timezone (Europe/London across the BST change); idempotency; opted-out customers; the skip.

#### B3. Frequency change moves the property to a matching round (GAP-018) · 6h
- `PATCH /service-plans/:id` with a new `cleaningFrequency`, when it differs from the round's frequency:
  - Look for an ACTIVE round in the same service area with that frequency, preferring the same `defaultDay`.
  - If found, move the property (`roundId`), cancel its future SCHEDULED visits in the old round, and set `nextDueDate`.
  - If none exists and `createRoundIfMissing: true`, create `"<Area> <Day> <N>wk"`, copying day and technicians.
  - If none exists and the flag is false, return 409 `code: "NO_MATCHING_ROUND"` with suggestions.
- The response includes `{ servicePlan, movedToRound: { id, name, created } | null }`.
- **Tests:** match found; created; 409; same frequency is a no-op; visits cancelled and regenerated.

#### B4. Before/after photos visible to admin (GAP-019) · 5h
- `Photo.propertyId` is set on upload (`media.service.ts`); backfill from `visit.propertyId`.
- **New `GET /visits/:id/photos` and `GET /properties/:id/photos?type=BEFORE|AFTER|PROPERTY&page`:** signed read URLs (`lib/storage.ts`, 1 h TTL), `takenAt`, technician name, visit date.
- **New `GET /technicians/:id/photos`** for the technician detail gallery.
- **Tests:** signed-URL generation (mocked storage); filters; pagination; tenant isolation; role checks.

#### B5. Bulk "Create invoices for today" (GAP-014) · 6h
- **`POST /invoices/bulk/preview`** `{ date, excludeVisitIds?: string[] }` → `{ items: [{ visitId, customerName, address, amount, vat, total, paymentMethod }], skipped: [{ visitId, reason: "ALREADY_INVOICED" | "NOT_COMPLETED" | "ON_HOLD" }], totals: { count, amount } }`.
- **`POST /invoices/bulk`** with the same body creates invoices in one transaction (or per-item with partial-failure reporting; choose per-item) → `{ created: [{ visitId, invoiceId, invoiceNumber, total }], failed: [{ visitId, error }], totals }`. `sendNow?: boolean` triggers A5 sending per invoice.
- Invoice numbering must stay sequential under concurrency: lock the per-year counter row, or use `SELECT … FOR UPDATE`.
- **Tests:** preview vs create parity; exclusions; skip reasons; concurrent numbering (two parallel bulk calls); partial failure.

#### B6. Technician KPIs: compute and record (GAP-025) · 14h
- **Computed:**
  - `timeOnJobMinutes` = Σ(`completedAt − startedAt`) for completed visits in the period.
  - `revenuePerHour` = completed value ÷ hours on job.
  - Both null only when there is no data.
- **Schema:** `TechnicianIncident { id, technicianId, visitId?, type: STRIKE | DAMAGE | UPSELL, amount Decimal?, note, createdById, createdAt }`.
- **Routes:**
  - `POST /technicians/:id/incidents`, `GET /technicians/:id/incidents?type&from&to` and `DELETE /technician-incidents/:id` (ADMIN/MANAGER).
  - `POST /mobile/visits/:id/upsells` `{ description, amount }` (the technician records an upsell on the job).
  - Complaints with `technicianId` count as strikes when the complaint is resolved as upheld. That needs an `upheld` boolean on resolve.
- **Thresholds:** `KpiThreshold { metric, operator: LT | GT, value }` with `GET/PUT /settings/kpi-thresholds`. When a threshold is crossed, the nightly check adds a dashboard alert (`/dashboard/alerts`) and a notification for ADMINs.
- **Tests:** KPI maths incl. zero hours; CRUD; role checks; threshold evaluation for each operator; alert de-duplication.

#### B7. PayPal (GAP-006): **out of scope** (decided 2026-10-30, not needed). Reply to the audit that PayPal is not a Phase 1 requirement.

#### B8. Schema-per-tenant (GAP-033) · 0.5h
Already implemented (each signup provisions `t_<hex>`). Done in the swagger pass. Also fix the stale "PHASE 2 TENANT SEAM" comment at `setup.service.ts:198-219`. Reply to the audit with the evidence.

### Phase C: Medium

| ID | Change | Endpoints / schema | h |
|---|---|---|---|
| **GAP-008** Payment defaults | `BusinessSettings.defaultPaymentMethod`, `invoiceDueDays Int @default(7)`, `noDirectDebitAction` enum `SEND_INVOICE` / `SEND_PAYMENT_LINK`. Accept on step 2 and `/settings/payment`. Fix `COLLECT_ON_DATE` vs "once a day": add `COLLECT_DAILY_BATCH` to `PaymentRule`. New properties default to `defaultPaymentMethod`. | step 2, settings | 4 |
| **GAP-010** One client, many properties | Step 9 (single and bulk) accepts an optional `customerId`. Without it, match an existing customer by normalised mobile **or** email (case-insensitive). Response includes `customerMatched: boolean`. **New `GET /customers/search?q=`** for the picker (name, mobile, email, postcode; top 10). | step 9, customers | 5 |
| **GAP-021** Payment status / due / next due | `paymentStatus` comes from invoices: `NONE` when none, `UNPAID` / `OVERDUE` from unpaid SENT invoices, `PAID` when all paid. `amountDue` = unpaid invoice totals. `nextDue` falls back to the next open visit date (A2 fixes the root cause). | customers list/detail | 3 |
| **GAP-028** Invoice list + export | **`GET /invoices?status&from&to&customerId&q&page&pageSize`**, **`GET /payments?…`**, **`GET /invoices/export.csv`** and **`GET /payments/export.csv`** (reuse `lib/csv.ts`). | invoices, payments | 5 |
| **GAP-029** Revisit + attribution | `schedule-revisit` creates a one-off visit (`isOneOff`, `complaintId` FK) on the property's round for that date, with the complaint's technician, or the round's for that property. Response includes `visitId`. `resolvedBy` becomes `{ id, name }` (join the profile). Allow `technicianId` of pending-invite technicians on complaints (attribution doesn't need app access). | complaints | 4 |
| **GAP-030** Technician performance + availability | **`GET /technicians/:id/performance?period=`** (reuses B6 KPIs). **`TechnicianAvailability { technicianId, from, to, reason }`** with `GET/POST/DELETE /technicians/:id/availability`. **`POST /technicians/:id/replace`** `{ replacementTechnicianId, from, to? }`: reassigns visits in the window (uses A1) and sends notifications. Generation skips unavailable technicians, falling back to the round's other technician or unassigned plus a dashboard alert. | technicians | 8 |
| **GAP-009** CSV import (backend validation) | `/setup/step/9/bulk`: require `phone` (400 per row, `{ row, field, error }`). If `cleaningFrequency` is absent, default to the round's. Reject a plan frequency that differs from the round's unless `allowFrequencyMismatch` (then B3 rules apply). | setup | 2 |
| **GAP-005** Startup/latency | `app.listen` before `migrateAllTenantSchemas`. `/health` returns 503 `{ status: "migrating" }` until done. **Add `/health/ready`.** Move migrations to a release step in the Dockerfile/Railway config. Add per-request timing logs (p95 by route) to find the 6–15 s writes; likely the per-request tenant client creation. Check `tenant-prisma-manager` caching. | infra | 5 |
| **GAP-007** Multi-select payment method | **Decision needed.** Recommend deferring to Phase 2. If approved: `Customer.acceptedPaymentMethods PaymentMethod[]`, keeping `paymentMethod` as the primary. | customers | 6 |
| **GAP-004** Technician areas | Web bug (sends `serviceAreaId`). Backend: also accept singular `serviceAreaId` and fold it into `serviceAreaIds`, so old clients don't silently drop it. | technicians | 0.5 |

### Phase D: Low

| ID | Change | h |
|---|---|---|
| **GAP-002** | Add `BusinessSettings.completedSteps Int[]`, written when each step saves. `/setup/status` uses it instead of row counts, so seeded services and templates no longer tick steps. Return a `wizardSteps` array matching the web's 10-step order. | 2 |
| **GAP-016** | Covered by A2 (exclusive end and preview endpoint). | — |
| **GAP-022** | `GET /properties/:id/notes` returns the access and risk notes as pinned entries (`{ pinned: true, source: "ACCESS" \| "RISK" }`). Customer detail returns `badDebt`. **New `PATCH /customers/:id/bad-debt`** `{ flag, reason }`. | 2 |
| **GAP-031** | `GET /debt/kpis` adds `totalOutstandingsCount` and `badDebtCount` (distinct customers). | 1 |
| **GAP-032** | `POST /invoices` and preview return 409 `code: "VISIT_NOT_COMPLETED"` unless the visit is COMPLETED (one-off jobs too). `dueDate` defaults to invoice date + `invoiceDueDays` (GAP-008). The line item falls back to the plan's service name, then the round's default service, then "Window cleaning". | 2 |
| **GAP-035** | `/today` rounds: add `scheduledValue` (all non-cancelled stops) next to `completedValue`. `value` is deprecated for one release. `etaMinutes: null` until a real estimate exists; drop the `remaining*20` stub. Add `generatedAt` to the response so the web can show "Updated HH:mm". | 1 |
| **GAP-024** | Activity response stays `{ rows, pagination }` (the web unwraps it). Reproduce the revenue 500 on api-dev with the current web build; if it reproduces, fix and add a regression test. | 1 |
| **GAP-023** | Web only. Optionally `GET /rounds/planner/stops?from&to` for a date-range map; the web can call the existing per-date endpoint 7×. | 0–2 |

---

## 3. Sequencing

```
Week 1  A1 → A2 → A3 → A4      (data correctness; A8 depends on A1)
        A6 env var on api-dev  (day 1, no code)
Week 2  A5, A6, A7, A8, swagger contract test
Week 3  B1–B5, B8, Phase C quick ones (021, 031, 032, 035, 004, 009)
Week 4  B6, GAP-028/029/030, GAP-010, GAP-005, GAP-002/022
Decisions pending: GAP-007 (multi-select), A5 reminder ownership (GHL vs backend job)
```

Ship A1–A4 together with their backfill scripts. Run the backfills on api-dev and diff the visit counts before prod.

## 4. Data migrations and backfills

| Migration | Backfill | Rollback |
|---|---|---|
| `Property.assignedTechnicianId` | `backfill-visit-technicians.ts` | column nullable; drop safe |
| `VisitStatus.CANCELLED`, `Visit.cancelReason` | none | enum add is forward-only; keep it |
| BusinessSettings address/VAT/reminder/payment defaults/`completedSteps` | `completedSteps` derived once from the current status | columns nullable/defaulted |
| `TechnicianIncident`, `KpiThreshold`, `TechnicianAvailability` | none | drop tables |
| `Photo.propertyId` | from `visit.propertyId` | nullable |
| `Visit.reminderSentAt`, `Visit.complaintId` | none | nullable |
| `PhotoType.ACCESS_ISSUE`, `Photo.issueId` (`20261030020000_access_issue_photos`) | none | enum add is forward-only; column nullable |

All migrations go under `prisma/tenant/` and are applied by `migrateAllTenantSchemas`. Each backfill script is idempotent, runs per tenant, and supports `--dry-run`.

## 5. Risks

- **A1 restamping** must not overwrite visits a manager reassigned by hand for a specific day. Only restamp visits whose `technicianId` is null or equals the previous round default. Track this with `Visit.technicianOverride Boolean`.
- **A4 enum value** `CANCELLED` breaks any client that switches exhaustively on `VisitStatus`. The web and the app must handle it before the backend deploys (see the handoff).
- **A5 removing the static payment-link fallback** turns a silent no-op into a visible 409. That is intended. The web must show "Connect Stripe".
- **A6 removing the step-2 booleans** breaks the current wizard payload. Ship the web change first, or rely on the one-release 400 warning period.

## 5a. Defects found while documenting swagger (not in the audit)

| # | Defect | Fold into |
|---|---|---|
| D-1 | `GET /settings/*` and `GET /setup/step/1,2,4` return the raw BusinessSettings row, **including the `*Encrypted` token and secret ciphertexts**. Add a response DTO that strips them. | **Fix first** (security), 1h |
| D-2 | Visit complete (web and mobile) marks the visit COMPLETED before the cash check and outside a transaction. A 400 leaves it COMPLETED with no payment, and a retry short-circuits. | A8 |
| D-3 | The mobile router has no TECHNICIAN role guard. Any tenant user can act on any visit or read any round's chat. | A8 |
| D-4 | Chat `senderProfileId` stores the Supabase user id, not the Profile id. | A8 |
| D-5 | The debt gate blocks on any debt when only one of `debtHoldMaxInvoices` / `debtHoldMaxAmount` is set. | A3 |
| D-6 | `POST /debt/:id/payment-link` creates the Stripe session before the email check, which orphans sessions. | A5 |
| D-7 | `POST /invoices/:id/send` can flip PAID or VOID back to SENT. | A5 |
| D-8 | GHL webhook dedup swallows every error as "already processed". `/settings/ghl/disconnect` doesn't clear `Tenant.ghlLocationId`. | A5 |
| D-9 | Mobile complete doesn't queue the `visit.completed` GHL event. `revenueByMethod` ignores the plan or customer method. | A8 |
| D-10 | Webhook URLs become `undefined/...` when `PUBLIC_API_URL` is unset. Validate env at startup. | A6 |
| D-11 | `GET /settings/stripe/callback` returned 500 when Stripe rejected the code (`invalid_grant`). Found by the regression suite (GAP-036). Now `400 STRIPE_CONNECT_FAILED` / `502 STRIPE_UNAVAILABLE`. | A6 (fixed) |

## 6. Swagger maintenance (ongoing)

- `src/swagger.ts` was updated in this pass to cover every registered route (incl. `/mobile/*`, `/webhooks/*`, GHL, Stripe and GoCardless connect, `/payments/:id/status`, `/visits/:id/complete`).
- Every PR touching a route updates `swagger.ts`. The contract test in §1.6 fails CI otherwise.
- Remember that `src/index.ts` builds the 405 pre-filter from the spec. A documented path that lists only some of its methods **blocks** the others at runtime. The contract test asserts against this.
- After each deploy, the web runs `npm run generate:types` to refresh `src/api/types.gen.ts`.

## 7. Audit reply (for Agentum / Mark)

| Audit item | Response |
|---|---|
| GAP-015 | Partly incorrect: the backend mobile API exists at `/mobile/visits/:id/{start,arrive,skip,price,complete,notes,access-issues,photos,debt-payment}` (live on api-dev; was undocumented). The gap is the mobile app wiring, plus A1/A8 here. |
| GAP-033 | Incorrect: schema-per-tenant is implemented. The OpenAPI text was stale and has been fixed. |
| GAP-004, GAP-027, GAP-024, GAP-011, GAP-013 | Mainly frontend wiring to existing endpoints. Backend changes are minor. |
| GAP-036 | Connect flows are real (Stripe Connect OAuth, GoCardless token) but broken by auth on the redirect and callback. The webhook 500 is a missing env var on api-dev. |
| GAP-034 | Confirmed, and wider: no outbound payment link, reminder or invoice message is delivered today. |
| Not in audit | X-1 (visits never assigned to technicians), X-2 (recurrence stops after the activation window). |
