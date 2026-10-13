# RoundFlow — Backend Response to "What the Frontend Needs From the Backend"

**Date:** 2026-10-13
**Re:** the 2026-10-07 frontend doc (4 missing backend features + Part-B dead controls)
**From:** Backend
**Status of this work:** built, unit-tested, and **deployed to dev** (`api-dev.roundflow.ai`). **Not on QA or prod yet.**

> Verification note: each endpoint below is confirmed **deployed and routed** on dev
> (returns `401` unauthenticated — a missing route would `404`) and is covered by unit
> tests. They have **not** yet been exercised end-to-end with live authenticated data
> (the dev tenant is empty), and the **frontend buttons are not yet wired** to them
> (confirmed: Reports → Export still fires no request). Wiring is the frontend's step.

---

## Summary

| # | Feature | Backend status |
|---|---|---|
| 1 | Customer messaging (SMS/WhatsApp/email) | ✅ Shipped (send + bulk). Scheduling = GHL handoff, not an endpoint. |
| 2 | Invoice PDF (download + print) | ✅ Shipped — **saved invoice and preview**. |
| 3 | Payment provider connect | ⚠️ Stripe OAuth **already existed**; blocked on having provider accounts, not on code. |
| 4 | Reports export | ✅ Shipped. |
| B | Part-B "frontend-only" controls | ✅ Added a **per-user preferences store** so their state can persist. |

Two corrections to the original doc up front:
- **SMS Templates are not a stub** — `GET/POST/PATCH/DELETE /settings/message-templates` is a real DB-backed CRUD and always has been. (It's `PATCH`, not `PUT`.)
- **Stripe connect is not a stub** — a full Stripe Connect OAuth flow already exists server-side.

---

## 1. Customer messaging

```
POST /messages/send
  body: { propertyId?: string, customerId?: string, channel: "sms"|"email"|"whatsapp", body: string }
  → 201 { status: "sent" }
  errors: 400 (bad/missing channel, or neither id), 404 (property/customer not found),
          409 (GoHighLevel not connected)

POST /messages/bulk          # a whole round, send-now
  body: { roundId: string, channel: "sms"|"email"|"whatsapp", body: string, excludePaymentHold?: boolean }
  → 201 { queued: number }   # recipients it was actually sent to (deduped by customer)
  errors: 400 (bad channel), 409 (GoHighLevel not connected)
```

- Sends via the existing GHL integration (same path complaint replies use); auto-creates the GHL contact if missing.
- **Bulk is send-now only.** `excludePaymentHold` drops customers whose round properties all have a payment-hold visit.
- **Scheduling (`sendAt`) is deliberately not built** — scheduled/drip sends are a **GHL workflow handoff** (tag the round's contacts; a GHL workflow fires on the tag). No backend scheduler.
- Unblocks: Bulk Message modal, Message Customers modal, Property-detail Send message, Weather-Hold "notify customers", and the Pause-Service "notify via SMS" toggle (wire the toggle to `/messages/send`).
- **SMS Templates panel** is unblocked already — use `GET/POST/PATCH/DELETE /settings/message-templates`.

## 2. Invoice PDF — download & print

```
GET /invoices/:id/pdf               → application/pdf   (a SAVED invoice; inline)
GET /invoices/preview/pdf?visitId=  → application/pdf   (a PREVIEW/quote, before the invoice is created)
```

- Both render HTML → PDF via a self-hosted Gotenberg service.
- **Download PDF**: fetch the bytes (with the auth header) and save as a Blob. **Print**: open the Blob in a print view.
- `SavedInvoiceModal` → use `/invoices/:id/pdf`. `InvoicePreviewModal` (before the invoice exists) → use `/invoices/preview/pdf?visitId=`.
- Note: **Send** (`POST /invoices/:id/send`) is wired, but its actual delivery is itself still stubbed server-side (it flips status to `SENT`; no email goes out yet) — separate from PDF.

## 3. Payment provider connect

No new backend was needed; the reality differs from the doc:
- **Stripe — real OAuth already exists.** Redirect the browser to **`GET /settings/stripe/authorize`** (it 302s to Stripe), and the callback returns to `${FRONTEND_URL}/settings/integrations?stripe=connected`. Works as soon as a **Stripe platform account + `STRIPE_CLIENT_ID`/`STRIPE_SECRET_KEY`** are configured.
- **GoCardless** — `POST /settings/payment/gocardless/connect` takes `{ accessToken, environment }`, validates it against GoCardless, stores it. (Token-based, not an OAuth redirect — no `connectUrl`.)
- **Setup-wizard step 2** connect toggles remain Phase-1 boolean stubs by design.
- **Blocker is external accounts, not code.** When you have the Stripe account, it's an env-var config.

## 4. Reports export

```
GET /reports/export?type=visits|technicians|revenue&period=last30&status=  → text/csv
```
- `type` defaults to `visits`; honors `period` and (for `visits`) `status`. Streams a CSV download.

---

## Part B — the "frontend-only" controls

These stay frontend-owned, but several wanted **state that persists per user across sessions**, and no such store existed. Added one:

```
GET   /auth/me/preferences                     → { preferences: { ... } }   # {} if never set
PATCH /auth/me/preferences   { anyKey: value } → { preferences: { ...merged } }  # shallow-merge, 100KB cap
```
- Free-form JSON bag, keyed to the logged-in user. GET on load; PATCH one key when a toggle changes.
- Use it for: **Login "Remember me"** (if you want it server-side rather than the Supabase client), **Debt "Select all"** view prefs, **Pause-Service "Notify via SMS"** default, **Technician Photos/Conversation filters**.
- The debt "Select all" + the actual *action* on a selection still needs a bulk endpoint (today all debt actions are single-id: `/debt/:id/remind` etc.) — say the word if you want a bulk variant.

---

## Frontend action required

The endpoints exist; the buttons still need to **call** them. Confirmed on dev: clicking **Reports → Export** currently fires no request to `/reports/export` — it's still the old toast stub. Same applies to the messaging/PDF buttons. "The frontend will match whatever you ship" — this is that step.

## Not done yet (by decision)
- **QA / prod rollout** — everything is dev-only. Prod deploys via ECS and needs a Gotenberg **sidecar in the task definition** (the dev/qa `docker run` Gotenberg wiring doesn't apply there).
- **OpenAPI/Swagger** entries for the new routes — not added (routes still work).
