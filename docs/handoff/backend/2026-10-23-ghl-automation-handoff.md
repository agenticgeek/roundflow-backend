# GHL Automation Readiness + Payment Reconciliation — Backend Handoff

**Date:** 2026-10-23
**Audience:** another backend engineer picking this up cold — this is the decision record, not just a changelog.

---

## 1. Why this work happened

The ask started as "we need to build the actual GHL Workflows (automations) — what does the
backend need first?" `docs/GHL_AUTOMATION_OWNER_HANDOFF.md` already specified the target
end-state for the automation owner (5 custom fields, 5 tags, 5 workflows, one inbound webhook),
written well before this session. Auditing the running code against that doc found it was
**ahead of the doc in some ways and behind it in others** — see `docs/ARCHITECTURE_LATEST.md`
§10 for the full corrected architecture write-up (that doc was created this session specifically
because `ARCHITECTURE.md` had drifted — stale file paths, a token-storage location that moved,
event types that were never built).

Three separate but related pieces of work came out of this audit, done in this order:

1. **Payment outcome unification + BACS/cheque manual reconciliation** (surfaced while
   investigating the `payment-failed` GHL tag gap — see §3a).
2. **Phase 1 — close the remaining GHL automation gaps** (custom fields, `payment-failed` tag,
   complaint-tag removal, lead-handoff webhook).
3. **Phase 2 — GHL template/Snippet two-way sync** — researched, found technically impossible
   against GHL's public API, **scope dropped**. See §2c.

## 2. Scope decisions

### 2a. Payment reconciliation — in scope

While confirming `payment-failed` was wired up, a broader question came up: is payment
failure actually detected for every payment method? Answer: GoCardless and Stripe failures
are both webhook-driven and real; **cash has no failure concept by design** (confirmed/rejected
at the point of collection via `cashConfirmed`); **BACS/cheque had no resolution mechanism at
all** — created as `PENDING` at visit completion and nothing — no webhook, no cron, no
route — ever moved them out of that state. Decided to fix this in the same pass as the
`payment-failed` tag work, since both touch the same `Payment`-status code paths.

### 2b. GHL Phase 1 — in scope

Closed every gap identified against `GHL_AUTOMATION_OWNER_HANDOFF.md`: the 5 custom fields were
promised to the automation owner ("the backend fetches the field IDs automatically") but zero
code existed for it; `payment-failed` tag was documented but never emitted by either payment
webhook; `has-open-complaint` was added but never removed on resolve; Workflow 5's lead-handoff
webhook payload (a GHL Workflow custom-webhook action, not a native app webhook — see §3c) was
silently dropped because it carries no `type` field and matched none of the existing branches.

### 2c. GHL Snippet/Template two-way sync — scope dropped

Requested separately: sync RoundFlow's `MessageTemplate` rows with GHL "Snippets" so templates
could be edited from either side. **Verified directly against GHL's official API v2 docs repo**
(`github.com/gohighlevel/api-v2-docs` — fetched the actual OpenAPI JSON files and webhook-event
markdown list, not blog posts) that:

- **Snippets have no public API at all.** Not in the 63-event webhook list, not in the ~40
  resource files under `apps/`, not mentioned anywhere in the 140KB `conversations.json` spec.
  It's a GHL UI-only feature (Settings → Snippets).
- There **is** a real "Templates" resource (`/locations/{locationId}/templates`, SMS/Email/
  WhatsApp) — but it's **GET (list) + DELETE only**. No `POST`/`PUT` exists anywhere in the spec
  for either path. Confirmed by listing every HTTP method object key defined on both paths —
  `get` only on the collection, `delete` only on `/templates/{id}`.

**Conclusion, decided with the requester:** two-way sync is impossible in either direction for
either resource. Even a one-way read mirror (GHL → RoundFlow) would only ever be able to read
and delete, never create/update, so RoundFlow-authored templates could never be pushed to GHL
regardless. **Decision: drop this entirely — `MessageTemplate` stays purely local to
RoundFlow, as it already was.** No code was written against this (research only), so there's
nothing to revert.

