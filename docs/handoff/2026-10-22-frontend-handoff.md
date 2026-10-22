# Frontend Audit Follow-Up — Frontend Handoff

**Date:** 2026-10-22
**Audience:** frontend developer / frontend repo owner (self-contained — copy or forward as needed)
**Re:** backend response to the "RoundFlow Frontend Wiring & Data Audit (v2)" doc

Three phases of backend work shipped against the audit. Most of it is additive. A few things are **breaking response-shape changes** — look for the "Action required" sections below before you touch the affected screens.

---

## Action required — Complaints list, Reports visits/technicians are now paginated

Same change debt board got on 2026-10-16. These three endpoints used to return a bare array; they now return:
```ts
{
  rows: T[];                 // same row shape as before
  pagination: { page: number; pageSize: number; total: number; totalPages: number };
}
```
Affected: `GET /complaints`, `GET /reports/visits`, `GET /reports/technicians`. New optional `page`/`pageSize` query params (default page size 50, max 100).

`GET /reports/export?type=...` is **unpaginated on purpose** — it streams the full CSV regardless of page. Don't apply the same destructuring there.

## Action required — per-plan writes: stop guessing which plan is "primary"

If a property has 2+ service plans, `PATCH /properties/:id`, `PATCH /customers/:id`, and `POST /properties/:id/pause|resume` were silently mutating whichever plan the backend happened to pick as "primary" — not necessarily the one shown/selected in your UI. New endpoints target one plan directly:

```
PATCH /service-plans/:id
  body: { price?, cleanMethod?, paymentMethod?, cleaningFrequency? }

POST /service-plans/:id/pause
  body: { reason: string, pauseStartDate: "YYYY-MM-DD", pauseEndDate?: "YYYY-MM-DD" }

POST /service-plans/:id/resume
```

`GET /customers/:id` now also returns `isPrimary: boolean` on each entry in `servicePlans[]`, so you can tell which one the backend currently treats as primary without re-deriving the rule client-side. If a property only has one plan, nothing changes for you — this only matters once you're editing a specific plan on a multi-plan property.

## Action required — bulk property import (Setup step 9) response shape changed

`POST /setup/step/9/bulk` used to abort the whole batch on the first bad row and return a vague error. It now:
- Accepts `landline` and `serviceIds: string[]` (plural) per row, alongside the existing single `serviceId`.
- Accepts an optional `idempotencyKey: string` in the body — resubmitting the same key returns the original result instead of re-importing (safe to retry on a timeout).
- Returns real structured errors and a partial-success count, even when some rows are bad:

```ts
{
  created: number;
  failed: number;
  results: PropertyResult[];       // one per successfully-created row
  errors: { row: number; field: string; message: string }[];  // row = index in your submitted array
  idempotent?: true;                // present if this was a replay of a previous idempotencyKey
}
```
`201` if anything was created (or it was an idempotent replay); `400` only if every row failed and nothing was created. You can now show "committed 48 of 50, see 2 errors below" instead of an all-or-nothing failure toast.

## Action required — richer debt/invoice/complaint detail — check your TypeScript types

These didn't change shape in a breaking way, just grew more fields — if you have hand-written response types, update them:

