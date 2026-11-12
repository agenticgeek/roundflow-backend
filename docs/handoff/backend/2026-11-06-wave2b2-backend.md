# Wave 2B-2 backend handoff (2026-11-06): GHL optional, native tenant email, follow-ups

Scope: plan Phase 1B (GHL-01 to GHL-07, GHL-10/11, BE-31 partly) plus the decided follow-ups (payment method recording, B5, A5, close day, setup steps). Frontend consequences, breaking changes first: `docs/handoff/frontend/2026-11-06-wave2b2-frontend-contract.md`. Everything is **uncommitted**; **no migration was applied**, the server was never started, no live test was run; every test mocks SES, GHL, Stripe and the database. Superseded checkpoint: `2026-11-06-wave2b2-CHECKPOINT.md`.

## 1. Migrations (NOT applied; the startup migrator applies them)

| Folder (`prisma/tenant/migrations/`) | Change |
|---|---|
| `20261108100000_visit_collected_via` | nullable `Visit.collectedVia` (PaymentMethod). |
| `20261108110000_email_identity_delivery` | enums `EmailDomainStatus`, `MessageDeliveryStatus`; `BusinessSettings`: `emailSenderName`, `emailReplyTo`, `emailSenderDomain`, `emailSenderLocalPart`, `emailDomainStatus` (default NONE), `emailDkimRecords` (jsonb), `emailDomainVerifiedAt`, `emailEnabled` (default true), `emailDailyLimit`, `emailPausedReason`, `emailPausedAt`, `logoPath`, `logoAltText`, `brandColour`; `Message`: `deliveryStatus`, `deliveryUpdatedAt`, `deliveryError`, index on `externalId`; `Customer.emailInvalidAt`; one-off cleanup: pending/failed/dead GHL-only outbox rows (`customer.synced`, `visit.*`, `payment.*`, `debt.overdue`, `complaint.*`) of a tenant without `ghlConnected` become status `dropped`. |

Additive and idempotent (`IF NOT EXISTS`, guarded `CREATE TYPE`). Code that reads the new columns fails on an un-migrated tenant: migrate with the release. Rollback: old code ignores the columns; the cleanup UPDATE is not reversible (rows only park as `dropped`, nothing deleted).

## 2. Environment variables

| Var | Meaning |
|---|---|
| `SES_REGION` | AWS region of the SES account. Unset = email unavailable (`409 CHANNEL_UNAVAILABLE`, reason `EMAIL_NOT_CONFIGURED`). Startup warns when unset. |
| `SES_FROM_DOMAIN_ADDRESS` | Shared sending address on the RoundFlow-owned verified subdomain, e.g. `notifications@mail.roundflow.ai` (tier 1). |
| `SES_CONFIGURATION_SET` | Configuration set attached to every send and every tenant identity (publishes events to SNS). |
| `SES_SNS_TOPIC_ARN` | Optional: `/webhooks/ses` accepts only this topic. Recommended. |
| `SES_ACCESS_KEY_ID`, `SES_SECRET_ACCESS_KEY` | Optional static credentials; unset = default AWS credential chain. Never logged. |
| `EMAIL_DISABLED` | `true` = all native customer email off. Supabase auth emails unaffected. |
| `RATE_LIMIT_EMAIL_ADMIN_PER_HOUR` | `/settings/email/*` per IP per hour (default 60). |

All are in `.env.example` and `src/lib/env-check.ts`. New dependency: `@aws-sdk/client-sesv2` (installed fine, no fallback needed).

## 3. What changed