### 2d. Left deliberately alone — the `payment-collected` tag

`outboxWorker.ts` emits a `payment-collected` tag on `payment.collected` that **isn't** in
`GHL_AUTOMATION_OWNER_HANDOFF.md`'s tag list (that doc only lists `visit-completed`,
`debt-overdue`, `has-open-complaint`, `payment-failed`). Flagged, explicitly **not** removed or
reconciled this session — requester wants it kept for now and reconciled later when
`ARCHITECTURE_LATEST.md` gets a consolidated documentation pass. Don't "clean this up" as a
drive-by in unrelated work without checking first.

## 3. What was actually wrong (not just untested)

### 3a. `payment-failed` never reached GHL for either payment method

`gocardlessWebhook.ts`'s `failed` branch and `stripeWebhook.ts`'s `handlePaymentFailed` both
updated `Payment.status = FAILED` directly but never called `queueGhlEvent`. Workflow 4
("Payment Failed Chase") in the automation handoff doc depends entirely on this tag existing —
it would never have fired, for any tenant, regardless of GHL-side setup.

### 3b. BACS/cheque payments had zero resolution path

Created as `PENDING` at visit completion (`routes/visits.ts`) and never touched again — no
webhook exists for these methods (they're offline/manual by nature), and there was no
`PATCH /payments/:id` or equivalent anywhere in `src/routes/`. `routes/payments.ts` only had
Stripe checkout/setup-session creation. This is independent of GHL — a real gap in the core
payment flow.

### 3c. Lead-handoff (Workflow 5) payload shape was never handled

`GHL_AUTOMATION_OWNER_HANDOFF.md` §3/§4 describes "Lead Handoff to RoundFlow" as a **GHL
Workflow's own custom-webhook action** — triggered by the `ready-for-roundflow` tag — not a
native GHL app-level `ContactCreate` webhook subscription. Its payload has **no `type` field at
all**: `{ contactId, firstName, lastName, email, phone, address1, city, postalCode }`. The
existing `ghlWebhook.ts` only branched on `event.type`, so this payload matched none of the
`if (type === ...)` checks and was silently dropped — not even logged.

### 3d. The custom-field write shape I first built was wrong

Built `setGhlContactCustomFields` against a documented-but-unverified guess (`{id, value}`,
default API version `2021-07-28`). Verified against GHL's actual docs afterward
(`marketplace.gohighlevel.com/docs/ghl/locations/get-custom-fields` and
`.../docs/ghl/contacts/update-contact`) and found both were wrong: these specific endpoints
require `Version: v3` (not the `2021-07-28` used elsewhere in `api.ts` for contacts/tags/
messages — a real version split within the same file, see the comment in `api.ts`), and the
contact-update body shape is `{id, key, fieldValue}`, not `{id, value}`. Fixed before this was
ever exercised against a real GHL account. **Still not verified against a live sandbox** — see
§7.

## 4. What changed, concretely

### `src/services/payment.service.ts` — new file
`applyOutcome(paymentId, "PAID" | "FAILED")` — the single place that updates `Payment.status`
(+`paidAt`), flips the linked `Invoice` to `PAID` on success (matched by shared `visitId` —
`Payment` and `Invoice` aren't directly FK'd), and queues the matching GHL outbox event
(`payment.collected` / `payment.failed`). `computeBalanceOwed(prisma, customerId)` — sums
`SENT` invoices for a customer; never stored, computed fresh each time it's needed (same
"never denormalise money" rule as the rest of this codebase).

### `src/routes/gocardlessWebhook.ts` / `src/routes/stripeWebhook.ts`
Both `paid`/`confirmed`/`failed` (GoCardless) and `handlePaymentFailed` (Stripe) now go through
`createPaymentService(tp).applyOutcome(...)` instead of raw `tp.payment.update`/`updateMany` +
a separate manual `queueGhlEvent` call. This is what actually closes §3a.

