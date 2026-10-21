# Payments Hardening — Backend Handoff

**Date:** 2026-10-22
**Audience:** another backend engineer picking this up cold — this is the decision record, not just a changelog.

---

## 1. Why this work happened

The task started as "audit the payment setup and make it a working, test-driven setup with
100% line/branch/statement coverage." The codebase already had a substantial Stripe Connect +
GoCardless Direct Debit implementation (tenants collecting money from their own customers —
RoundFlow billing tenants for the SaaS itself was explicitly ruled out of scope by the
requester and does not exist anywhere in this codebase). The audit found:

- **Zero tests** touched any payment file — not `payments.ts`, either webhook router, the
  GoCardless mandate routes, or the Stripe/GoCardless connect routes in `settings.ts`.
- **No coverage tooling installed at all** — `vitest.config.ts` had no `coverage` block,
  `@vitest/coverage-v8` wasn't a dependency.
- Two things that looked fine on casual reading were **actually broken**, discovered while
  explaining the webhook flow to the requester in detail (see §3).

## 2. Scope decision

**Decision:** harden and test the existing tenant-collects-from-customer flows (Stripe
Checkout, GoCardless Direct Debit). Do not build RoundFlow→tenant SaaS subscription billing.

**Why:** the requester confirmed this explicitly after I flagged the ambiguity — "per-tenant
payment" could have meant either direction, and the existing code is 100% the former. Building
subscription billing (Stripe Billing, plan tiers, platform-level customers) would have been a
from-scratch feature, not a hardening task, and wasn't what was wanted.

## 3. The two real bugs found (not just "untested")

### 3a. Idempotency: the `webhookEvent.create` catch-all

**What was wrong:** both `stripeWebhook.ts` and `gocardlessWebhook.ts` had:
```ts
try {
  await tp.webhookEvent.create({ data: { source: "stripe", externalId: event.id } });
} catch {
  res.sendStatus(200); // "already processed"
  return;
}
```
This treats *any* error from the insert — not just a genuine unique-constraint violation on
`(source, externalId)` — as "duplicate, safe to skip, ack 200." A transient DB error (dropped
connection, timeout) would be silently swallowed, acked as 200, and the event lost forever —
Stripe/GoCardless stop retrying once they get a 2xx.

**Fix:** narrow the catch to Prisma's actual unique-constraint error code:
```ts
catch (err) {
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
    res.sendStatus(200);
    return;
  }
  console.error(...);
  res.sendStatus(500); // Stripe/GoCardless get a chance to retry
  return;
}
```
Applied identically in both webhook handlers. `Prisma` is imported from
`../generated/tenant-client` (the tenant-schema client, matching where `webhookEvent` lives) —
same pattern already used in `technician.service.ts` and `src/index.ts`, so this wasn't a new
convention.

### 3b. Webhook secret mismatch — webhooks never actually verified

**What was wrong:** when a tenant connected Stripe or GoCardless, the connect routes in
`settings.ts` generated their own random string (`randomBytes(32)`) and stored it as the
"webhook secret" used later for HMAC signature verification. But Stripe and GoCardless
generate and own that secret themselves — it's assigned when a webhook endpoint is created
(via their dashboard or, for Stripe, via API) and shown once to whoever created it. A
self-invented value can never match what the provider actually signs with. **Even a tenant
admin who did every manual step correctly would see signature verification fail on every
single event, forever** — there was no field anywhere to feed the real secret back in. This
means webhook-driven status updates (marking invoices PAID, recording failed payments) could
never have worked via a real webhook delivery, independent of whether anyone remembered to
register one.

I found this by walking the requester through "what exactly happens when you click Connect"
and realizing the stored secret had no relationship to anything Stripe/GoCardless would ever
actually sign with.

**Fix — different per provider, because their capabilities differ:**

**Stripe → platform-level Connect webhook.** I verified via web search that Stripe's
documented pattern for Standard Connect platforms is exactly this: one webhook endpoint,
created once in the *platform's own* Stripe account with `connect: true`, which Stripe then
auto-delivers events for every connected account to, tagged by `event.account`. This is
strictly better than a per-tenant design — no manual step, no secret-mismatch bug possible,
because the platform controls and captures the one real secret itself at creation time.

