# Wave 2B-2 frontend contract (web and app), 2026-11-06

Backend details: `docs/handoff/backend/2026-11-06-wave2b2-backend.md`. Regenerate `src/api/types.gen.ts` in web and app after this release.

## 1. Breaking changes (do these first)

1. **`GHL_NOT_CONNECTED` is gone from message sends.** `POST /messages/send`, `/messages/bulk`, `/debt/{id}/remind`, `/debt/{id}/payment-link`, `/invoices/{id}/send`, weather hold and the rest now answer `409 { code: "CHANNEL_UNAVAILABLE", reason, error }`. `reason`: `GHL_NOT_CONNECTED` (SMS/WhatsApp need GoHighLevel), `EMAIL_NOT_CONFIGURED`, `EMAIL_TURNED_OFF`, `EMAIL_PAUSED`, `EMAIL_DAILY_LIMIT`, `EMAIL_ADDRESS_INVALID`, `NO_AVAILABLE_CHANNEL`. Show `error` text; branch on `reason`. Also `409 CUSTOMER_OPTED_OUT` on a debt reminder to an opted-out customer.
2. **Default channel changed.** With no `channel`, messages go SMS (only if GHL is connected and the customer has a mobile) else EMAIL. Invoices default to EMAIL when the customer has an email. SMS/WhatsApp options must be hidden or disabled when `channels.sms` is false.
3. **Bulk invoice send skip reasons renamed**: `OPTED_OUT` -> `CUSTOMER_OPTED_OUT`, `GHL_NOT_CONNECTED` -> `NO_AVAILABLE_CHANNEL` (preview `skipped`, send `skipped[].reason`, `GET /invoices/bulk-send/{batchId}` item `code`).
4. **Broadcast result** (`/messages/bulk`, weather hold `notification`, close day): new status `skipped_no_channel`, new count `skippedNoChannel`, per-recipient `reason`. `channel` omitted = best available per customer.
5. **`POST /invoices` with `sendEmail: true` now works** (was 400 `EMAIL_NOT_AVAILABLE`). Response 201 = invoice plus `emailSent` and `pdfAttached`, or `emailSent: false` and `emailError { code, message }` (the invoice still exists, DRAFT).
6. **`GET /settings/business-profile` adds `channels`** `{ email, sms, whatsapp, calls }` (same object in `GET /settings/email`). `calls` is always true (tel: links). Hide SMS/WhatsApp when false, default to email.
7. **Debt buckets** use days since the due date (due today is not overdue; day 8 = "7 days over", day 15 = "14 days over", distinct `FOURTEEN_DAYS_OVER` bucket). **Close day** accepts `notifyCustomers` and returns `notifiedCustomers`/`customerNotificationError`. **Delete customer/property** with SENT invoices: `409 UNPAID_INVOICES { count, total }` (show in the delete dialog). **Setup steps 1 and 2** are ADMIN only (`403 ADMIN_ONLY` for MANAGER).
8. **App**: `POST /mobile/visits/{id}/complete` `payment.method` accepts CASH, CHEQUE, BACS, GOCARDLESS, STRIPE, NONE plus `collectVia`, `updateCustomerDefault`; BACS/GOCARDLESS/STRIPE record the choice (`Visit.collectedVia`) and create no cash. Mobile visit, schedule and completions rows have `paymentStatus` (nullable string).

## 2. Settings > Email and branding (web)

`GET /settings/email` (ADMIN/MANAGER) returns: `configured`, `enabled`, `paused`, `pausedReason`, `senderName`, `replyTo`, `dailyLimit`, `sentToday`, `brandColour`, `brandColourCheck`, `logoUrl` (signed), `logoAltText`, `sender { tier, from, replyTo }` (preview), `health { sampleSize, delivered, bounced, complaints, bounceRate, complaintRate }`, `domain`, `channels`.

ADMIN only (MANAGER gets `403 ADMIN_ONLY`; hide the controls):
- `PATCH /settings/email` with any of `emailSenderName`, `emailReplyTo`, `emailSenderLocalPart`, `emailEnabled`, `emailDailyLimit`, `brandColour` (#RRGGBB), `logoAltText`, `emailPaused:false` (resume after an automatic pause). 400 codes: `INVALID_EMAIL_SENDER_NAME` (no line breaks, quotes, < > ; @, max 70), `INVALID_EMAIL_ADDRESS`, `INVALID_EMAIL_LOCAL_PART`, `INVALID_BRAND_COLOUR`, `INVALID_EMAIL_DAILY_LIMIT`. The response has `warning` (non-null when the brand colour fails 4.5:1 as text on white): show it with `textColour` and `safeAccentColour`; the colour is still saved. Live preview can use `contrast` maths client side; the server is the source of truth.
- `POST /settings/email/test` sends a branded test email to the signed-in admin ("Send test to me").
- Domain: `POST /settings/email/domain { domain, localPart? }` returns `{ status: PENDING, records: [3 x {type:"CNAME",name,value}] }` (show with copy buttons); `GET /settings/email/domain` ("Check now", poll about every 30 s while PENDING); `DELETE` removes. `status` NONE | PENDING | VERIFIED | FAILED; `tier` 2 only when VERIFIED, `sendingAddress` shows what customers see. Errors: `FREE_MAIL_DOMAIN` (explain: free mailboxes cannot send as themselves; mail goes from the shared address with their name and their address as reply-to), `RESERVED_EMAIL_DOMAIN`, `INVALID_EMAIL_DOMAIN`, `EMAIL_DOMAIN_IN_USE`, `EMAIL_DOMAIN_FAILED` (502, retry), `CHANNEL_UNAVAILABLE` reason `EMAIL_NOT_CONFIGURED`.
- Logo: `POST /settings/email/logo/upload-url { mimeType: image/png|image/jpeg|image/webp }` -> `{ signedUrl, token, path }`; upload the file to `signedUrl` (same flow as visit photos), then `PUT /settings/email/logo { path, altText }` (alt text required in the UI), `DELETE` removes. SVG is not accepted.

When `paused` is true show `pausedReason` prominently (automatic pause above 0.3% complaints or 5% bounces) with a Resume button. Admins also get an in-app notification (type INTEGRATION, "Email sending paused").

## 3. Messages and invoices

- Message history: `Message.deliveryStatus` (SENT, DELIVERED, BOUNCED, COMPLAINED, FAILED; null for SMS) and `deliveryError`; show a Bounced/Complained badge. A customer's `emailInvalidAt` (bounce/complaint) means email is not used for them until the address is edited; show "email address bounced".
- Invoice send modal: channel options from `channels`; EMAIL preselected when the customer has an email; after send show `pdfAttached` (if false: "sent without the PDF"); resend uses `resend: true`.
- GHL settings section: relabel "SMS and calling (optional)"; setup wizard must be completable without it (backend never required it).
- Debt bulk remind rows may come back `{ ok:false, skipped:true, reason }` (`CUSTOMER_OPTED_OUT` | `NO_AVAILABLE_CHANNEL`): show as skipped, not as an error.

## 4. New endpoint list

`GET|PATCH /settings/email`, `POST /settings/email/test`, `GET|POST|DELETE /settings/email/domain`, `POST /settings/email/logo/upload-url`, `PUT|DELETE /settings/email/logo`, `POST /webhooks/ses` (server to server only).