### `src/routes/payments.ts` — new endpoint
`PATCH /payments/:id/status` — body `{ status: "PAID" | "FAILED" }`. Restricted to `BACS`/
`CHEQUE` payments only (GoCardless/Stripe stay webhook-only — a manual override there could
race with a real webhook arriving later). Blocks any transition away from an already-`PAID`
row. Calls `applyOutcome`. Same middleware chain as the rest of the router (ADMIN/MANAGER only
via `requireBusinessAccess()`).

### `src/integrations/ghl/api.ts`
New: `setGhlContactCustomFields(ctx, contactId, fields)` + internal `getLocationCustomFields`
(resolves RoundFlow's bare key names — `last_clean_date`, `next_clean_date`, `balance_owed`,
`round_name`, `technician_name` — to GHL's field IDs via `GET /locations/{locationId}/
customFields`, cached 10 min per location). A requested key with no matching GHL field is
skipped (logged), not thrown — the automation owner may not have created every field yet.
`__clearGhlCustomFieldCache()` exported for tests only.

### `src/integrations/ghl/sync.ts`
`queueGhlEvent` gained a 4th optional `extra` param, merged into the outbox payload alongside
`customerId` (default `{}`, fully backward compatible) — needed so `visit.completed` can carry
a `visitId` for round/technician lookups at drain time. New `applyGhlCustomFields(tp,
customerId, fields)` — same connected/linked-customer guards as `applyGhlTags`, delegates the
actual write to `api.ts`.

### `src/jobs/outboxWorker.ts`
- `visit.completed` now also looks up the `Visit` (round name, technician name, completedAt)
  via the new `visitId` payload field and writes `last_clean_date`/`round_name`/
  `technician_name`/`balance_owed`.
- New `visit.scheduled` case — writes `next_clean_date` (drives Workflow 1, the pre-clean
  reminder, which was otherwise unbuildable).
- `payment.collected`/`payment.failed`/`debt.overdue` now also write `balance_owed`.
  `payment.collected` additionally clears the `payment-failed` tag (mirrors how it already
  cleared `debt-overdue`).
- New `complaint.resolved` case — removes `has-open-complaint`.

### `src/jobs/visitGeneration.ts`
`generateForRound` now queues `visit.scheduled` (with the newly-scheduled `nextCleanDate`)
right after creating each visit. Needed `property.customerId` added to the existing
`tp.property.findMany` select.

### `src/routes/complaints.ts`
`/:id/resolve` now queues `complaint.resolved` with `result.customerId`.

### `src/routes/ghlWebhook.ts`
New branch: a payload with no `type` field but a `contactId` is treated as the Workflow-5 lead
handoff (§3c). Dedupes by `ghlContactId` (create-only — if a `Customer` is already linked,
RoundFlow is master and this is skipped permanently, matching the decision in
`ARCHITECTURE_LATEST.md` §10.5). Creates `Customer` + `Property` in one `$transaction` (`Property`
requires `addressLine`/`postcode`, so it's only created when both `address1`/`postalCode` are
present in the payload; `city` is accepted in the payload but dropped — no schema column for
it).

### `prisma/tenant/schema.prisma`
Only a comment change — `IntegrationOutbox.eventType`'s doc-comment list extended with
`visit.scheduled` / `complaint.resolved`. No migration; it's a plain `String` column.

## 5. Test coverage

Target: 100% on every new/changed line, capped at 2–3 rounds of gap-filling per file (standing
instruction, not a one-off for this task). Reached 100% on everything touched; the only
remaining gaps in files this work touched are **pre-existing, untouched code** (e.g.
`createGhlContact`/`updateGhlContact`/`sendGhlMessage` in `api.ts`, `syncCustomerToGhl` in
`sync.ts`, the one-off-visit route in `visits.ts`, `/reopen`/`/assign-technician` in
`complaints.ts`) — none of that was part of this change and wasn't backfilled.

New test files: `services/__tests__/payment.service.test.ts`,
`integrations/ghl/__tests__/{api,sync}.test.ts`, `jobs/__tests__/{outboxWorker,
visitGeneration}.test.ts`, `routes/__tests__/ghlWebhook.route.test.ts` (this file had **zero**
prior coverage — the whole inbound webhook, including the pre-existing `InboundMessage`/
`Uninstall`/`ContactCreate` branches, is tested now, not just the new lead-handoff branch).
Updated: `routes/__tests__/{payments,complaints,visits.complete,gocardlessWebhook,
stripeWebhook}.route.test.ts`.

No new coverage-threshold config was added (unlike the payments-hardening work in
`2026-10-22-payments-hardening-handoff.md`, which gated specific files at 100% via
`vitest.config.ts`) — coverage was verified per-file with scoped `--coverage.include` runs,
not enforced by a committed threshold.

## 6. Mocking conventions used

Matched what already existed, same as every prior handoff:
- Route tests: supertest + minimal express app, `requireAuth`/`requireTenantAccess`/
  `requireBusinessAccess` mocked as pass-throughs, `req.tenantPrisma` a hand-built object of
  `vi.fn()`s.
- `src/integrations/ghl/api.ts`'s new functions: `vi.stubGlobal("fetch", fetchMock)` — no HTTP
  client wrapper exists to inject, so global `fetch` is mocked directly (same place
  `createGhlContact`/etc. would need to be tested the same way, if anyone backfills them).
- Webhook routes that fire outbox events fire-and-forget (`.catch(console.error)`) — tests use
  `vi.waitFor(...)` to assert against the mock after the async tail resolves, same pattern as
  the existing `gocardlessWebhook`/`stripeWebhook` tests.

## 7. Verification performed

- `npx tsc --noEmit` — clean throughout.
- `npm test` (vitest) — full suite green at every stage; 859 tests passing at the end of this
  work, up from 788 at the start of this session.
- Scoped `--coverage` runs (see §5) — 100% on every new/changed file.
- **Not verified:** a live call against a real GHL sandbox for the `v3` custom-fields
  endpoints (§3d). Needs a Private Integration Token against a test sub-account — list custom
  fields, create one via the UI, write a value to a test contact, confirm it shows up. Offered
  to write a standalone script for this; deferred by the requester, not yet done.
- **Not verified:** whether the OAuth scopes currently requested in `oauth.ts`'s `GHL_SCOPES`
  actually cover the `v3` custom-fields endpoints — they predate this work and were never
  revisited. If live testing shows a 401/403 specifically on the custom-fields calls, check
  this first.

## 8. Follow-up closed: `PaymentRow.method`

Originally flagged here as a known gap blocking the frontend from building the BACS/cheque
reconciliation UI (`PATCH /payments/:id/status`, §4) — the customer-detail endpoint's
`PaymentRow` exposed a `paymentId` but not the payment's `method`, so the frontend had no way
to know which rows were eligible for the new endpoint without calling it and reading a 409.

**Fixed same day.** `services/customer.service.ts`: added `method: PaymentMethod | null` to
the `PaymentRow` interface and to the row-mapping (`v.payment?.method ?? null`). No query
change needed — `payment: true` on the `visits` include (line ~497) already fetched the full
`Payment` row including `method`; it just wasn't being copied into the view model. Test added:
`getCustomerDetail includes the payment method on each payments.rows entry`
(`customer.service.test.ts`) — asserts a `BACS` payment's row carries `method: "BACS"` and a
visit with no payment carries `method: null`.

The debt board (`debt.service.ts`) still doesn't expose a `paymentId` at all (it operates on
invoices, not payments) — out of scope here, wasn't asked for, and the frontend handoff's
guidance was always "use the customer-detail payment history," not the debt board.
