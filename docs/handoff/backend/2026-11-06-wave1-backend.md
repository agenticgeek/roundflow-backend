# Wave 1 backend handoff (2026-11-06)

Scope: Phase 0 hardening and Phase 1C (assignment, notifications) from `docs/GAP_ANALYSIS_AND_REMEDIATION_PLAN_2026-11-06.md`. All work is **uncommitted**. **Nothing was applied to any database**: one tenant migration was written and must go out through the normal deploy (startup runs `migrateAllTenantSchemas`).

Frontend/app consequences are in `docs/handoff/frontend/2026-11-06-wave1-frontend-contract.md` (breaking changes first).

## 1. Migration (not applied)

`prisma/tenant/migrations/20261106000000_notification_data_category/migration.sql`, additive and idempotent:

```sql
ALTER TABLE "Notification" ADD COLUMN IF NOT EXISTS "data" JSONB;
ALTER TABLE "Notification" ADD COLUMN IF NOT EXISTS "category" TEXT;
```

`prisma/tenant/schema.prisma`: `Notification.data Json?`, `Notification.category String?`. `npm run prisma:generate` was run (safe, no DB). Existing rows keep `data = null`. Rollback: the columns are nullable and unused by older code; no rollback needed.

Deploy order: apply the migration (normal startup) before or with this release. Code that writes `data`/`category` fails on a schema without the columns, so do not run the new build against un-migrated tenants.

## 2. New environment variables

| Var | Default | Meaning |
|---|---|---|
| `EXPOSE_API_DOCS` | unset | `true` serves `/docs` and `/openapi.json` when `NODE_ENV=production`. Outside production they are always served. Documented in `src/lib/env-check.ts` (`OPTIONAL_ENV_VARS`) and `.env.example`. |

No other env changes. `.env`, `.env.bak-before-encryption-key` were not touched (the stray backup file is still there: delete it by hand, see BE-25).

## 3. Phase 0 items

| ID | What changed | Files |
|---|---|---|
| BE-02 | Stripe, GoCardless and GHL webhook handlers are wrapped by `guardWebhook()`: any throw (DB, decrypt) is logged and answered `503 DATABASE_UNAVAILABLE` (+ `Retry-After: 5`) when the database is unreachable, otherwise `500`. No unhandled rejection. `installProcessErrorHandlers()` (called from `src/index.ts`) logs `unhandledRejection` (process keeps running) and logs + exits 1 on `uncaughtException`. Nothing is swallowed silently. | `src/lib/webhook-guard.ts`, `src/routes/{stripe,gocardless,ghl}Webhook.ts`, `src/server/bootstrap.ts`, `src/index.ts` |
| BE-14 | `toCsv` prefixes `'` to **string** cells starting with `= + - @ TAB CR` (numbers, incl. negatives, are untouched). CR is now also a quote trigger. `GET /reports/export`: `type` must be `visits\|technicians\|revenue` else `400 INVALID_EXPORT_TYPE`; the filename uses only `[A-Za-z0-9_-]` from `period`. | `src/lib/csv.ts`, `src/routes/reports.ts` |
| BE-16 | `POST /mobile/visits/:id/photos`: `url`/`path` must start with `<tenantId>/visits/<visitId>/` and contain no `..`, else `400 INVALID_PHOTO_PATH`. | `src/mobile/routes.ts` |
| BE-25 (part) | `/docs` and `/openapi.json` are 404 in production unless `EXPOSE_API_DOCS=true`. Key versioning and deleting the `.bak` file are **not** done. | `src/server/bootstrap.ts` (`shouldExposeApiDocs`) |
| BE-26 | Unknown routes answer `404 {error:"Not Found"}`. A documented path with an unsupported method still answers `405` + `Allow` (pre-filter unchanged). | `src/server/bootstrap.ts` |
| BE-11 interim | `POST /invoices` with `sendEmail: true` is `400 EMAIL_NOT_AVAILABLE` (nothing created). `sendEmail: false`/omitted behaves as before. Use `POST /invoices/:id/send`. | `src/routes/invoices.ts` |

## 4. Phase 1C

### 4.1 Assignment (FLOW-01/02/04)