**GoCardless → stays manual, but the secret capture is fixed.** I verified via web search that
GoCardless has **no API to create webhook endpoints** — Developers → Webhooks in their
dashboard is the only way, confirmed from GoCardless's own docs. There's no platform-level
aggregation point to centralize onto (this codebase uses raw per-tenant access tokens, not a
GoCardless Partner OAuth app, so each tenant's GoCardless account really is separate even at
GoCardless's level). So the manual per-tenant step is unavoidable without a much bigger
rebuild (a real Partner OAuth integration) that wasn't in scope. What's fixed: there's now a
way to capture the *real* secret GoCardless assigns, instead of RoundFlow inventing one.

**A subtlety worth remembering:** the requester initially pushed back on "centralize the
Stripe webhook," worried it meant losing per-tenant isolation. It doesn't — tenant data,
credentials, and money stay exactly as isolated as before (separate Stripe accounts, separate
`BusinessSettings` rows, separate everything). The only thing that changed is the *delivery
mechanism* for one specific class of HTTP callback. Worth being precise about this distinction
if it comes up again, since it's an easy thing to conflate.

## 4. What changed, concretely

### Schema (`prisma/schema.prisma` — public)
- `Tenant.stripeConnectAccountId String? @unique` — new. Mirrors the per-tenant value already
  stored in each tenant schema's `BusinessSettings.stripeConnectAccountId`, so the webhook
  handler can resolve `event.account → tenant` with one query against the shared schema
  instead of needing to already know which tenant schema to look in.
  Migration: `prisma/migrations/20261022000000_tenant_stripe_connect_account_id/`.

### Schema (`prisma/tenant/schema.prisma` — per-tenant)
- `BusinessSettings.stripeWebhookSecretEncrypted` — **removed**. No longer meaningful; Stripe
  signing is verified with one platform-wide secret now, not a per-tenant one.
- `BusinessSettings.gocardlessWebhookSigningSecretEncrypted String?` — new. The real secret
  GoCardless generated for the manually-created webhook endpoint, captured via the new
  `PATCH /settings/payment/gocardless/webhook-secret` endpoint. Distinct from the existing
  `gocardlessWebhookSecretEncrypted`, whose role narrowed to *only* the `?secret=` route-auth
  query-param check on the webhook URL — it is no longer used for signature verification.
  Migration: `prisma/tenant/migrations/20261022000000_payments_webhook_fix/` (applied
  automatically by the existing startup migrator, `migrateAllTenantSchemas` in
  `src/lib/tenant-provisioning.ts` — same mechanism as every other tenant-schema change here).

### `.env.example`
- Added `STRIPE_CONNECT_WEBHOOK_SECRET` — one platform-wide value, obtained once from Stripe
  Dashboard (Developers → Webhooks → Add endpoint → "Listen to events on Connected accounts")
  in RoundFlow's own Stripe account. **This must be set in every real environment** (dev/
  staging/prod) before Stripe webhooks will do anything; `src/routes/stripeWebhook.ts` 500s
  loudly (with a console.error) if it's missing, rather than silently no-op'ing.

### `src/routes/stripeWebhook.ts` — rewritten
- No more `?tenantId=X&secret=Y` query params. Mount point is still `/webhooks/stripe`
  (unchanged in `src/index.ts`), but the route is now a single fixed URL for every tenant.
- Verifies the signature with `STRIPE_CONNECT_WEBHOOK_SECRET` (platform secret from env), using
  a `getStripeClient(process.env.STRIPE_SECRET_KEY!)` instance purely to call
  `.webhooks.constructEvent()` — no tenant-specific key needed for that call.
- Reads `event.account`; looks up `prisma.tenant.findUnique({ where: { stripeConnectAccountId:
  event.account } })` on the **public** client (not a tenant client — this is the one place
  that needs to resolve tenant identity from scratch). Unknown/unlinked account → ack 200,
  no-op (e.g. a platform account event unrelated to any tenant).
- From there, resolves the tenant's own `TenantPrismaClient` via `getTenantPrismaForSchema` as
  before, and the `checkout.session.completed` / `checkout.session.expired` /
  `payment_intent.payment_failed` handling logic is otherwise **unchanged** — only the routing/
  auth layer in front of it changed.