- **`GET /debt/:id`** — new endpoint. Invoice detail: phone, email, round name, next scheduled visit date, GoCardless mandate id/status, last 5 visits. Use this instead of pulling from the board row (which doesn't carry these).
- **`GET /debt/board/counts`** — new endpoint, replaces making 6 separate `GET /debt/board?pageSize=1` calls for tab counts: `{ BAD_DEBT, ON_HOLD, FAILED_GC, DUE_BEFORE_CLEAN, SEVEN_DAYS_OVER, FOURTEEN_DAYS_OVER, ALL }` → counts.
- **`GET /debt/board`** — new optional `search` query param, matched server-side against customer name/address (previously you could only search the 50 rows already loaded on the client).
- **`PATCH /debt/:id/hold`** — body grew from `{ flag }` to `{ flag, reason?, date?, notify?, message? }`. `notify: true` actually sends an SMS now (previously `notifyCustomers`-style flags elsewhere were silent no-ops — see below).
- **`POST /debt/:id/payment-link`** response gained `provider` ("stripe" | "static") and `expiresAt` (null for the static fallback link).
- **`GET /invoices/:id`** (the JSON route, not `/pdf`) now returns line items, technician, visit date, and a VAT/subtotal breakdown — previously just id/number/status/amount/dueDate.
- **`GET /complaints/:id`** now also returns `propertyAddress`, `technicianName`, `messageCount`, `resolvedAt`, `resolvedBy`, `notes`.
- **`POST /complaints/:id/resolve`** now accepts an optional `notes` field in the body.

## Action required — GET /technicians now includes round names and today's stats

`GET /technicians` (not `/settings/technicians`) now returns, per technician:
```ts
{ ...existing fields, roundNames: string[], todayStats: { total, completed, skipped, remaining } }
```
If you were calling `GET /technicians/:id` per row just to show this, you can delete that fan-out.

## Action required — `/settings/technicians` role field is now validated

`role` on both `POST/PATCH /technicians` and `POST/PATCH /settings/technicians` must now be one of `TRAINEE`, `STANDARD`, `SENIOR`, `LEAD` (or omitted/null to clear) — previously any string was accepted on either endpoint. A non-matching value now 400s with the allowed list in the error message. If you have a role dropdown, make sure its options match this list. `/settings/technicians` create/update responses also now include `serviceAreas[]` and the same `appStatus` field `/technicians` already returns (previously missing on this router).

---

## No action required — cross-round day stops, on-demand visit generation

- **`GET /rounds/planner/occurrences/:date?roundIds=a,b,c`** (new) — batched day-stops across multiple rounds for one date, same pattern as the existing `?roundIds=` calendar batch endpoint. Removes the remaining `R × date` fan-out in the List/Map planner views if you adopt it; the old per-round `GET /rounds/:id/planner/occurrences/:date` still works.
- **`POST /rounds/:id/generate-visits`** (new) — generates due visits for a round immediately instead of waiting for the next nightly run. Returns `{ visitsGenerated: number }`. Rounds always eventually get visits via the nightly job; this just removes the next-day wait after creating a new round.
- **`GET /dashboard/charts`** now accepts an optional `technicianIds` filter (comma-separated), in addition to the existing `range` param.
- A date-validation bug is fixed on the round planner routes: a malformed-but-syntactically-valid date like `2026-02-30` used to silently roll over to March 2 instead of erroring. It now correctly 400s.

## No action required — new tenants get real default data

Every new tenant signup now seeds 6 default Services and 6 default MessageTemplates automatically (previously: nothing, until the first admin manually built out their catalog). These are ordinary editable/deletable rows — if your onboarding flow still shows hardcoded sample services/templates client-side, you can remove that now and just render whatever `GET /settings/services` / `GET /settings/message-templates` return.

---

## Already true — no backend change needed, just wiring on your end

Confirmed in code, not re-built:
- `requireAuth` verifies a real Supabase JWT server-side — the `admin`/`admin` dev-bypass issue is a frontend-only gap, not something the backend was ever fooled by.
- `GET /invites/:token` is public (no auth header needed) — if you're hitting "Not signed in" before this call, that's your client wrapper throwing early, not a 401 from the backend.
- `GET /settings/service-areas`, `/technicians`, `/services` work before setup is complete — only the mutating routes require `setupCompleted`.
- SMS Templates (`/settings/message-templates`) and GoCardless/Stripe connect are already real, DB-backed / live-API-validated — not stubs.
- `POST /invites/:token/accept` is already idempotent against a double-submit.
- Debt board pagination was already clamped (`page ≥ 1`, `pageSize ≤ 100`) before this round of work.
- Hold/bad-debt flags are intentionally per-customer, not per-invoice — the whole relationship is flagged. Not a bug.

See the formal backend response (`docs/Handoffs/FRONTEND_WIRING_AUDIT_RESPONSE_2026-10-22.md`) for the full point-by-point breakdown, including what's flagged for a product decision and intentionally **not** built yet (SMS billing/credits, scheduled sends, Weather Hold as a real feature, complaint `issueType` as an enum, `STANDING_ORDER` payment method, bulk debt actions).

## Not built this round (by decision)

- **Dashboard "today's stops" map with lat/lng** — needs a schema migration (no lat/lng field exists anywhere today) and a geocoding step; scoped as its own ticket, not attempted here.

---

## What to verify after this deploys

- [ ] Complaints list, Reports → Visits, Reports → Technicians — **after updating your code for the new `{ rows, pagination }` shape**
- [ ] A multi-plan property: pause/resume/edit each plan independently and confirm the right one changes
- [ ] Bulk property import with a deliberately bad row mixed into good ones — confirm partial success + per-row errors
- [ ] Debt board search, bucket tab counts, and the new invoice detail panel
- [ ] Technician list — round names / today's stats render without a per-row fetch
- [ ] A brand-new signup — confirm Services/Message Templates are pre-populated, not empty
