# Property Geocoding (Latitude/Longitude) — Backend Handoff

**Date:** 2026-10-29
**Audience:** another backend engineer picking this up cold — this is the decision record, not just a changelog.

---

## 1. Why this work happened

Two existing docs flagged the same gap and both explicitly deferred fixing
it: `docs/Handoffs/ROUND_PLANNER_HANDOFF.md` §8 ("⚠️ No coordinates. `Property`
has no `latitude`/`longitude` column... Geocode client-side") and
`docs/Handoffs/FRONTEND_WIRING_AUDIT_RESPONSE_2026-10-22.md` Part C item 1
("Dashboard 'today's stops' map with lat/lng... needs a schema migration, a
geocoding step, and confirmation the frontend will actually have a maps API
key configured. Scoped as its own ticket."). This is that ticket.

The ask was two-fold: add real coordinates to `Property`, and expose them on
every response that currently carries a property's address and feeds a map,
planner, or technician-navigation view — without adding any new required
input, and without requiring the frontend to hold a paid maps API key.

## 2. Scope decisions

### 2a. Geocoding provider — postcodes.io, not a paid maps API

The frontend audit doc's framing assumed the eventual fix would need "a maps
API key configured" on the frontend (implying client-side geocoding against
Google/Mapbox, which both charge and require key management). Decided
against that: RoundFlow is UK-only, `addressLine` is unstructured free text
with nothing reliable to geocode against, but `postcode` is already
validated-adjacent and precise enough for pin placement — exactly what the
Round Planner handoff itself already proposed doing client-side. Moving that
same postcode-keyed lookup to the backend via
[postcodes.io](https://postcodes.io) (free, unauthenticated, no API key)
avoids the vendor-key problem entirely, and means the frontend needs zero new
configuration.

Trade-off accepted: precision is postcode-level, not point-level. Adequate
for map pins and route-planning views; **not** adequate if turn-by-turn
navigation accuracy is ever required — that would need a different (paid,
address-level) provider.

### 2b. Backend-computed, not user-entered

`latitude`/`longitude` are never accepted as input on any route — they're
derived solely from `postcode` server-side. This keeps the frontend forms
unchanged and guarantees coordinates and postcode never drift apart from
each other for reasons other than the postcode itself changing.

### 2c. Fire-and-forget on write + cron backfill, mirroring the existing outbox pattern

Looked at how `src/jobs/outboxWorker.ts` already solves "do an external HTTP
call off the back of a DB write without blocking or risking the request on
it" for GHL, and reused the same shape rather than inventing a new one:

- On create (`createProperty`, `addPropertyToCustomer`) and on a postcode
  change (`updateProperty`, `updateCustomer`), a `triggerGeocode()` helper in
  `customer.service.ts` is called **after** the triggering `$transaction` has
  committed, with `this.prisma` (never the `tx` client), and is never
  `await`ed by the caller — just `.catch(console.error)`, same as
  `visitGeneration.ts`'s `queueGhlEvent(...).catch(console.error)`. An
  external HTTP call never runs inside a DB transaction here.
- `src/jobs/geocodeBackfill.ts` (`runGeocodeBackfill()`) is the retry/backfill
  net: cron-scheduled every 15 minutes in `src/index.ts`, it finds every
  property across every tenant where `latitude IS NULL AND geocodeAttempts <
  5` and bulk-geocodes them via `geocodePostcodesBulk` (chunked to 100/request
  — postcodes.io's own limit).
- This is also what backfills **pre-existing** properties — after the
  migration they all start at `latitude = NULL, geocodeAttempts = 0`, so the
  very next cron tick picks up the entire existing fleet. No separate
  one-off backfill script was written or is needed.

### 2d. Dead-letter without a status enum

The outbox has an explicit `status: "dead"` column. Here, the
`geocodeAttempts < 5` filter on the backfill query does the same job
implicitly — a property that's failed 5 times just stops being selected by
future ticks, with its last `geocodeError` left in place for debugging.
Decided against adding a parallel status enum since the filter already
expresses it and one less column is one less thing to keep in sync. There is
currently **no endpoint** to force a retry on a dead-lettered property — that
would mean an admin action that resets `geocodeAttempts` to `0`, which wasn't
asked for and wasn't built.

### 2e. Postcode-keyed invalidation, not address-keyed

Coordinates are reset and re-geocoded **only** when `postcode` itself
changes — not on every property edit. An `addressLine`-only edit (e.g. a unit
number, a building name) leaves `latitude`/`longitude` untouched, since
postcodes.io's precision is postcode-level anyway and nothing about the
address line affects that. This matters because there are **two** separate
write paths that can change a property's postcode — `PATCH /properties/:id`
(`updateProperty`) and `PATCH /customers/:id` (`updateCustomer`, which also
writes the property's address fields in the same transaction, M19) — both
needed the same postcode-changed check, independently, since they don't share
code for the property-field diff.

## 3. What was built

- **Schema** (`prisma/tenant/migrations/20261029000000_property_geocoding/`):
  `Property.latitude Float?`, `longitude Float?`, `geocodedAt DateTime?`,
  `geocodeAttempts Int @default(0)`, `geocodeError String?`. All nullable/
  defaulted — no backfill script needed beyond the cron job itself (see
  §2c). Picked up automatically on next deploy by
  `migrateAllTenantSchemas()` — see `docs/ARCHITECTURE_LATEST.md` §12 (which
  this change also corrected — it previously, incorrectly, said existing
  tenants are never auto-migrated).
- **`src/integrations/geocoding/client.ts`** — `geocodePostcode` (single) and
  `geocodePostcodesBulk` (chunked bulk). No SDK (postcodes.io has none),
  raw `fetch`, following `src/integrations/ghl/api.ts`'s style rather than
  the Stripe/GoCardless SDK-wrapper style. A 404 means "no match" and
  resolves to `null`; anything else non-2xx or a network failure throws.
- **`src/jobs/geocodeBackfill.ts`** — `runGeocodeBackfill()`, cron-scheduled
  `*/15 * * * *` in `src/index.ts`, modeled directly on
  `src/jobs/outboxWorker.ts`'s per-tenant `Promise.allSettled` + per-row
  attempt bookkeeping.
- **`customer.service.ts`** — new `triggerGeocode()` helper; wired into
  `createProperty`, `addPropertyToCustomer`, `updateProperty`, and
  `updateCustomer` (the last two only on an actual postcode change, per
  §2e).
- **Response shapes** — `latitude`/`longitude` (`number | null`) added to:
  `Property` (→ `PATCH /properties/:id`), `CustomerListRow` (→
  `GET /customers`), `CustomerDetail.property`/`tabs.overview` (→
  `GET /customers/:id`), `PlannerStop` (→ the planner list/map + batched
  endpoints), `TodayPanelStop` (→ `GET /rounds/:id/today`), `VisitDetail` (→
  `POST /visits`), and the mobile `MobileVisitRow` / job-detail payload (→
  `GET /mobile/rounds/today`, `/mobile/visits/today`, `/mobile/completions`,
  `GET /mobile/visits/:id`). Full endpoint-by-endpoint rationale (including
  the explicitly-excluded display-only endpoints) is in
  `docs/ARCHITECTURE_LATEST.md` §14.5 and the frontend handoff doc.
- **`src/swagger.ts`** — updated the `Property`, `PlannerStop`,
  `TodayPanelStop`, `Visit`, `CustomerListRow`, and `CustomerDetail` schemas.
  No OpenAPI doc exists for the mobile API today, so no swagger change was
  needed there.
- **`docs/ARCHITECTURE_LATEST.md`** — new §14 (this feature, in the same
  depth as §10's GHL writeup), plus a correction to §12's migration section
  (see below) and a §13 status-summary bullet.

### Incidental fix: §12 Migrations was stale

While writing §14, re-reading §12 to place the new migration row correctly
surfaced that its claim "existing tenant schemas are not automatically
migrated... that is a Phase 2 concern" is simply wrong against the running
code — `src/lib/tenant-provisioning.ts`'s `migrateAllTenantSchemas()` already
does exactly that (a `_migrations` tracking table per tenant schema, called
from `src/index.ts` on every startup, with baselining for pre-tracking
tenants). Corrected in place rather than left to drift further; see §12 in
the architecture doc for the accurate description.

## 4. Testing

`src/integrations/geocoding/client.ts` and `src/jobs/geocodeBackfill.ts` are
brand-new whole files with no pre-existing untested code, so they were added
to `vitest.config.ts`'s gated 100% line/branch/function/statement list
(`GEOCODING_FILES`, alongside the existing `PAYMENT_DOMAIN_FILES`/
`AUDIT_REMEDIATION_FILES`) — `npm run test:coverage` enforces this per-file
going forward.

The callers (`customer.service.ts`, `round.service.ts`, `visit.service.ts`,
`src/mobile/services/*.ts`) mix this change into large, previously-untested
files and were deliberately **not** added to that gated list, for the same
reason `round.service.ts`/`customer.service.ts` were excluded from
`AUDIT_REMEDIATION_FILES` already (gating the whole file would fail CI
against pre-existing, unrelated untested code). Every new branch this change
introduces in them — geocode success, not-found, provider failure, and the
postcode-changed vs. unchanged paths on both `updateProperty` and
`updateCustomer` — is covered by a new test in each file's existing
`__tests__` suite.

## 5. Known gaps / intentionally not built

- **No admin action to force a retry** on a dead-lettered property (5 failed
  attempts). Would mean resetting `geocodeAttempts` to `0`; not asked for.
- **No endpoint exposes `geocodeAttempts`/`geocodeError`** to the frontend —
  they're backend-internal retry bookkeeping, not user-facing state. If
  support ever needs to debug "why does this property have no pin," it's a
  direct DB look today, not an API call.
- **Dashboard GPS map** is still unbuilt — it was never backed by a backend
  endpoint (see `docs/SRS.md` and `docs/ARCHITECTURE_LATEST.md` §14.5) and
  remains a frontend-only placeholder. Wiring it up is a separate task that
  can now use the data this change provides.
