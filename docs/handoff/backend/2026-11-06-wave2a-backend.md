# Wave 2A backend handoff (2026-11-06)

Scope: ACT-10 (Google geocoding), ACT-02..04 (working days and carryover), GHL-10 (tenant details on the invoice), ACT-01 (bulk invoice send, GHL channel) and the Wave 1 follow-ups, from `docs/GAP_ANALYSIS_AND_REMEDIATION_PLAN_2026-11-06.md`. All work is **uncommitted**. **Nothing was applied to any database**, no backfill was run, and Google was never called (tests mock `fetch`). Frontend consequences: `docs/handoff/frontend/2026-11-06-wave2a-frontend-contract.md` (breaking changes first).

## 1. Migrations (NOT applied; they go out with the normal deploy, startup runs `migrateAllTenantSchemas`)

All four are additive and idempotent (`IF NOT EXISTS`). Code that writes the new columns fails on an un-migrated tenant, so migrate before or with this release.

| Folder (`prisma/tenant/migrations/`) | Change |
|---|---|
| `20261106100000_property_geocode_precision` | `Property.geocodePrecision`, `geocodePlaceId`, `geocodeAddressHash` (TEXT, nullable) |
| `20261106100100_visit_carryover` | `Visit.carriedOverFromDate` (DATE, nullable), `Visit.carryoverCount` (INT NOT NULL DEFAULT 0) |
| `20261106100200_invoice_footer_payment_terms` | `BusinessSettings.invoiceFooter`, `paymentTerms` (TEXT, nullable) |
| `20261106100300_outbox_dedupe_batch` | `IntegrationOutbox.dedupeKey` (TEXT, unique index, nullable), `batchId` (TEXT, indexed) |

`npm run prisma:generate` was run (safe, no DB). Rollback: all columns are nullable or defaulted and unused by older code; no rollback needed.

## 2. Environment variables

| Var | Default | Meaning |
|---|---|---|
| `GOOGLE_MAPS_GEOCODING_API_KEY` | unset | Server-side Google Geocoding API key. Create a **separate** key (Geocoding API only, restricted by server IP) in the same Google Cloud project; do not reuse the browser Maps key. Unset = old postcodes.io behaviour (stored as `POSTCODE_FALLBACK`) and a startup warning. Listed in `RECOMMENDED_ENV_VARS` (`src/lib/env-check.ts`) and `.env.example`. Never logged. |
| `GEOCODE_DAILY_LIMIT` | `2000` | Max Google calls per process per UTC day (in memory). Over it, lookups use postcodes.io only. Listed in `OPTIONAL_ENV_VARS` and `.env.example`. |

## 3. ACT-10 Google geocoding

- `src/integrations/geocoding/client.ts`: `geocodeAddress({ addressLine, postcode, town? })` builds `"<line>, <town?>, <POSTCODE>, UK"`, calls `https://maps.googleapis.com/maps/api/geocode/json` with `components=country:GB`, `region=gb` and the key, 5 s `AbortSignal` timeout, one retry on 5xx or network error. Never throws; returns `{ result, error }`. Precision: Google `location_type` (`ROOFTOP`, `RANGE_INTERPOLATED`, `GEOMETRIC_CENTER`, `APPROXIMATE`); `partial_match: true` or an unknown type becomes `APPROXIMATE`. ZERO_RESULTS, a non-OK status, or an exhausted quota fall back to postcodes.io, stored as `POSTCODE_FALLBACK`. Helpers `hashAddress`, `buildAddressQuery`, `isLocationApproximate`, quota functions.
- `src/services/property-geocoding.ts`: `geocodeProperty()` stores `latitude`, `longitude`, `geocodePrecision`, `geocodePlaceId`, `geocodeAddressHash`, `geocodedAt`; `addressChanged()` and `GEOCODE_RESET`. `customer.service.ts` (create customer+property, create property, add property, update property, update customer) geocodes again **only when the address hash changes** (an address-line-only edit now re-geocodes, since the query is the full address) and never on read. The save always succeeds: the geocode runs after commit, fire-and-forget.
- Property has no `town` column; the query uses line + postcode (+ town when a caller passes one).
- Setup/CSV import creates properties without coordinates; the backfill picks them up (precision null).
- Backfill (`src/jobs/geocodeBackfill.ts`, cron every 15 min): with the key, selects `geocodeAttempts < 5` and (precision null, `POSTCODE_FALLBACK`, `APPROXIMATE`, or no address hash). Batches of 50, **200 properties per run** across tenants (override with `--limit=N`), stops when the quota is spent. A property that stays approximate is retried at most 5 times. "Hash mismatch" is covered by the null hash that every address edit writes (`GEOCODE_RESET`); rows whose hash silently disagrees without an edit are not scanned. Without the key: old behaviour (only rows without coordinates).
- Manual run (not run by me): `npx tsx scripts/backfill-geocode.ts --dry-run`, then `--limit=200`. A dry run reads, counts and never calls Google or writes.
- DTOs gain `geocodePrecision` and `locationApproximate` (`locationApproximate` true for `POSTCODE_FALLBACK`, `APPROXIMATE`, and legacy rows with coordinates but no precision; false when there are no coordinates): `GET /customers` rows, `GET /customers/:id` (`property`, `tabs.overview`), `GET /properties/:id`, `GET /visits/:id` detail, planner stops (`PlannerStop`), today panel stops (`TodayPanelStop`), mobile visit rows (today, schedule, completions) and the mobile visit detail `property`.