`PUT /rounds/:id/technicians` (real save): after the transaction commits, if the round is ACTIVE and the list is non-empty, `generateForRound()` creates the due visits for the tenant-local today (they are stamped from the committed allocation, the same resolver as the restamp, so no second restamp is needed). Response keeps `roundId`, `allocation`, `visitsUpdated` and adds:

- `visitsGenerated: number` (0 on dryRun, non-ACTIVE round or cleared list)
- `overriddenVisits: number` (future SCHEDULED visits with `technicianOverride`, skipped by the restamp)
- `nextVisitDate: "YYYY-MM-DD" | null` (earliest SCHEDULED visit from tenant-local today, recomputed after generation)

`dryRun=true` writes nothing, generates nothing, notifies nobody, but still reports `overriddenVisits` and `nextVisitDate` (read inside the rolled-back transaction). The restamp now uses the tenant-local today (was server time).

### 4.2 Notifications (NOTIF-01/02/03, FLOW-03)

New central notifier `src/services/notify.ts`:

- `notifyEvent(tp, { type, title, body?, data?, to, dedupe? })`. Recipients: `technicianIds` (active technicians with an accepted profile only), `profileIds`, `admins: true` (all ADMIN + MANAGER profiles of the tenant that owns `tp`, resolved through `getSchemaNameForClient`, new in `tenant-prisma-manager.ts`), `excludeProfileIds`. Deduped per profile. **Never throws**; failures are logged (`[notify] ...`) and counted as not sent.
- `dedupe: { windowMs, keys }` skips a recipient who already has an **unread** notification of the same type inside the window with equal `data[key]` values.
- Wrappers: `notifyAdmins`, `notifyTenantAdmins(tenantId, ...)`, `notifyVisitTechnicians`, `notifyInvoicePaid`, `notifyPaymentFailed`.
- `NotificationService.create(profileId, type, title, body?, data?, opts?)` is backward compatible (old 4-arg callers unchanged). It stores `data` and `category` (= `type`) and sends the push with `data`.
- Preference-aware push: `profile.preferences.notifications.categories.<TYPE> === false` skips the **push only**; the row is still stored. Anything else (missing key, malformed JSON, lookup failure) keeps push on. `src/lib/notification-prefs.ts`. Reserved shape: `{"notifications":{"categories":{"CHAT":false,"SCHEDULE":true}}}`, written through the existing `PATCH /auth/me/preferences` (shallow merge: send the whole `notifications` object).

Types produced: `SCHEDULE`, `ROUND_UPDATE`, `CHAT`, `PAYMENT`, `COMPLAINT`, `ACCESS_ISSUE`, `DAY_CLOSED`, `INVITE` (`KPI_ALERT` unchanged, ADMIN only).

Producers (all best effort, after the business write):

| Event | Recipients | Type | Where |
|---|---|---|---|
| Technician added to a round | that technician: `"N visits assigned to you"` (data `{roundId, date}` = first visit), or `ROUND_UPDATE "You have been added to a round"` when no visits yet | SCHEDULE / ROUND_UPDATE | `round.service.setTechnicians` |
| Technician removed | removed technicians | ROUND_UPDATE | same |
| Allocation changed for a retained technician | only when `visitsUpdated > 0` | ROUND_UPDATE | same |
| `POST /rounds/:id/reassign` | receiving technician and (if any) releasing technician, only when visits moved | SCHEDULE | `round.service.reassignTechnician` |
| `PATCH /visits/:id/assign` | new and previous technician | SCHEDULE | `visit.service.assignVisit` |
| Visit rescheduled | assigned technician | SCHEDULE | `visit-reschedule.ts` |
| Visits cancelled (pause service, frequency change) | their technicians | SCHEDULE | `service-plan-lifecycle.ts` (`pausePlan`, `updatePlan`; the nightly pause transition goes through `pausePlan` too) |
| Weather hold | technicians on the held visits (independent of `notifyCustomers`) | SCHEDULE | `weather-hold.service.ts` |
| Complaint revisit scheduled | technician of the revisit visit | SCHEDULE | `complaint.service.scheduleRevisit` |
| Debt hold placed / released on a customer's visits | technicians of those visits | PAYMENT | `payment-hold.ts` (so it covers `PATCH /debt/:id/hold` and every auto-release) |
| Technician chat message | ADMIN + MANAGER; at most one per admin per round per 5 min while the previous is unread (`data.roundId`) | CHAT | `mobile/services/chat.service.ts` |
| Access issue reported | ADMIN + MANAGER | ACCESS_ISSUE | `job-tracker.service.reportAccessIssue` |
| Visit skipped (with reason) | ADMIN + MANAGER | SCHEDULE | `job-tracker.service.skipVisit` |
| Technician closed their day | ADMIN + MANAGER (first close only) | DAY_CLOSED | `day-close.service.close` |
| Payment failed | ADMIN + MANAGER | PAYMENT | `payment.service.applyOutcome` (GoCardless, Stripe PI failure, manual) |
| Invoice paid | ADMIN + MANAGER | PAYMENT | Stripe checkout webhook, `applyOutcome(PAID)` (when an invoice flips), `POST /invoices/:id/mark-paid` (excludes the user who clicked) |
| Complaint logged | ADMIN + MANAGER | COMPLAINT | `complaint.service.logComplaint` |
| Invite accepted | ADMIN + MANAGER (not the new user) | INVITE | `POST /invites/:token/accept` first-accept path |