- **Mailer** (`src/lib/mailer/`): SES v2 provider (Simple or Raw MIME with PDF attachment), timeout + one retry on throttling/5xx, no recipient in logs, tags `tenantId` + `messageId`; accessible HTML + plain text wrapper; contrast helpers; sender validation; SNS verification. `services/email.service.ts#sendTenantEmail`.
- **Channel router** (`services/message.service.ts`): EMAIL native, SMS/WhatsApp via GHL, otherwise typed `409 CHANNEL_UNAVAILABLE` with `reason`. `channels { email, sms, whatsapp, calls }` on `GET /settings/business-profile` and `GET /settings/email`. Outbound email `Message` rows get `deliveryStatus` SENT (then DELIVERED/BOUNCED/COMPLAINED from SES) and the SES id in `externalId`. `messagesOptOut` applies to email; bounced/complained addresses (`emailInvalidAt`) are not used.
- **Flows converted** to best channel else skip with reason (`NO_AVAILABLE_CHANNEL`, `CUSTOMER_OPTED_OUT`): broadcast/round message, weather hold, carryover notice, debt remind and bulk, hold notice, payment link, pre-clean reminders and visit-completed (outbox `sendBest` -> row status `skipped` + reason), complaint replies, bulk invoice send.
- **GHL optional**: `queueGhlEvent` queues only when connected; the worker drains every tenant and drops GHL-only events (`dropped`) when not connected.
- **Invoice email**: EMAIL-first, template subject, inline summary with payment details and reference, PDF attached (flag `pdfAttached`; email still goes out if Gotenberg is down), SENT only after SES accepted, resend works; `POST /invoices { sendEmail: true }` now works.
- **SES events**: `POST /webhooks/ses`, idempotent via `WebhookEvent` (`source ses`, retried by the sweep), auto-pause above 0.3% complaints / 5% bounces over the last 100+ sends (or 3 complaints / 10 hard bounces in 7 days) with an ADMIN/MANAGER notification.
- **Settings**: `GET|PATCH /settings/email`, `POST /settings/email/test`, `GET|POST|DELETE /settings/email/domain`, logo `POST /settings/email/logo/upload-url`, `PUT|DELETE /settings/email/logo`; nightly `emailDomainRecheck` (05:00 UTC). ADMIN only except GET (`ADMIN_ONLY_ROUTES`, role matrix updated).
- **Smaller**: `GET /invoices/export.csv` documents/accepts `status=OVERDUE`; mobile visit, schedule and completions rows carry `paymentStatus`.
- **Task 6** (done earlier, same release): `payment.method` BACS/GOCARDLESS/STRIPE/NONE + `collectVia` + `updateCustomerDefault` on `POST /mobile/visits/{id}/complete` and `Visit.collectedVia`; `409 UNPAID_INVOICES {count,total}` on customer/property delete; debt buckets by days past due; `POST /today/close { notifyCustomers }` -> `notifiedCustomers`, `customerNotificationError`; `POST /setup/step/1|2` ADMIN only.

## 4. New error codes

`CHANNEL_UNAVAILABLE` (+ `reason`), `CUSTOMER_OPTED_OUT`, `EMAIL_SEND_FAILED`, `FREE_MAIL_DOMAIN`, `RESERVED_EMAIL_DOMAIN`, `INVALID_EMAIL_DOMAIN`, `EMAIL_DOMAIN_IN_USE`, `EMAIL_DOMAIN_FAILED`, `INVALID_EMAIL_SENDER_NAME`, `INVALID_EMAIL_ADDRESS`, `INVALID_EMAIL_LOCAL_PART`, `INVALID_EMAIL_DAILY_LIMIT`, `INVALID_BRAND_COLOUR`, `INVALID_LOGO_TYPE`, `INVALID_LOGO_PATH`, `UNPAID_INVOICES`. `GHL_NOT_CONNECTED` now only comes from GHL settings routes.

## 5. AWS setup the user must do (exact steps)

