# Wave 2B-1 API contract for web and app (2026-11-06 / 07)

For the web (`roundflow-frontend`) and technician app (`roundflow-app`). Backend detail: `docs/handoff/backend/2026-11-06-wave2b1-backend.md`. The four new tenant migrations are **not applied**; the new payment statuses and behaviours appear only after the backend deploys with its migrations. Regenerate `src/api/types.gen.ts` in both repos from `/openapi.json` after the deploy (new paths, `Idempotency-Key` parameter, 413/429 responses, `requestId` and `fields` on `Error`, three new `PaymentStatus` values).

## 1. Breaking or behaviour changes (read first)

| # | Change | Who | What to do |
|---|---|---|---|
| 1 | **A MANAGER now gets `403 ADMIN_ONLY`** on: inviting an ADMIN (`POST /invites` with `role: "ADMIN"`), connecting or disconnecting Stripe, GoCardless or GoHighLevel (`/settings/stripe/*`, `/settings/payment/gocardless/*`, `/settings/ghl/authorize|test|connect-private|disconnect`), `PATCH /settings/payment`, `PATCH /settings/business-profile` when the body contains `bankDetails`, `vatRegistered`, `vatRegistration` or `vatRate`, `DELETE /settings/technicians/{id}`, and the new `/integrations/outbox*` routes. Reads (including `GET /settings/payment` and `GET /settings/ghl/status`) still work for a MANAGER. | web | Hide or disable those controls for MANAGER (the profile role is on `GET /auth/me`), and show the 403 message when a stale UI still sends one. Do not retry. |
| 2 | **`PaymentStatus` has three new values: `PROCESSING`, `REFUNDED`, `DISPUTED`.** `GET /payments?status=` and the CSV export accept and return them. | web | Add badges: `PROCESSING` = "Collecting" (neutral/amber; a GoCardless direct debit the bank has accepted, NOT paid), `REFUNDED` = "Refunded", `DISPUTED` = "Disputed" (red). Unknown future values should fall back to a plain label, not crash. |
| 3 | GoCardless `confirmed` no longer means paid. The payment shows `PROCESSING` until the `paid_out` event. Invoices whose direct debit is `PENDING` or `PROCESSING` are **no longer counted as debt**: they drop out of the Debt board, its KPIs, the mobile debt gate and the hold auto-release until the debit fails or is cancelled. | web, app | Expect smaller debt numbers for direct-debit customers; no UI change needed. A visit that was blocked by the debt gate because of a pending debit now starts. |
| 4 | **Invoice status after refund or dispute**: a fully refunded payment turns its invoice `VOID`; a disputed payment reopens its invoice to `SENT` (it reappears in Debt); a won dispute settles it `PAID` again; a lost dispute leaves it `SENT`. A partial Stripe refund changes nothing but notifies the office. | web | Be ready for an invoice to move from PAID back to SENT or to VOID after the fact; refetch on focus. |
| 5 | **`PATCH /payments/{id}/status`** (manual BACS/cheque) now answers `409 INVALID_PAYMENT_TRANSITION` for an illegal move (for example FAILED on a CANCELLED payment). `POST /invoices/{id}/mark-paid` can answer `409 PAYMENT_NOT_SETTLEABLE` (payment is DISPUTED or REFUNDED) and `409 PAYMENT_CHANGED`. | web | Show the message; offer a refresh. |
| 6 | **429 `RATE_LIMITED`** with a `Retry-After` header (seconds). Limits per IP: 600/min overall, 10/hour on `POST /auth/signup`, 20/min on the public invite lookup (`GET /invites/{token}`) and accept. | web, app | Honour `Retry-After`: show "Too many attempts, try again in N seconds" on signup/invite screens; the app queue must retry 429 (it already does for 408/425/429/5xx) and respect the header. Never loop immediately. |
| 7 | **Mobile idempotency**: a request whose `X-Idempotency-Key` is still being processed by the first request gets `409 IDEMPOTENCY_IN_PROGRESS` with `Retry-After: 1` (before, both executed). | app | Treat this 409 as "already in flight": do not discard the queued action as a conflict; wait and retry (the retry replays the stored result with `Idempotent-Replay: true`) or drop it only after the first attempt is confirmed. Other idempotency codes are unchanged. |
| 8 | Every response has an `X-Request-Id` header and every error body produced by the server has a `requestId`. | web, app | Include it in "something went wrong" screens and bug reports. `Error` also has an optional `fields: [{ path, code, message }]` for field-level validation messages (new validators only; old endpoints keep their shapes). |
| 9 | Oversized JSON body: `413 PAYLOAD_TOO_LARGE` (limit 100 kb) instead of a 500. | web | Show "That request is too large". The CSV/bulk import screens should chunk. |
| 10 | **Push notifications** carry `data.type` (the notification type) and an Android `channelId`: `schedule` (SCHEDULE, ROUND_UPDATE, DAY_CLOSED), `chat`, `payments`, `alerts` (everything else). New notification type `INTEGRATION` (office only: "Integration message failed"). | app, web | Create the four Android notification channels at start-up with exactly these ids (a push naming an unknown channel falls back to the default channel). Use `data.type` plus the existing deep-link fields to route a tap. Add `INTEGRATION` to the web notification centre's type icons. |
| 11 | The supplier VAT number on the invoice (preview, PDF) prints only when the business is VAT registered **and** a number is stored. | web | None; the Settings VAT toggle now controls it. |
| 12 | `GET /health/ready` now returns `{ status: "ready" \| "degraded", failedTenantMigrations: number }`, or 503 `{ status: "database_unavailable" }`. | ops | Monitoring may alert on `degraded`. |