`data` keys used: `visitId`, `roundId`, `customerId`, `invoiceId`, `propertyId`, `date` (YYYY-MM-DD).

Not covered (deliberately): technician cash collection through `POST /mobile/visits/:id/debt-payment` does not raise "invoice paid"; the existing availability and KPI producers are unchanged (KPI alerts still go to ADMIN only); incidents/emergencies already have their own bell; email bounces (Phase 1B).

### 4.3 Admin notification API (NOTIF-02)

New router `/notifications` (`requireAuth`, `requireTenantAccess`, `requireBusinessAccess`; ADMIN + MANAGER). Every query is scoped to the caller's own profile id.

| Method / path | Response |
|---|---|
| `GET /notifications?cursor=` | `{ notifications: [{id,type,title,body,read,createdAt,data}], unreadCount, nextCursor }` (30 per page, newest first, `profileId`/`category` omitted) |
| `GET /notifications/unread-count` | `{ unreadCount }` |
| `POST /notifications/read-all` | `{ ok: true }` |
| `POST /notifications/:id/read` | `{ ok: true }`; an unknown or foreign id is a silent no-op |

`GET /mobile/notifications` now also returns `data` on each row (`profileId` is still present there). Swagger: `Notifications` tag, `AdminNotification`, `AdminNotificationPage`, `NotificationData`, `MobileNotification.data`, `SetTechniciansResult` additions.

## 5. Tests and gates

- New: `webhook-guard`, `notification-prefs`, `notify` (20 tests), `notifications.route`, `notification.service`, `push`, `notification-producers`, `round.service.assign-flow`, plus additions in the bootstrap, csv, env-check, reports, invoices, mobile routes/service/day-close, complaint, weather-hold, payment, payment-hold, service-plan-lifecycle, invites, stripe/gocardless/ghl webhook and tenant-prisma-manager test files.
- `src/test/notify-mock.ts` is the shared stub for tests of code that only calls the notifier.
- `src/test/env.setup.ts` now forces `DATABASE_URL`/`DIRECT_URL` to a dead local address for every unit test, so a forgotten mock can never reach the shared dev database. (`test:live` shares this setup file; it only calls Stripe/GoCardless.)
- `vitest.config.ts`: new `WAVE1_FILES` gate (100% per file): `webhook-guard.ts`, `notification-prefs.ts`, `notify.ts`, `routes/notifications.ts`, `mobile/services/notification.service.ts`, `mobile/services/push.ts`.
- Pre-existing gate failures not touched by this wave: branch coverage in `src/services/message.service.ts` (lines 181, 393) and `src/services/photo-gallery.service.ts` (line 182).

## 6. Rollback notes

All changes are code plus one nullable-column migration. Reverting the code is safe with the migration applied. Setting `EXPOSE_API_DOCS=true` restores public docs in production.

## 7. Proposed architecture doc changes

`docs/ARCHITECTURE_LATEST.md` was updated (explicitly authorised): section 6 (404/405, docs gating, process handlers), section 9 (webhook guard), section 12 (migration log) and new section 18 (Wave 1). Review section 18 for tone.
