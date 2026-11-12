# Wave 2B-1 backend handoff (2026-11-06 / 07)

Scope: plan Phase 1, money correctness and security: BE-01, BE-03, BE-07, BE-08 (limited), BE-09, BE-12, BE-13 (partial), BE-17, BE-18, BE-19, BE-27, ACT-05..08 (webhook and state-machine hardening only; no new bank-transfer reconciliation or payment-link work), from `docs/GAP_ANALYSIS_AND_REMEDIATION_PLAN_2026-11-06.md`. Frontend and app consequences, breaking changes first: `docs/handoff/frontend/2026-11-06-wave2b1-frontend-contract.md`. All work is **uncommitted**. **Nothing was applied to any database**, the server was never started, no backfill or live test was run; every test mocks its dependencies (`src/test/env.setup.ts` still forces a dead DB URL).

## 1. Migrations (NOT applied; they go out with the normal deploy, startup runs `migrateAllTenantSchemas`)

All four are additive or relaxing and idempotent. Code that reads or writes the new columns fails on an un-migrated tenant, so migrate before or with this release.

| Folder (`prisma/tenant/migrations/`) | Change |
|---|---|
| `20261107100000_payment_status_unique_ids` | `PaymentStatus` + `PROCESSING`, `REFUNDED`, `DISPUTED`; unique indexes on `Payment.stripeId` and `Payment.gocardlessId`, each created only if that tenant has no duplicate (otherwise a `NOTICE`, no failure, nothing deleted; clean up and re-run the statement). |
| `20261107100100_webhook_event_status` | `WebhookEvent.status` (default `DONE`), `attempts`, `lastError`, `payload`, `updatedAt`, index `(status, updatedAt)`. |
| `20261107100200_idempotency_inflight` | `IdempotencyRecord`: `technicianId`, `responseStatus`, `responseBody` nullable; new `actorId`, `state` (default `DONE`). |
| `20261107100300_customer_ghl_contact_unique` | Unique index on `Customer.ghlContactId`, guarded against existing duplicates (same NOTICE behaviour). |

`ALTER TYPE ... ADD VALUE` runs inside the migrator's per-migration transaction (precedent: the Stripe and mobile-issue-types migrations); the new values are not used in the same migration. `npm run prisma:generate` was run (safe, no DB). Rollback: code that does not know the new columns ignores them; the unique indexes can be dropped; the enum values cannot be removed but are harmless.

Check before deploy: `SELECT "stripeId", count(*) FROM "Payment" WHERE "stripeId" IS NOT NULL GROUP BY 1 HAVING count(*) > 1;` (same for `gocardlessId` and `Customer.ghlContactId`) per tenant schema. A skipped index is logged as a NOTICE and the code still works (it also catches `P2002` where the index exists).

## 2. New dependencies and environment variables

`npm install helmet express-rate-limit` succeeded (helmet 8.x, express-rate-limit 8.x, in `package.json` and the lockfile); no in-house fallback was needed.

| Var | Default | Meaning |
|---|---|---|
| `RATE_LIMIT_DISABLED` | unset | `true` turns every limiter off. |
| `RATE_LIMIT_GLOBAL_PER_MIN` | 600 | Requests per IP per minute across the API (`/health*` exempt, webhooks have their own limiter). |
| `RATE_LIMIT_SIGNUP_PER_HOUR` | 10 | `POST /auth/signup` per IP per hour. |
| `RATE_LIMIT_INVITE_PER_MIN` | 20 | `GET /invites/{token}` and `POST /invites/{token}/accept` per IP per minute. |
| `RATE_LIMIT_WEBHOOK_PER_MIN` | 300 | Per IP per minute, separate counter per source (stripe, gocardless, ghl). |
| `TRUST_PROXY` | 1 in production, off elsewhere | Proxy hops in front of the API. **Check this against the real deployment**: wrong value = every client shares the proxy IP (limits fire too early) or the header can be spoofed. |
| `JSON_BODY_LIMIT` | `100kb` | Larger JSON bodies get 413 `PAYLOAD_TOO_LARGE`. |
| `OUTBOUND_TIMEOUT_MS` | 15000 (min 1000) | Timeout of GHL, Expo push, Supabase email/storage calls; PDF render fixed at 60 s. |