### `src/routes/gocardlessWebhook.ts`
- Same idempotency fix (§3a).
- Signature verification now reads `gocardlessWebhookSigningSecretEncrypted` instead of
  `gocardlessWebhookSecretEncrypted`. If the signing secret hasn't been pasted in yet (admin
  hasn't completed the manual dashboard step), it acks 200 and no-ops — same shape as the
  previous "not configured" branch, just checking the right field now.
- The `?tenantId=X&secret=Y` routing mechanism is **unchanged** — that part was never the bug.

### `src/routes/settings.ts`
- `/stripe/callback`: no longer generates a webhook secret or builds a `webhookUrl` to hand
  back to the frontend. Still stores `stripeConnectAccountId` on the tenant's own
  `BusinessSettings` (unchanged), and additionally mirrors it onto the public `Tenant` row via
  `prisma.tenant.update(...)`. Redirect to the frontend is now just
  `.../settings/integrations?stripe=connected` — no extra query param.
- `/stripe/disconnect`: also clears the mirrored `Tenant.stripeConnectAccountId`.
- `/payment/gocardless/disconnect`: also clears the new
  `gocardlessWebhookSigningSecretEncrypted` field.
- New: `PATCH /settings/payment/gocardless/webhook-secret` — accepts `{ secret }`, 409s if
  GoCardless isn't connected yet, otherwise encrypts and stores it. Same middleware chain and
  `assertSetupComplete()` guard as its siblings.

### `src/routes/payments.ts`
- Pure refactor, no behavior change: moved the module-level
  `const FRONTEND_URL = process.env.FRONTEND_URL?.split(",")[0].trim() ?? "";` into a
  `frontendUrl()` helper called inside each handler, matching the pattern `debt.ts` already
  used. This was done purely for testability — a module-level constant captured at import time
  can only be tested by resetting the module registry and re-importing, which is awkward and,
  in practice, was the one branch I couldn't get v8 coverage to register reliably across
  re-imports. Computing it per-request is simpler, more consistent with the rest of the
  codebase, and trivially testable with a normal per-request test. No functional difference.

## 5. Test coverage — what's gated and why

Two tiers, matching the "payment-related code only" scope decision:

**Group A — gated at 100% line/branch/function/statement, enforced via `vitest.config.ts`'s
`coverage.thresholds` (`{ 100: true, perFile: true }`) scoped to `coverage.include`:**
`routes/payments.ts`, `routes/stripeWebhook.ts`, `routes/gocardlessWebhook.ts`,
`routes/invoices.ts`, `routes/debt.ts`, `integrations/stripe/{client,checkout,oauth}.ts`,
`integrations/gocardless/{client,mandate,payment}.ts`, `services/invoice.service.ts`,
`services/debt.service.ts` (already at 100% from pre-existing tests — no changes needed),
`lib/crypto.ts`.

**Group B — payment-specific routes/branches inside larger, mixed-purpose files. Thoroughly
tested, but the file as a whole is deliberately *not* threshold-gated:** the payment sub-routes
in `routes/settings.ts`, the mandate routes in `routes/customers.ts`, the payment-method branch
in `routes/visits.ts`'s `PATCH /:id/complete`, `services/settings.service.ts`'s
`updatePaymentRules`, `services/setup.service.ts`'s `getPaymentSetup`/`savePaymentSetup`.

**Why the split:** gating a whole shared file at 100% would force testing large amounts of
unrelated, currently-untested code (customer CRUD, visit scheduling, business profile, etc.) —
explicitly out of scope per "payment-related code only." This was floated as a question to the
requester (merge B into A vs. split out dedicated payment files vs. keep as-is) and the answer
was to keep the split as originally proposed.

**Mocking conventions — matched exactly to what already existed in the repo, not invented:**
- Route tests: supertest + a minimal express app, `requireAuth`/`requireTenantAccess`/
  `requireBusinessAccess` mocked as pass-throughs, `req.tenantPrisma` a hand-built object of
  `vi.fn()`s per Prisma model. This is the exact shape `setup.route.test.ts` already used.
- Service tests: a `makePrisma()` factory returning `vi.fn()`s, matching
  `invoice.service.test.ts` / `debt.service.test.ts` / `settings.service.test.ts`.