## 2. New and changed error codes

| Code | Status | Endpoint | Show |
|---|---|---|---|
| `ADMIN_ONLY` | 403 | see 1.1 | "Only an administrator can do this." |
| `RATE_LIMITED` | 429 | any (strict on signup, invites, webhooks) | "Too many requests. Try again in N seconds." (`Retry-After`) |
| `PAYLOAD_TOO_LARGE` | 413 | any JSON body | "That request is too large." |
| `IDEMPOTENCY_IN_PROGRESS` | 409 | mobile visit writes, admin writes with `Idempotency-Key` | not user-facing: wait `Retry-After` and retry with the same key |
| `INVALID_PAYMENT_TRANSITION` | 409 | `PATCH /payments/{id}/status` | "This payment cannot be changed from its current state." |
| `PAYMENT_NOT_SETTLEABLE` | 409 | `POST /invoices/{id}/mark-paid` | "This payment is disputed or refunded and cannot be marked paid." |
| `PAYMENT_CHANGED` | 409 | `POST /invoices/{id}/mark-paid` | "The payment changed while you were saving. Reload and try again." |
| `INVOICE_ALREADY_PAID` / `INVOICE_VOID` | 409 | `POST /invoices/{id}/mark-paid` | now also returned when another click or a webhook won the race; same wording as before |
| `INVALID_STATUS` | 400 | `GET /integrations/outbox` | developer error |
| `OUTBOX_NOT_FOUND` / `OUTBOX_NOT_REPLAYABLE` | 404 / 409 | `POST /integrations/outbox/{id}/replay` | "That message was not found." / "Only failed messages can be retried." |
| `VALIDATION_FAILED` | 400 | (foundation only) | when present, show each entry of `fields` next to its input (`path`) |

## 3. New endpoints and headers

### 3.1 Idempotency-Key on admin writes (optional)

Send `Idempotency-Key: <uuid>` (1 to 200 chars) on `POST /invoices`, `POST /customers`, `POST /payments/stripe/checkout` and every `POST /messages/*` (send, bulk, inbox read). Generate one key per user action (per click), reuse it for any automatic retry of that same action. A repeat returns the stored result with `Idempotent-Replay: true` and does not run twice; a concurrent duplicate gets `409 IDEMPOTENCY_IN_PROGRESS` + `Retry-After: 1`. Only 2xx responses are stored; after a 4xx/5xx fix the request and reuse the key. Keys are scoped to the signed-in user and kept 7 days. Recommended for: the Create invoice button, the Pay by card link button, "Send message", "Message round" and new-customer submit. `POST /payments/stripe/checkout` also no longer returns a stale (expired) session URL.

### 3.2 Integration dead letters (ADMIN only)

- `GET /integrations/outbox?status=dead|failed&page=1&pageSize=50` returns `{ rows: [{ id, eventType, status, attempts, lastError, customerId, batchId, createdAt, processedAt }], pagination }`, newest first. Default `status=dead`.
- `POST /integrations/outbox/{id}/replay` returns `{ id, status: "pending" }`; the next worker run (every 30 s) retries it with a fresh attempt budget.
- Suggested UI: Settings > Integrations > "Failed messages" table with a Retry button (ADMIN only), linked from the `INTEGRATION` notification. Events now retry for about 7.7 hours (30 s, 2 min, 10 min, 1 h, 6 h) before going dead, and an unknown event type goes dead immediately instead of being reported as sent. Bulk invoice send results (`GET /invoices/bulk-send/{batchId}`) keep reporting dead rows as `FAILED`.

## 4. Field and shape changes

| Where | Change |
|---|---|
| `PaymentStatus` | + `PROCESSING`, `REFUNDED`, `DISPUTED` (see 1.2) |
| `Error` | + `requestId` (string), + optional `fields` array |
| `GET /health/ready` | see 1.12 |
| `POST /payments/stripe/checkout` | unchanged body; optional `Idempotency-Key` header |
| `GET /payments` row `status` | may be any of the nine values |

## 5. Nightly OVERDUE (informational)

A nightly job (04:00 UTC) sets a payment's `status` to `OVERDUE` when it is unsettled (not a direct debit) and its invoice is past due. It sends no reminders and does not change the invoice (the invoice list's derived `overdue` flag is unchanged). Show `OVERDUE` as a status badge in the Payments list; Debt screens already derive overdue from the invoice.

## 6. Deferred (do not build UI for these yet)

Credit notes, part payments, an automatic dunning cadence and failed-payment retry rules; bank-transfer reconciliation and payment links (out of scope by decision).