All are in `.env.example` and `OPTIONAL_ENV_VARS` (`src/lib/env-check.ts`). Rate-limit counters are per process; with several instances the effective limit is multiplied (shared counters are Wave 2 scale-out work).

## 3. BE-01 authorisation

Decision: a MANAGER cannot invite or promote ADMINs, cannot connect or disconnect Stripe, GoCardless or GHL, cannot change payment, bank or VAT settings, cannot delete technicians. Everything else stays ADMIN or MANAGER.

- `src/lib/permissions.ts`: the single list (`ADMIN_ONLY_ROUTES`, `ADMIN_ONLY_BUSINESS_PROFILE_FIELDS`, `assertCanInviteRole`, `assertAdmin`, `adminOnlyError`). `src/middleware/requireAdmin.ts`: `requireAdmin()`, `enforceAdminOnlyRoutes()`. Refusal: `403 { error, code: "ADMIN_ONLY" }`.
- ADMIN-only routes: `PATCH /settings/payment`, `POST /settings/payment/gocardless/connect|disconnect`, `PATCH /settings/payment/gocardless/webhook-secret`, `GET /settings/stripe/authorize|callback`, `POST /settings/stripe/disconnect`, `GET /settings/ghl/authorize`, `POST /settings/ghl/test|connect-private|disconnect`, `DELETE /settings/technicians/{id}`, `GET /integrations/outbox`, `POST /integrations/outbox/{id}/replay`. `GET /settings/ghl/status`, reads of payment settings and `GET /settings/ghl/callback` (public) are unchanged.
- Conditional: `POST /invites` with `role: "ADMIN"` and `PATCH /settings/business-profile` containing `bankDetails`, `vatRegistered`, `vatRegistration` or `vatRate` are ADMIN only; a MANAGER can still invite MANAGER/TECHNICIAN and edit the other business-profile fields. There is no other role-change endpoint (technician `role` is a job title).
- Matrix test `src/__tests__/role-matrix.test.ts` + `role-matrix.data.ts`: every OpenAPI operation (246) x ADMIN, MANAGER, TECHNICIAN, anonymous through the real app; the table is explicit, so a new route fails until it is classified. It found one existing behaviour that is now recorded as intended: `POST /emergencies` is open to any tenant role (technicians report), class `TENANT_MEMBER`.
- Not changed: `/setup/step/*` stays ADMIN or MANAGER (locked once setup completes); report to the user if managers must not run the wizard.

## 4. BE-03 + BE-07 + BE-08 + ACT-06/07 payments

Full description in ARCHITECTURE_LATEST.md section 20.2 and 20.3. Summary:

- **Webhooks never lose an event.** Chosen design: process-then-ack with `WebhookEvent.status` RECEIVED, DONE, FAILED and a retry sweep (`jobs/webhookRetry.ts`, every 2 minutes, back-off 1 min / 5 min / 30 min / 2 h / 6 h, 8 attempts). Stripe, GoCardless and GHL (events with an id) record the row with the payload first, run the effect, then mark DONE; a failure answers **500** so the provider redelivers. Tested: replay after failure for all three sources and the sweep.
- **State machine** (`services/payment-state.ts`) with `transition()` in `payment.service.ts`: conditional update, invoice change and audit row in one transaction; a late FAILED never overwrites PAID; unique `stripeId` and `gocardlessId`. `markPaid` claims the invoice conditionally inside its transaction and keeps a PAID payment as is.
- **GoCardless**: `confirmed` PROCESSING (collecting, not paid), `paid_out` PAID, `failed`, `cancelled`, `charged_back` DISPUTED, `chargeback_cancelled` PAID, `refunded` and settled `refunds` (`paid`, `refund_settled`) REFUNDED. GoCardless refund events do not say whether they are partial; a settled refund is treated as full (open question below).
- **Stripe**: `charge.refunded` full to REFUNDED, partial = activity log + notification only; `charge.dispute.created` DISPUTED; `charge.dispute.closed` won back to PAID, lost = logged + notified.
- **Invoice effects**: refund voids the invoice; dispute reopens it (SENT); won settles it again. Each REFUNDED / DISPUTED / dispute-won writes an `ActivityLog` row (`PAYMENT_REFUNDED`, `PAYMENT_DISPUTED`, `PAYMENT_DISPUTE_WON`, `PAYMENT_PARTIAL_REFUND`, `PAYMENT_DISPUTE_LOST`) and notifies ADMIN and MANAGER profiles (type PAYMENT).
- **ACT-07**: invoices whose GoCardless payment is PENDING or PROCESSING are excluded from the debt board, debt KPIs, the mobile debt gate and the hold auto-release (`services/direct-debit.ts`).
- **Overdue sweep** (`jobs/overdueSweep.ts`, 04:00 UTC): writes `Payment.status = OVERDUE` for unsettled NOT_DUE/PENDING non-direct-debit payments whose SENT invoice is past due; no reminders, no GHL events. `InvoiceStatus` has no OVERDUE value and none was added (it would silently drop invoices from every `status = SENT` debt query); the invoice list's derived `overdue` flag is unchanged.
- **Deferred (documented)**: credit notes, part payments, dunning cadence and a failed-payment retry policy, bank-transfer reconciliation and payment links (out of scope per the plan).
- `PATCH /payments/{id}/status` is now strict: an illegal move is `409 INVALID_PAYMENT_TRANSITION`. `markPaid` can return `409 PAYMENT_NOT_SETTLEABLE` (payment DISPUTED or REFUNDED) and `409 PAYMENT_CHANGED`.

## 5. BE-09 / BE-13 / BE-18 / BE-19 hardening

Details in ARCHITECTURE_LATEST.md section 20.4: request-id middleware (`X-Request-Id`, `requestId` in error bodies), `helmet`, rate limiting (429 `RATE_LIMITED` + `Retry-After`), `AbortSignal.timeout` on every outbound `fetch` (`lib/outbound.ts`; Stripe client timeout 20 s; the GoCardless SDK has no timeout option, so it is not covered), graceful shutdown, 413 `PAYLOAD_TOO_LARGE`, optional `fields: [{ path, code, message }]` via `ValidationError`, `/health/ready` with DB ping and `failedTenantMigrations`, schema-name guard at every sink. Existing validators were not migrated to `fields`.

## 6. BE-17 idempotency

`lib/idempotency.ts` (atomic claim). Mobile `X-Idempotency-Key` behaviour is unchanged for clients except the new `409 IDEMPOTENCY_IN_PROGRESS` + `Retry-After: 1` while the first request is still running. Admin: optional `Idempotency-Key` on `POST /invoices`, `POST /customers`, `POST /payments/stripe/checkout`, `POST /messages/*`. Stripe checkout gets an `idempotencyKey`; expired PENDING sessions are skipped (also in the debt payment link path via `getInvoiceCheckoutLink`, which already filtered them).

## 7. BE-12 outbox

Back-off 30 s, 2 min, 10 min, 1 h, 6 h; dead on the 6th failure (the old limit was 5 attempts every 30 s). Unknown event type is `dead`, not `sent`. A row going dead (including `invoice.send`, which keeps its own claim/lease and result handling and now shares the back-off) notifies ADMIN and MANAGER (`INTEGRATION`). `GET /integrations/outbox?status=dead|failed&page&pageSize` and `POST /integrations/outbox/{id}/replay` (both ADMIN only). Replayed rows are drained by the existing worker (GHL-connected tenants only, as before).

## 8. Smaller items

