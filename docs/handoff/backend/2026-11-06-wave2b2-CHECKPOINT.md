# Wave 2B-2 CHECKPOINT (stopped on request; nothing committed, nothing applied to any DB)

State at stop: `npx tsc --noEmit` clean. Last full `npx vitest run src` (before the final two small test edits): 2731 passed, 0 failed. Coverage gates (`test:coverage`, `test:diff-coverage`), eslint, `npm run build`, swagger.ts changes, role-matrix rows, vitest.config.ts gated list: NOT run / NOT done for Wave 2B-2 files.

## DONE
- Task 6 (a-e) fully done by a fork (see its notes in the final report): `services/visit-completion.ts` (method incl. collectVia/updateCustomerDefault, `Visit.collectedVia`), `services/customer.service.ts` (409 UNPAID_INVOICES), `services/debt.service.ts` (A5 buckets), `routes/today.ts` + `services/today.service.ts` + `services/carryover.service.ts` (notifyCustomers), `lib/permissions.ts` + `routes/setup.ts` (steps 1, 2 ADMIN only), role-matrix data. Migration `20261108100000_visit_collected_via`.
- Task 1 core (tests first, 140 tests green): `src/lib/mailer/{config,contrast,sender,template,ses}.ts` + `__tests__`. SES v2 provider (simple + raw MIME with attachments, 1 retry on throttle/5xx, timeout, no recipient in logs, tenantId/messageId tags, identity create/get/delete with tenant-tag ownership check). `@aws-sdk/client-sesv2` installed.
- `src/services/email.service.ts` + test (17+ tests): getMailer/setMailer, `ChannelUnavailableError` (409 CHANNEL_UNAVAILABLE + `reason`), `getEmailAvailability`, `sendTenantEmail` (tier 1/2 sender, branding, signed logo 90 days, daily cap default 1000, tags), `resolveTenantId`.
- Task 3 (mostly): `services/message.service.ts` channel router (`pickChannel`, `bestChannel`, `capabilities()`, `channelCaps()`, `assertAnyChannelAvailable`, `sendBest`, EMAIL via mailer with `deliveryStatus SENT`, broadcast best-available with `skipped_no_channel`/`reason`); `invoice-send-batch.service.ts` (EMAIL-first, reasons CUSTOMER_OPTED_OUT / NO_AVAILABLE_CHANNEL; renamed from OPTED_OUT / GHL_NOT_CONNECTED, breaking); `weather-hold.service.ts`; `debt.service.ts` (reminder respects opt-out, hold notify AUTO); `debt-bulk.ts` (skipped + reason); `complaint.service.ts` + `routes/complaints.ts` (reply delivered via router); `jobs/outboxWorker.ts` (drains ALL tenants, GHL-only events dropped as status `dropped` when GHL not connected, message events use `sendBest`, skip -> status `skipped`); `integrations/ghl/sync.ts` `queueGhlEvent` queues only when ghlConnected.
- Schema + migration `20261108110000_email_identity_delivery` (BusinessSettings email*/logo*/brandColour, EmailDomainStatus, MessageDeliveryStatus, Message delivery fields + externalId index, Customer.emailInvalidAt). Prisma tenant client generated.

## IN PROGRESS / MISSING
- Migration SQL still lacks the one-off cleanup: `UPDATE "IntegrationOutbox" SET status='dropped' ... WHERE status IN ('pending','dead','failed') AND eventType IN (GHL-only events) AND tenant has no ghlConnected`.
- Task 4 (invoice email) NOT written: `sendInvoice` still calls `messages.prepare/deliver` generically (works through the router, EMAIL possible) but missing: EMAIL-first default (add `preferred` param to `pickChannel`/`prepare`), subject from template/`Invoice X from Business`, PDF attachment via `renderHtmlToPdf(invoiceHtml(getRenderData))` with fallback inline summary + flag, `sendEmail:true` on POST /invoices (currently ignored; plan says 400 until built), tenant logo/brand in `invoiceHtml`, `loadTemplate` returning subject.

## NOT STARTED
- Task 1: env-check + `.env.example` entries (SES_REGION, SES_FROM_DOMAIN_ADDRESS, SES_CONFIGURATION_SET, SES_ACCESS_KEY_ID, SES_SECRET_ACCESS_KEY, EMAIL_DISABLED).
- Task 2: settings endpoints (`routes/settings-email.ts`: GET/PATCH /settings/email, POST/GET/DELETE /settings/email/domain, logo upload-url/read-url under `<tenantId>/branding/`), brand colour contrast warning on save, `channels` in settings response, email-domain service + nightly recheck job (cron in bootstrap), ADMIN_ONLY_ROUTES + role-matrix rows + rate limits.
- Task 5: `POST /webhooks/ses` (SNS signature verification, SubscribeURL confirm, `processWebhookEvent` idempotency with source `ses`, tenant from `tenantId` tag, map Delivery/Bounce/Complaint to `Message.deliveryStatus`, `Customer.emailInvalidAt`, rate-based auto pause above 0.3% complaint / 5% bounce over last 100+ sends, ADMIN notification via `notifyAdmins`), mount in bootstrap with raw body + limiter.
- swagger.ts parity for all new/changed routes and fields; vitest.config.ts `WAVE2B2_FILES` (mailer/*, email.service, new services/routes/jobs); coverage rounds; handoffs `2026-11-06-wave2b2-backend.md` and `../frontend/2026-11-06-wave2b2-frontend-contract.md`; ARCHITECTURE_LATEST.md section + migration rows; AWS setup instructions (IAM, subdomain, config set, SNS, sandbox exit).

## Migrations so far (not applied)
`20261108100000_visit_collected_via`, `20261108110000_email_identity_delivery` (both under `prisma/tenant/migrations/`).

## New env vars so far
Read by code but not yet in env-check/.env.example: SES_REGION, SES_FROM_DOMAIN_ADDRESS, SES_CONFIGURATION_SET, SES_ACCESS_KEY_ID, SES_SECRET_ACCESS_KEY, EMAIL_DISABLED.

## Next 5 steps
1. Task 4: add `preferred` to pickChannel/prepare, rewrite `InvoiceService.sendInvoice` (subject, PDF attachment, flag), tests first.
2. Task 5: SNS verify + `routes/sesWebhook.ts` + `services/email-events.service.ts` + pause logic, tests first; mount in bootstrap.
3. Task 2: email-domain service, `routes/settings-email.ts`, logo endpoints, channels flag, nightly job; permissions/role-matrix/rate-limit rows.
4. env-check/.env.example, swagger.ts, migration cleanup SQL, add files to vitest.config.ts.
5. Run tsc, build, test:coverage, test:diff-coverage, eslint; write the two handoffs and the architecture doc section.