- Integration-layer functions that take their SDK client as a parameter (`checkout.ts`'s
  `createOneTimeSession`/`createSetupSession`, GoCardless's `mandate.ts`/`payment.ts`) are
  tested by passing a hand-built fake client object — no module mocking needed, since the
  functions were already written with dependency injection.
- `getGcClient`/`getStripeClient` themselves (which construct the real SDK client) are tested
  by mocking the `stripe` / `gocardless-nodejs` packages directly.
- `src/lib/crypto.ts` is tested for real (no mocking) — a fixed 64-hex-char test key is set via
  the new `src/test/env.setup.ts` (wired through `vitest.config.ts`'s `setupFiles`).

**A coverage-tooling gotcha worth remembering:** V8/istanbul branch coverage for a
module-level constant captured once at import time (e.g. the old `FRONTEND_URL` in
`payments.ts`) doesn't reliably re-register when you `vi.resetModules()` + dynamically
re-`import()` the same file to exercise the "env var unset" branch — at least not in a way I
could get to show up in the coverage report here. Where this came up, the actual fix was to
move the env read inside the handler (§4, `payments.ts`), not to fight the tooling. `src/lib/
crypto.ts`'s `getKey()` is the counter-example that *does* work this way reliably — because
`KEY_HEX` there is read inside a **function body**, not merely captured once at module scope
into a value that's never re-read; the resetModules dance works for re-exercising a function's
internal branches across fresh module instances, just not for a plain top-level `const`
assignment's own branch.

## 6. Follow-up fix: the `?secret=` route token was never actually checked

Originally flagged here as a known-but-not-fixed issue, then fixed on request:
`gocardlessWebhook.ts`'s `?secret=` query-param check only verified the param was *present*
(truthy) — never that it matched the stored per-tenant route token. Any non-empty string in
`?secret=` passed, for any tenant whose id you could guess (cuids, not trivially guessable, but
still an unnecessary gap — this token exists specifically to gate the route).

**Fix:** added `safeEqual(a, b)` to `src/lib/crypto.ts` — a constant-time string comparison
(`crypto.timingSafeEqual`, with an explicit length check first since `timingSafeEqual` throws
on mismatched buffer lengths rather than just returning `false`). A plain `===` here would leak
timing information proportional to how many leading bytes match, letting an attacker recover
the token byte-by-byte; `safeEqual` closes that.

`gocardlessWebhook.ts` now decrypts the stored `gocardlessWebhookSecretEncrypted` and compares
it against the query `secret` with `safeEqual` right after confirming it's present, before
doing anything else — a mismatch acks 200 and no-ops, same "fail quietly" shape as every other
not-for-this-request branch in that handler (unknown tenant, no secret stored, no signing
secret yet), so this endpoint still doesn't let a prober distinguish "wrong secret" from
"tenant doesn't exist" by status code.

Tests added: `safeEqual` unit tests in `crypto.test.ts` (equal, different, different-length,
both-empty), and a new case in `gocardlessWebhook.route.test.ts` asserting a mismatched
`?secret=` 200s without ever calling `parse()` (i.e. never reaches signature verification).
Existing tests had to switch their mocked `decrypt` from a wrapping fake
(`` `decrypted(${v})` ``) to an identity function, since the route token now also flows through
`decrypt()` for the comparison — every fixture's `gocardlessWebhookSecretEncrypted` was updated
to equal the query string's `secret` value they already used (`"abc"`) so the existing tests
keep exercising the same downstream branches they always did, rather than short-circuiting one
step earlier at the new check.

## 7. Verification performed

- `npm run test:coverage` — 561 tests, 100% line/branch/function/statement on every Group A
  file (enforced by the threshold config, not just eyeballed).
- `npm test` — full suite green, no regressions to pre-existing coverage elsewhere.
- `npx tsc --noEmit` — clean. (Two categories of new-test-only TS errors had to be fixed along
  the way: relative dynamic `import()` calls need explicit `.js` extensions under this repo's
  `moduleResolution`, and several `vi.fn()` mocks needed an explicit variadic parameter
  signature — e.g. `vi.fn((..._args: unknown[]) => ...)` instead of `vi.fn(() => ...)` — before
  they could be safely wrapped and spread-called elsewhere in a mock factory.)
- `npm run test:live` with no credentials set — both live-suite files report skipped, exit 0.