- BE-19 `src/lib/schema-name.ts` used by `tenant-prisma-manager.ts` (connection URL) and `tenant-provisioning.ts` (every raw SQL site). Test helper schema names must now be `t_<20 hex>`.
- BE-27 unique `Customer.ghlContactId` + P2002 caught in the lead handoff.
- BE-18 `/health/ready`; `migrateAllTenantSchemas()` now returns `{ failed: string[] }`.
- Push: `src/mobile/services/push.ts` sends `channelId` (`schedule|chat|payments|alerts`) and `data.type`; `NotificationService.create` passes the type. Mapping: SCHEDULE, ROUND_UPDATE, DAY_CLOSED to schedule; CHAT to chat; PAYMENT to payments; the rest (COMPLAINT, ACCESS_ISSUE, INVITE, KPI_ALERT, INTEGRATION) to alerts. The app repo was not touched.
- Invoice VAT number prints only when `vatRegistered` is true and a number is stored (decided).
- Carryover onto an unavailable or deactivated technician stays flag-only (decided; nothing changed).
- `NotificationType` gained `INTEGRATION`.

## 9. Tests and gates

- New test files: `lib/__tests__/{schema-name,request-id,outbound,rate-limit,permissions,idempotency,outbox-backoff,tenant-provisioning}.test.ts`, `middleware/__tests__/requireAdmin.test.ts`, `server/__tests__/{shutdown,bootstrap.hardening}.test.ts`, `services/__tests__/{payment-state,webhook-events.service}.test.ts`, `jobs/__tests__/{webhookRetry,overdueSweep}.test.ts`, `routes/__tests__/{integrations.route,settings.adminonly.route,admin-idempotency.wiring}.test.ts`, `__tests__/role-matrix.test.ts`. Rewritten or extended: payment.service, stripe/gocardless/ghl webhook route tests, invoice.service (markPaid, VAT), outbox worker, invoice send batch, payments route, invites route, notify, push, mobile idempotency, bootstrap, tenant-prisma-manager, error-handler, checkout.
- `vitest.config.ts`: new `WAVE2B1_FILES` (100% per file): `schema-name`, `request-id`, `outbound`, `rate-limit`, `permissions`, `idempotency`, `outbox-backoff`, `tenant-provisioning`, `tenant-prisma-manager`, `requireAdmin`, `payment-state`, `direct-debit`, `webhook-events.service`, `webhookRetry`, `overdueSweep`, `routes/integrations`, `shutdown`. Already-gated files that changed stay at 100%: `stripeWebhook`, `gocardlessWebhook`, `ghlWebhook`, `payments`, `invoices`, `payment.service`, `invoice.service`, `invoice-send-batch.service`, `outboxWorker`, `debt.service`, `debt-gate`, `payment-hold`, `notify`, `push`, `mobile/idempotency`, `bootstrap`, `error-handler`, `checkout`, `app-error`, `render`, `email`.
- Swagger: new paths, `Idempotency-Key` parameter, 413/429 responses, `requestId`/`fields` on `Error`, new `PaymentStatus` values, `/health/ready` schema; `swagger.contract.test.ts` passes.

## 10. Rollback notes

Code plus relaxing/additive schema changes. To roll back the behaviour without reverting code: `RATE_LIMIT_DISABLED=true` disables limits; webhooks revert to 200-on-record only by reverting code (the `FAILED` rows are harmless). Leaving a FAILED webhook row un-swept is safe (attempts cap at 8).

## 11. Open questions for the user

1. Should MANAGERs be blocked from the setup wizard payment/business steps too (currently only locked after setup completes)?
2. A settled GoCardless refund is treated as a full refund (the event does not carry the amount). Fetch the refund from the API to detect partials, or accept?
3. Invoice status after a Stripe dispute is reopened to SENT (appears in debt and can trigger the hold gate) and after a full refund VOID. Confirm, or keep PAID during a dispute?
4. `Invoice` has no OVERDUE status; the sweep writes `Payment.status = OVERDUE`. Add an invoice status (touches every debt query) or keep it derived?
5. `TRUST_PROXY` value for the real deployment.

## 12. Proposed architecture doc changes

Done (explicitly authorised): new section 20 and four migration-log rows in section 12 of `docs/ARCHITECTURE_LATEST.md`. Section 9 (error handling) and section 7 (RBAC) still describe the older behaviour (no `requestId`, MANAGER = ADMIN power); a follow-up edit can fold the section 20.1 and 20.4 summaries into them.