## 4. ACT-02..04 working days and carryover

- `src/lib/working-days.ts` (see ARCHITECTURE section 19.2). `lib/schedule.snapToWeekday(date, workingDays?)`, nightly and on-demand visit generation (`generateForRound(tp, round, today, workingDays?)`), `resumePlan`, and weather hold now honour `BusinessSettings.defaultWorkingDays`. `tenantWorkingDays(tp)` in `business-time.ts`.
- `GET /visits/carryover/options?date=YYYY-MM-DD` -> `{ date, options: [{ key: "NEXT_WORKING_DAY"|"SATURDAY"|"MONDAY", date, label, default }] }`. Friday: always Saturday and Monday (Monday default, Saturday only when Monday is not a working day and Saturday is); Mon-Thu: the next working day; Sat/Sun: the next working day.
- `POST /visits/carryover { date, target, visitIds?, notifyCustomers?, dryRun? }` -> `{ moved, targetDate, conflicts: [{ visitId, technicianId, reason: "TECHNICIAN_UNAVAILABLE"|"TECHNICIAN_INACTIVE" }], notifiedTechnicians, notifiedCustomers, skipped: [{ visitId, reason: "NOT_FOUND"|"NOT_ON_DATE"|"NOT_UNFINISHED" }], dryRun, customerNotificationError? }`. Errors: 400 `INVALID_CARRYOVER_TARGET` (key not offered for `date`), 400 `CARRYOVER_TARGET_IN_PAST`, 409 `CARRYOVER_TARGET_CLOSED`, plus 400 for a bad body (`visitIds` 1 to 500). Default selection: every SCHEDULED/IN_PROGRESS visit on `date`.
- Effects per moved visit: `date = target`, `status = SCHEDULED`, `startedAt`/`arrivedAt = null`, `reminderSentAt = null`, `reminderSentTypes = []`, `carriedOverFromDate = date` (the day it was last due), `carryoverCount + 1`; queued `message.send` outbox rows for those visits are cancelled; one `VISITS_CARRIED_OVER` activity row (`details`: from, to, via, visitIds, conflicts, cancelledReminders); technicians get a `SCHEDULE` notification (`data.date`, `data.roundId` when single round). Conflicts do not block the move; the technician stays assigned, the office reassigns (use `dryRun` first). Customer messages: only with `notifyCustomers`, through the existing message service (needs GHL), opted-out customers skipped by the message service, best effort.
- `POST /today/close` `push_to_tomorrow` now delegates to the same service in the same transaction as the close; accepts optional `target` (same keys; omitted = default option). Response adds `carriedToDate` (null for `mark_as_skipped`). An invalid `target` is 400 `INVALID_CARRYOVER_TARGET` and nothing is closed. Technicians are notified after the commit.
- `carriedOver` / `carriedOverFromDate` on `PlannerStop`, `TodayPanelStop` and the mobile visit row; `carriedOver` count on the Today's Work `kpi` and each `rounds[]` row.
- The nightly generator already skipped any plan with an open (SCHEDULED/IN_PROGRESS) visit dated today or later, so a carried visit is not duplicated (tested).

## 5. GHL-10 invoice details

- `InvoicePreview.business` now is `{ name, email, phone, address: { line1, line2, town, postcode } | null, vatNumber, companyNumber, bank: { accountName, bankName, sortCode, accountNumber } | null, paymentTerms, invoiceFooter }` and `paymentReference` (= invoice number) was added; `GET /invoices/preview`, `GET /invoices/:id/pdf` and `GET /invoices/preview/pdf` use it. `bankDetails` (JSON from BusinessSettings) prints only when account name, number and sort code are all present. `paymentTerms` = the free text when set, else "Payment due within N days" (`invoiceDueDays`); the due date is printed too.
- `invoiceHtml`: every tenant value escaped, `<html lang="en">`, `<title>Invoice <number></title>`, `th scope="col"`, `.muted` colour `#595959` (7:1 on white, was `#777` at 4.48:1). No logo or brand colour (Wave 2B).
- Settings: `PATCH /settings/payment` accepts `invoiceFooter` (max 500) and `paymentTerms` (max 200), trimmed, blank or null clears; both are returned by every settings DTO (`GET /settings/payment`, `/setup/step/*`).
- VAT: the supplier VAT number prints whenever `vatRegistration` is set; confirm the full VAT-invoice wording with the client's accountant (plan item).

