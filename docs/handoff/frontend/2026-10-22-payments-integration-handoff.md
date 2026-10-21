# Payments Hardening — Frontend Integration Handoff

**Date:** 2026-10-22
**Audience:** frontend developer integrating the Settings → Payment screens (Stripe / GoCardless connect flows).

This covers backend changes to how Stripe and GoCardless webhooks are wired up. **One UI
element needs removing, one new field needs adding.** Everything else about checkout/invoicing/
debt payment links is unchanged — skip to the end if you just want the "nothing to do" list.

---

## Action required #1 — remove the "copy this Stripe webhook URL" UI

### What changed and why
Previously, after a tenant admin connected Stripe (`GET /settings/stripe/authorize` →
Stripe's consent screen → `GET /settings/stripe/callback`), the callback redirect carried a
`webhookUrl` query param that the frontend was expected to display so the admin could copy it
into their own Stripe dashboard. **That flow never actually worked** — the secret RoundFlow
generated for it didn't match what Stripe would actually sign events with, so even a diligent
admin following the instructions would've ended up with webhooks that silently failed
signature verification forever.

Stripe webhook delivery is now fully automatic — one platform-level webhook (set up once, by
us, not per tenant) receives every connected account's events automatically. **There is
nothing left for the tenant admin to configure for Stripe webhooks**, and nothing for you to
display.

### What to change
**Endpoint:** `GET /settings/stripe/callback` (Stripe redirects here itself after OAuth
consent — the frontend doesn't call this directly, but it does read the redirect it lands on
afterward).

**Before:**
```
.../settings/integrations?stripe=connected&webhookUrl=https%3A%2F%2Fapi...%2Fwebhooks%2Fstripe%3FtenantId%3D...%26secret%3D...
```
**After:**
```
.../settings/integrations?stripe=connected
```
Remove any code that reads `webhookUrl` from this redirect and remove the "copy this URL into
your Stripe dashboard" UI element entirely (instructions, copy-to-clipboard button, whatever
form it took). If your Settings → Payment screen had a "webhook configured ✓ / ⚠ not
configured" indicator driven by that URL being present, it can be deleted — Stripe connection
status is still just `GET /settings/payment`'s `stripeConnected: boolean`, unchanged.

No other part of the Stripe connect flow changes: `GET /settings/stripe/authorize` (redirect
to Stripe) and `POST /settings/stripe/disconnect` (body: none, response:
`{ "status": "disconnected" }`) are both unchanged in request/response shape.

---

## Action required #2 — add a "paste your GoCardless webhook secret" field

### What changed and why
GoCardless has no API to create webhook endpoints (confirmed from their own docs — it's
dashboard-only), so unlike Stripe, the admin **does** still need to manually create a webhook
endpoint in their own GoCardless dashboard. What changed is that RoundFlow now needs the *real*
secret GoCardless generates when they do that — previously RoundFlow invented its own secret
and used it incorrectly, which meant GoCardless webhooks had the same "never actually verifies"
problem Stripe had. This endpoint lets the admin feed the real one in.

### The flow your UI needs to support
1. Admin fills in their GoCardless access token + environment, calls (existing, unchanged):
   ```
   POST /settings/payment/gocardless/connect
   Body: { "accessToken": "...", "environment": "sandbox" | "live" }
   Response: { "status": "connected", "webhookUrl": "https://api.../webhooks/gocardless?tenantId=...&secret=..." }
   ```
2. **Show `webhookUrl` to the admin with instructions**, e.g.:
   > "Go to your GoCardless dashboard → Developers → Webhooks → Add endpoint. Paste the URL
   > below. GoCardless will show you a webhook secret when you save it — copy that secret and
   > paste it into the field below."

   (This part — showing the URL and the instructions — is unchanged from before; what's new is
   step 3.)
3. **New step — new field, new endpoint:**
   ```
   PATCH /settings/payment/gocardless/webhook-secret
   Body: { "secret": "<the secret GoCardless showed them>" }
   Response (200): { "status": "saved" }
   Response (409): { "error": "GoCardless is not connected for this account" }
   Response (400): { "error": "\"secret\" is required and must be a non-empty string." }
   ```
   Add a text input + save button for this, shown alongside (or right after) the webhook URL
   display from step 2. Until this is submitted, GoCardless webhooks for that tenant silently
   no-op (payments/mandates won't auto-update from real GoCardless events) — so it's worth
   making this step visually obvious as part of "finish connecting GoCardless," not an optional
   extra.

`POST /settings/payment/gocardless/disconnect` is unchanged in request/response shape
(`{ "status": "disconnected" }`) but now also clears the saved signing secret server-side, so
reconnecting correctly requires repeating step 3 — no frontend change needed for that, just
worth knowing if you see a stale "webhook secret saved" state that needs clearing in your own
local UI state on disconnect.

---

## Everything else — no action needed

- `GET /settings/payment` — unchanged: `{ providers: { gocardless: {...}, stripe: {...} }, rules: {...} }` shape, same `gocardlessConnected`/`stripeConnected` booleans.
- `PATCH /settings/payment` (payment rules: `paymentRule`, `vatInInvoices`, `debtHoldEnabled`, `debtHoldMaxInvoices`, `debtHoldMaxAmount`) — unchanged.
- `POST /payments/stripe/checkout`, `POST /payments/stripe/setup` — unchanged request/response.
- `POST /customers/:id/mandate`, `POST /customers/:id/mandate/complete` — unchanged.
- `POST /debt/:id/payment-link` — unchanged; still falls back to the static `pay.roundflow.app` link if Stripe isn't connected, still returns a real Stripe-hosted checkout URL otherwise.
- Invoice creation/preview/PDF/send endpoints (`/invoices/...`) — unchanged.
- Everything about how a customer actually pays (Stripe Checkout redirect, GoCardless mandate redirect flow) — unchanged. Only the *backend's* webhook plumbing changed; nothing about the hosted pages your users get redirected to is different.

If you're not actively working on the Settings → Payment / Integrations screen, there is
nothing in this handoff that affects you.