1. **SES account**: choose the region (`SES_REGION`). **Leave the sandbox**: SES console > Account dashboard > Request production access (mail type Transactional, describe the use: invoices and service notices for UK window-cleaning businesses, how bounces/complaints are handled). In the sandbox only verified addresses can receive mail. Confirm the sending quota covers expected volume.
2. **Shared sending subdomain** (tier 1): verify `mail.roundflow.ai` (or your choice) as a domain identity with Easy DKIM, add the 3 DKIM CNAMEs, then add SPF (`v=spf1 include:amazonses.com ~all`) on a custom MAIL FROM subdomain (e.g. `bounce.mail.roundflow.ai`, MX `feedback-smtp.<region>.amazonses.com` priority 10 plus the SPF TXT) and a DMARC TXT (`_dmarc.mail.roundflow.ai`: `v=DMARC1; p=quarantine; rua=mailto:dmarc@roundflow.ai`). Set `SES_FROM_DOMAIN_ADDRESS=notifications@mail.roundflow.ai`.
3. **Configuration set** (`SES_CONFIGURATION_SET`, e.g. `roundflow-events`): add an event destination of type SNS publishing **Delivery, Bounce, Complaint** (also enable Reputation metrics). Create the SNS topic (e.g. `roundflow-ses-events`) in the same region.
4. **SNS subscription**: subscribe an HTTPS endpoint `https://<PUBLIC_API_URL host>/webhooks/ses` to the topic with **Raw message delivery disabled**. The backend confirms the subscription automatically (check the subscription turns "Confirmed"). Set `SES_SNS_TOPIC_ARN` to the topic ARN.
5. **IAM user** (dedicated, not Supabase's SMTP credentials). Statement `SendMail` is needed for all email; `TenantDomainIdentities` is **only needed for tier 2 domain verification** (without it tier 1 sending still works and the domain endpoints answer 502 `EMAIL_DOMAIN_FAILED`). Creating an identity with a configuration set needs the identity actions plus `PutEmailIdentityConfigurationSetAttributes`, `TagResource` (identities are tagged with the tenant id) and use of the configuration set:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "SendMail",
      "Effect": "Allow",
      "Action": ["ses:SendEmail", "ses:SendRawEmail"],
      "Resource": "*"
    },
    {
      "Sid": "TenantDomainIdentities",
      "Effect": "Allow",
      "Action": [
        "ses:CreateEmailIdentity",
        "ses:GetEmailIdentity",
        "ses:DeleteEmailIdentity",
        "ses:PutEmailIdentityConfigurationSetAttributes",
        "ses:PutEmailIdentityDkimAttributes",
        "ses:TagResource"
      ],
      "Resource": "arn:aws:ses:<REGION>:<ACCOUNT_ID>:identity/*"
    },
    {
      "Sid": "UseConfigurationSet",
      "Effect": "Allow",
      "Action": ["ses:GetConfigurationSet", "ses:TagResource"],
      "Resource": "arn:aws:ses:<REGION>:<ACCOUNT_ID>:configuration-set/<CONFIGURATION_SET>"
    }
  ]
}
```
   On ECS/EC2 attach the same policy to the role instead and leave the access key vars unset. If domain creation still returns AccessDenied, the error name is in the API log (`aws=AccessDeniedException`); add the action it names.
6. Env on the API: `SES_REGION`, `SES_FROM_DOMAIN_ADDRESS`, `SES_CONFIGURATION_SET`, `SES_SNS_TOPIC_ARN`, optional keys, `PUBLIC_API_URL` (already needed), `GOTENBERG_URL` for the PDF attachment.
7. **Smoke test** in this order: deploy (migrations run) > Settings > Email > "Send test to me" (tier 1) > send an invoice to a mailbox you own > send to `bounce@simulator.amazonses.com` and `complaint@simulator.amazonses.com` (SES mailbox simulator) and watch the message status and the customer's `emailInvalidAt` change.
8. **Tenant domains (tier 2)**: the tenant adds the 3 CNAMEs shown in Settings > Email; status turns VERIFIED on "Check now" or the nightly job; until then mail keeps going out from the shared address.

## 6. Deploy and rollback

Deploy with migrations; set the SES env; keep `EMAIL_DISABLED=true` until step 7 passes if you want a dark launch. Rollback: `EMAIL_DISABLED=true` stops all native customer email without a code change (SMS via GHL unaffected); webhook rows stay harmless.

## 7. Known limits and open points

- Rate-limit counters and the logo signed URL (90 days) are per process / time boxed. The worker iterates every tenant each 30 s (BE-06 client-cache limit still applies).
- **Auto-pause rules** (`services/email-events.service.ts`): only HARD (permanent) bounces count, transient bounces never do. Percentage rules (complaints > 0.3%, hard bounces > 5%) apply only when the last-sends window holds at least 100 emails. Independently of volume, 3 or more complaints, or 10 or more hard bounces, within 7 days also pause (so a tiny tenant is protected and one complaint cannot pause a big one). The pause reason names the rule; an ADMIN/MANAGER notification is sent once; resume with `PATCH /settings/email { emailPaused: false }`.
- `Customer.emailInvalidAt` is cleared automatically when the customer's email is edited to a different address (case/space-insensitive; removing the address also clears it).
- Invoice PDF branding (logo, brand colour in `invoiceHtml`) is not added yet; the PDF already prints name, address, VAT/company number, bank details, terms, reference.
- Out of scope as agreed: credit notes, part payments, dunning, GDPR, tenant billing, BE-04/05/06/10, pino.

## 8. Tests and gates

New: `lib/mailer/__tests__/*`, `services/__tests__/{email.service,email-events.service,email-domain.service,email-settings.service,debt-bulk.skip}.test.ts`, `routes/__tests__/{sesWebhook.route,settings-email.route}.test.ts`, `jobs/__tests__/emailDomainRecheck.test.ts`. Extended: message.service, invoice.service.phase1, invoice-send-batch, outboxWorker, bootstrap, rate-limit, env-check, role matrix. `vitest.config.ts`: `WAVE2B2_FILES` (13 files, 100% each).

## 9. Proposed architecture doc changes

Done (authorised): section 21 and two migration-log rows in `docs/ARCHITECTURE_LATEST.md`. Section 10 (GHL integration) still describes GHL as carrying all messaging; fold section 21.3 into it in a follow-up.

## 10. E2E bug-fix pass (2026-11-07)

Source: `roundflow-e2e/docs/BUGS_FOUND_2026-11-06.md` and the run logs. No migrations. Tests first for each fix.

| Bug | Fix |
|---|---|
| BUG-010 | New `src/lib/tenant-jobs.ts#forEachTenant` (default 4 tenants at a time, env `TENANT_JOB_CONCURRENCY` 1..8) over the shared client cache; `withTenantClient()` in `tenant-prisma-manager.ts` pins a client while it is used, so an LRU eviction never disconnects a client in use. Used by `webhookRetry`, `outboxWorker`, `overdueSweep` (the three jobs that fanned out over all tenants with `Promise.allSettled`). The other jobs (`emailDomainRecheck`, `geocodeBackfill`, `kpiThresholds`, `idempotencyPurge`, `preCleanReminders`, `visitGeneration`, `backfills`) already iterate tenants one at a time. Test with 300 tenants proves concurrency and open clients stay bounded. |
| BUG-005 | `P2002` handled: invite accept (loser gets the winner's profile, 409 `PROFILE_EXISTS` if it belongs to another organisation), visit completion (loser gets the completed visit), signup (in-process shared provisioning promise per schema; a failed provisioning is not cached). |
| BUG-001 | Skipped invoices of a bulk send are recorded as `IntegrationOutbox` rows (status `skipped`, `lastError "CODE: text"`) under the batch, so `GET /invoices/bulk-send/{batchId}` works for an all-skipped batch and lists the reasons (results now also contain the skipped items). |
| BUG-011 | `PUT /rounds/{id}/technicians`: duplicate ids collapse, `createMany skipDuplicates`, simultaneous save = 409 `ROUND_TECHNICIANS_CONFLICT`. `POST /setup/step/6` deletes the technician service-area rows first; a remaining FK = 409 `TECHNICIAN_IN_USE` (also fixes the fuzz 500 for body `[]`). |
| BUG-007 | `parseIsoDate` rejects impossible calendar dates (leading YYYY-MM-DD round-trip); `assertCalendarDate` for POST /visits; invoice `dueDate` validated. |
| BUG-006/003/008 | 400 with `fields[]` for: invoice dueDate/sendEmail, emergency stops/window/ids/notes + status filter, setup step 1 and business profile email/timezone/currency/working-days type/UK bank format, customer email (no CR/LF, strict), invite email, payment debt-hold limits, `stripeConnected`/`gocardlessConnected` on PATCH /settings/payment, EMAIL template subject (`SUBJECT_REQUIRED`). `isValidEmail` is now strict (RFC length caps, no whitespace/angle brackets/quotes). Currency accepts an ISO 4217 code or a symbol (the stored value has always been a symbol such as "£"). |
| BUG-004 | Decision: page sizes above the maximum are clamped; every `pageSize` parameter in swagger now says so (contract test). `GET /messages/inbox?unreadOnly=` must be `true` or `false` (400 otherwise). |
| BUG-009 | `GET /customers/{unknown}/invoices` 404; `mark-paid` looks the invoice up (404) before validating the method; GET of a deleted customer with no history is 404. |
| GEN-001, VIS-004n | Completing a visit now advances the plan: a one-off visit completes the property's ACTIVE plan when it is due (`lastCompleted`, `nextDueDate` one cycle ahead, on the round day); a plan already ahead (advanced by the nightly job) is not moved again. |
| CARRY-001-* | Real bug: wizard saves (`SetupService.upsertSettings`) did not invalidate the shared settings cache, so carryover/invoices/generation used stale working days, time zone and currency for up to the cache TTL. Fixed. |
| GAP-019 / E2E-050 | `POST /mobile/visits/{id}/photos` also accepts the full Supabase storage URL of this visit's own object and stores its object path; non-storage URLs (`https://example.invalid/...`) stay refused. |
| MSG-003b | Round/recipient validation (404/400) now runs before the channel-availability 409. |

Not fixed, with reason: CARRY-003h (concurrent identical carryovers move twice: needs a row claim, BE-04 scope); CUST-008d (two customers with one mobile: no uniqueness rule exists, matching is advisory); VIS-004f-nul (explicit `amount: null` is treated as "default amount", the app may send it); CMP-002/005/006, TECH-006c, ASGN-003c, RPT-004, PAY-011-badbucket (not reproduced here); VIS-004c kept as agreed.

Test-side (not product): CUST-009b (the 400 mismatch is the intended frequency check), WX-005/006 (409 `NO_VISITS_TO_HOLD` is documented), GEO-002 (background geocoding sets coordinates between the two reads), SEC-ANON-Auth (rate-limit 429 noise), SEC-ROUTE-404 (anonymous gets 401 before routing), SEC-ROUTE-405 (`/auth/v1/*` is Supabase-hosted), XTEN-lists (same seeded names in both tenants).