## 6. ACT-01 bulk invoice send

- `GET /invoices?status=` accepts `DRAFT|SENT|PAID|VOID|OVERDUE` (OVERDUE = SENT with a due date before today; the other four existed). Rows gain `overdue: boolean`.
- `POST /invoices/bulk-send/preview { ids? | status? (default DRAFT), filters? { customerId, q, from, to }, channel?, resend? }` -> `{ total, willSend, byChannel: { SMS?, EMAIL?, WHATSAPP? }, skipped: { <reason>: n }, truncated, totalMatching, invoices: [{ id, invoiceNumber, customerName, channel, skip }] }`. Skip reasons: `NOT_DRAFT`, `PAID`, `VOID`, `NO_CONTACT_FOR_CHANNEL`, `OPTED_OUT`, `GHL_NOT_CONNECTED`, `NOT_FOUND` (unknown id).
- `POST /invoices/bulk-send { ids? | status?:"DRAFT", filters?, channel?, resend?: false }` -> **202** `{ batchId, queued, skipped: [{ id, reason }], truncated? }`; additional skip reason `ALREADY_QUEUED` (double click). `ids` max 500 (400 `INVALID_BATCH_SIZE`); a status selection takes the oldest 500 and sets `truncated`. Default target is DRAFT only; `resend: true` allows SENT invoices.
- `GET /invoices/bulk-send/:batchId` -> `{ batchId, total, done, counts: { QUEUED, SENT, FAILED, SKIPPED }, results: [{ id, status, error?, code? }] }`; 404 `BATCH_NOT_FOUND`. Only queued rows are listed; invoices skipped at queue time are in the POST response only.
- Worker (`outboxWorker.ts` -> `processInvoiceSendRow`): atomic lease claim, drain-time re-checks (opt-out, invoice paid/void/missing, already sent) -> `skipped`; otherwise `sendInvoice()` (so SENT only after GHL accepts); terminal codes -> `failed`; transient -> retry with back-off, `dead` after 5. Idempotency: unique `dedupeKey` per invoice (hourly bucket for resends). Single `POST /invoices/:id/send` is unchanged. The channel decision is `resolveInvoiceChannel()` (plug point for the Wave 2B channel router). Only GHL-connected tenants are drained by the outbox worker (existing rule), which matches the `GHL_NOT_CONNECTED` skip.

## 7. Wave 1 follow-ups

- KPI alerts now go to ADMIN and MANAGER profiles (`notifyAdmins`); the per-admin loop and profile query are gone.
- `POST /mobile/visits/:id/debt-payment` with `CASH` calls `notifyInvoicePaid` for every invoice it settles (office feed; type `PAYMENT`). A pending cheque raises nothing.
- `POST /invoices` with `sendEmail: true` still returns `400 EMAIL_NOT_AVAILABLE` (Wave 2B enables it).

## 8. Tests and gates

- New test files: `integrations/geocoding/__tests__/google.test.ts`, `services/__tests__/property-geocoding.test.ts`, `lib/__tests__/working-days.test.ts`, `services/__tests__/carryover.service.test.ts`, `services/__tests__/today.closeday.test.ts`, `routes/__tests__/visits.carryover.route.test.ts`, `services/__tests__/invoice-send-batch.service.test.ts`; rewritten: `jobs/__tests__/geocodeBackfill.test.ts`, `jobs/__tests__/kpiThresholds.test.ts`, `integrations/pdf/__tests__/render.test.ts`; additions to customer, invoice, outbox worker, visit generation, weather hold, lifecycle, settings route, env-check, bootstrap, mobile service and misc tests.
- `vitest.config.ts`: new `WAVE2A_FILES` (100% per file): `working-days.ts`, `carryover.service.ts`, `property-geocoding.ts`, `invoice-send-batch.service.ts`, `geocodeBackfillCli.ts`, `pdf/render.ts`, `kpiThresholds.ts`. `geocoding/client.ts`, `geocodeBackfill.ts`, `outboxWorker.ts`, `invoice.service.ts`, `routes/invoices.ts` were already gated.
- The three pre-existing branch gaps (`message.service.ts` 181 and 393, `photo-gallery.service.ts` 182) are closed with tests; `npm run test:coverage` exits 0. No coverage ignore comments were added.

## 9. Rollback notes

Code plus nullable/defaulted columns. Unsetting `GOOGLE_MAPS_GEOCODING_API_KEY` returns geocoding to postcodes.io. Reverting the code leaves the new columns unused.

## 10. Proposed architecture doc changes

Done (explicitly authorised): new section 19, migration log rows in section 12, and the section 18.2 sentence about cash debt and KPI alerts. Section 14.2 (provider choice) is superseded by 19.1 but its text was left as history.
