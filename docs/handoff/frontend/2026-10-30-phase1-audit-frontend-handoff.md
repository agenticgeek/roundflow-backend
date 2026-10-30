# RoundFlow: Phase 1 Audit Remediation, Frontend API Handoff

> **Purpose:** the exact API contracts the web app needs to close the Phase 1 audit gaps. Part 1 lists endpoints that **already exist** and only need wiring. Part 2 lists **new or changed** endpoints. **All of Part 2 is now built (2026-10-30, ships with the next deploy)**, and this doc was re-checked against the code and `openapi.json`. Part 3 lists breaking changes and rollout order. Part 4 lists where the build differs from the original plan. Part 5 records what the web has wired and how it was verified, including corrections found by the end-to-end regression run.

**Base URL (dev):** `https://api-dev.roundflow.ai`
**Auth:** `Authorization: Bearer <supabase_access_token>` on every request unless marked *public*.
**Roles:** ADMIN/MANAGER unless stated. TECHNICIAN gets `403`.
**Errors:** `{ error: string, code?: string, ...extra }`. Always show `error` to the user. Never replace it with a generic toast. `code` is for branching. Typed errors now carry extra fields generically (e.g. `fields` on `INVALID_ALLOCATION`, `suggestions` + `proposedName` on `NO_MATCHING_ROUND`), so type the error as `{ error; code?; [k: string]: unknown }`.
**Health (GAP-005):** the server now listens while tenant migrations run at boot. `GET /health` answers `503 { status: "migrating" }` until they finish, then `200 { status: "ok", timestamp }`. `GET /health/ready` is `503 { status: "migrating" }` then `200 { status: "ready" }`. Treat a 503 during a deploy as "retry shortly".
**Spec:** `GET /openapi.json` is now complete. Run `npm run generate:types` after each backend deploy and type every call from `src/api/types.gen.ts`.

---

## Part 1: Already available, wire it now

These need **no backend work**. Each fixes an audit gap on its own.

### 1.1 GAP-004: technician service areas are silently dropped
The backend reads **`serviceAreaIds: string[]`**. The web sends `serviceAreaId` (singular), which is ignored.

```http
POST /technicians            (also PATCH /technicians/:id, POST/PATCH /settings/technicians[/:id])
{ "name": "Sam", "phone": "07700900201", "email": "sam@x.co", "role": "STANDARD",
  "serviceAreaIds": ["area1", "area2"], "sendInvite": true }
→ 201 { ..., "serviceAreas": [{ "serviceAreaId": "area1", "serviceAreaName": "Alnwick", "assignedAt": "..." }, ...] }
```
Note the field names: the rows are `TechnicianServiceAreaRow` (`serviceAreaId`, `serviceAreaName`), not `{ id, name }`. `GET /technicians/:id` returns the same rows.
Files: `src/api/technicians.api.ts:56,67`, `TechniciansStep.tsx:204` (drop the client-only `extraAreaIds`), `TechnicianForm.tsx:114`.

### 1.2 GAP-024: Reports crash
`GET /reports/activity` returns a **paginated object**, not an array:
```json
{ "rows": [{ "id": "...", "type": "VISIT_COMPLETED", "message": "...", "actorName": "...", "createdAt": "..." }],
  "pagination": { "page": 1, "pageSize": 50, "total": 3, "totalPages": 1 } }
```
Wrap it in `toPaginated` like `/reports/visits` and `/reports/technicians` (`src/api/reports.api.ts:141`).

`GET /reports/revenue?period=last7|last30|last90|thisMonth|lastMonth|thisYear` is valid. `granularity` is ignored, and an unknown `period` falls back to `last30`.

### 1.3 GAP-027: Mark payment paid (bank transfer / cheque)
```http
PATCH /payments/:paymentId/status
{ "status": "PAID" | "FAILED" }
→ 200 <updated Payment>       // PAID also flips the linked invoice (matched by visitId) to PAID
404 payment not found · 409 method isn't BACS/CHEQUE · 409 already PAID
```
A PENDING BACS or cheque Payment row is created when a visit with that method is completed. `GET /customers/:id/invoices` rows now carry `paidAt` and `payment: { id, status, method } | null`, so the Payments tab has the payment id. Use this now. When **2.7 `POST /invoices/:id/mark-paid`** ships, switch to it: it also works when no payment row exists.

### 1.4 GAP-017: GHL connection
```http
POST /settings/ghl/connect-private
{ "apiKey": "pit-xxxx", "locationId": "abc123" }
→ 200 { "status": "connected", "method": "private", "webhookUrl": "https://api-dev.roundflow.ai/webhooks/ghl?tenantId=...&secret=..." }
400 bad input · 401/403 from GHL is relayed as 400 { error: "GoHighLevel rejected the API key ..." }

POST /settings/ghl/disconnect → 200 { "status": "disconnected" }
```
These are now **allowed before setup is complete**, so the card can go in both Settings and the wizard. Disconnect also clears the tenant's location id, so inbound webhooks and the outbox stop routing to it. Show `webhookUrl` with a copy button: the admin has to paste it into the GHL workflow.

### 1.5 GAP-011: Assigning a technician with a pending invite
`PUT /rounds/:id/technicians` returns `400 { error: "Cannot assign technician(s) with a pending invite: Sam, Alex" }`. Do both:
- In the picker, disable or flag technicians whose `appStatus === "PENDING_INVITE"`, with a hint and a "Resend invite" action (`POST /invites/:id/resend`).
- On failure, show `error` and stay on Review. Don't create the round first and then fail (`CreateRoundModal.tsx:541`). Assign in the same flow, or roll back with `DELETE /rounds/:id`.

### 1.6 GAP-013: Reassign button is disabled
`POST /rounds/:id/reassign` exists. The button was disabled because `fromTechnicianId` is null (visits had no technician). A1 is built: visits are stamped, and `fromTechnicianId: null` now means "the date's unassigned visits" (see 2.2). Enable the button. Note the response is now `{ updated }`.

### 1.7 Mobile endpoints are now in the spec
The `/mobile/*` routes are now in `openapi.json`. The web doesn't call them; they matter only because `types.gen.ts` will grow.

---

## Part 2: New and changed endpoints (backend delivering)

Each section names the backend item (A1…D). Every item below is built, and the shapes are as implemented.

### 2.1 Technician split and allocation (A1 · GAP-012)
```http
PUT /rounds/:id/technicians
{ "technicianIds": ["t1", "t2"],
  "split": { "mode": "SINGLE" | "AUTO" | "MANUAL",
             "allocations": [{ "propertyId": "p1", "technicianId": "t1" }] } }   // allocations only for MANUAL
→ 200 { "roundId": "r1",
        "allocation": [{ "technicianId": "t1", "name": "Sam" | null, "propertyIds": ["p1","p2"], "stops": 2, "value": "37.00" }],
        "visitsUpdated": 6 }          // BREAKING: was the RoundDetail object
400 { code: "INVALID_ALLOCATION", error, fields: { "p9": "Property not in round" } }
400 pending invite (unchanged) · 400 SINGLE with ≠ 1 technician · 404 unknown technician id

GET /rounds/:id/allocation → { "mode": "SINGLE" | "AUTO" | "MANUAL", "allocation": [...same entries] }
```
- `split` is optional. If you omit it with one technician, it means SINGLE. With two or more, it means AUTO.
- `value` is a string: the sum of the properties' ACTIVE plan prices. Future SCHEDULED visits are restamped, except ones manually overridden by a reassign.
- **BREAKING:** the PUT no longer returns the round. Refetch `GET /rounds/:id` if you need the technician list.
- Replace the "The split is a guide" copy (`content/round-planner.ts:337`). The split is now real, and each technician only sees their own properties in the app.
- MANUAL: show a property list with a technician dropdown per row. AUTO: show the returned allocation as a preview. To preview without saving, the backend accepts `?dryRun=true` on the same PUT and returns the same shape.

### 2.2 Reassign from unassigned (A1 · GAP-013)
```http
POST /rounds/:id/reassign
{ "date": "2026-11-06", "fromTechnicianId": null | "t1", "toTechnicianId": "t2",
  "scope": "REMAINING" | "ALL", "permanent": false, "note"?: string, "notify": true }
→ 200 { "updated": 4 }          // BREAKING: was { updatedCount }
404 round or target technician · 409 operational day already closed
```
- `date` defaults to today. Lowercase `scope` is still accepted. `REMAINING` = SCHEDULED/IN_PROGRESS visits; `ALL` also includes COMPLETED/SKIPPED.
- A one-off reassign marks the visits as manual overrides. `permanent: true` also moves the properties' allocation, so future visits follow.

### 2.3 Activation preview (A2 · GAP-016)
```http
GET /setup/step/11/preview?startDate=2026-10-30&cycleWeeks=4
→ 200 { "rounds": [{ "roundId": "r1", "name": "Round Fri", "firstVisit": "2026-10-30" | null, "visits": 4 }], "total": 6 }
400 bad/missing startDate, or cycleWeeks not an integer 1–52
```
Use `total` in `ActivateStep.tsx` instead of counting properties. It is computed by the same function the activation uses.

### 2.4 Payment hold (A3 · GAP-026)
The `PATCH /debt/:id/hold` response adds `visitsUpdated` (visits held or released). Behaviour:
- The customer's upcoming SCHEDULED visits get `paymentHold: true`, and releasing clears them. A paid invoice auto-releases the hold when nothing else is outstanding.
- `GET /debt/kpis.holdNextClean` and `GET /debt/board/counts.ON_HOLD` count customers on hold.
- `GET /debt/board?bucket=ON_HOLD` now lists **one row per held customer** (matching the count), even with no SENT invoice. In that bucket `invoiceId`, `invoiceNumber` and `dueDate` describe the customer's oldest SENT invoice and **can be null**. `amount` is the customer's total outstanding. Rows are sorted by `holdSince`, then `createdAt`. Disable invoice-level actions (remind, payment link) on a row with `invoiceId: null`. Hold and release are per invoice too, so **such a row can't be released from the board yet**. A customer-level hold endpoint is a backend follow-up.
- Invalidate the `today`, `rounds/planner` and `customers/:id` queries after the PATCH.

### 2.5 Pause (A4 · GAP-020) — **new visit status**
- `VisitStatus` gains **`CANCELLED`**. Visits also carry `cancelReason: string | null`. The values in use are `"PAUSED"` and `"FREQUENCY_CHANGED"`; render any other value generically.
- Pause cancels SCHEDULED visits in `[pauseStartDate, pauseEndDate]` (end inclusive; no end date = every visit from the start). Lists and planner endpoints exclude CANCELLED, and so does the customer detail's `visitHistory`. The new **`GET /customers/:id/visits?page&pageSize`** → `{ rows: [{ visitId, date, roundName, status, cancelReason, paymentStatus, notes }], pagination }` (newest first) includes them. Show a grey "Cancelled (paused)" chip.
- **Pause/resume responses (BREAKING, both `/properties/:id/*` and `/service-plans/:id/*`):**
  - `POST …/pause` → the ServicePlan row **plus** `cancelledVisits: number` and `pauseScheduled: boolean`. A future start date keeps the plan ACTIVE with the window stored (`pauseScheduled: true`), and the nightly job pauses it on the day. 409 if already PAUSED.
  - `POST …/resume` → the ServicePlan (ACTIVE, window cleared, `nextDueDate` = the round's next day). It also cancels a scheduled pause. 409 if the plan is neither paused nor has a scheduled pause. Cancelled visits are not restored.
- **Every exhaustive `switch`/map on visit status must handle `CANCELLED`** before the backend deploys.
- Invalidate `customers/:id`, `rounds/planner` and `today` after pause or resume, so the header doesn't need a reload (also an audit note).

### 2.6 Messaging, payment links and GHL (A5 · GAP-017, GAP-034)
```http
GET  /settings/ghl/status
→ { "connected": true, "method": "private" | "oauth" | null, "locationId": "abc" | null, "locationName": "Coates Windows" | null,
    "webhookUrl": "https://..." | null, "connectedAt": null }      // connectedAt is not stored yet: always null
   // not connected → connected: false and every other field null. locationName is fetched live (null if GHL is unreachable).

POST /settings/ghl/test
→ 200 { "ok": true, "locationName": "Coates Windows" | null }
409 { code: "GHL_NOT_CONNECTED" } · 502 { code: "GHL_SEND_FAILED", error }

GET  /settings/ghl/authorize?redirectUri=<optional, must be on the web app origin>
→ 200 { "url": "https://marketplace.gohighlevel.com/oauth/..." }   // now JSON (a top-level browser navigation still gets a 302 for one release)
400 redirectUri not on the FRONTEND_URL origin

GET  /settings/ghl/callback?code&state      // PUBLIC: no bearer token; the tenant comes from the signed state (HMAC, 10-min expiry)
  Accept: application/json → 200 { "status": "connected", "method": "oauth", "locationId", "webhookUrl" }
                             400 denied / code or state missing / code INVALID_STATE · 404 tenant gone · 502 GHL_SEND_FAILED
  otherwise               → 302 ${FRONTEND_URL}/settings/integrations?ghl=connected&webhookUrl=…  |  ?ghl=error&message=…
```
- There are two ways to use it:
  - (a) Omit `redirectUri`. GHL returns to the API callback, which 302s to `/settings/integrations?ghl=…`.
  - (b) Pass `redirectUri=<origin>/settings/ghl/callback` (a web page). That page relays `?code&state` to `GET /settings/ghl/callback` with `Accept: application/json` and shows the JSON result. The redirect URI must also be registered in the GHL app.
- These work **before setup completes**, so the wizard can offer "Connect messaging".

```http
POST /debt/:invoiceId/payment-link   { "channel"?: "AUTO" | "SMS" | "EMAIL" | "WHATSAPP", "message"?: string }
→ 200 { "url": "https://checkout.stripe.com/...", "messageId": "...", "channel": "SMS",
        "expiresAt": "..." | null,
        "id", "paymentUrl", "provider": "stripe" }      // deprecated aliases of messageId/url, kept for one release
409 { code: "STRIPE_NOT_CONNECTED" }  → show "Connect Stripe" CTA linking to Settings › Payments
409 { code: "GHL_NOT_CONNECTED" }     → show "Connect messaging" CTA
409 { code: "INVOICE_NOT_PAYABLE" }   → invoice is PAID/VOID
400 { code: "NO_CONTACT_FOR_CHANNEL" } → e.g. EMAIL chosen but no email on file
502 { code: "GHL_SEND_FAILED", error }

POST /debt/:invoiceId/remind   { "channel"?, "message"? }  → 200 { "messageId", "channel", "id" (deprecated) }; same GHL/contact errors
POST /invoices/:id/send        { "channel"?, "resend"?: boolean }
→ 200 { id, invoiceNumber, status, sentToCustomer, sentAt, "messageId", "channel" }
409 INVOICE_ALREADY_SENT (send again with resend: true) · 409 PAID/VOID can't be sent · same GHL/contact errors
POST /messages/send            { customerId | propertyId, "channel"?: "AUTO" | ..., body } → 201 { "status": "sent", "messageId", "channel" }
```
- `message` (payment link and remind) overrides the template. `{{var}}` placeholders still render, and the payment URL is appended if the text doesn't contain it.
- Templates used: "Payment Link", "Payment Overdue Reminder" and "Invoice Ready" (Settings › Message templates). If the tenant deleted one, a built-in fallback is used. The seeded "Invoice Ready" copy no longer says "attached".
- The invoice flips to SENT only after GHL accepts the message. GHL's message id is stored on the Message (`externalId`).
The default channel is SMS if the customer has a mobile, otherwise EMAIL. Add a channel picker to the send, remind and payment-link actions, defaulting to "Auto". **The static `pay.roundflow.app` link is gone.**

### 2.7 Stripe / GoCardless connect (A6 · GAP-036)
**Stripe: implemented in the web on 2026-10-30** (`src/lib/stripe-connect.ts`, `src/pages/StripeCallback.tsx`). Backend as built:
- The web builds `https://connect.stripe.com/oauth/authorize?...&redirect_uri=<origin>/settings/stripe/callback&state=<random>` itself (`VITE_STRIPE_CONNECT_CLIENT_ID`). It does not call `/settings/stripe/authorize`.
- The callback page checks `state`, then calls `GET /settings/stripe/callback?code&state` with `Authorization: Bearer`. **Send `Accept: application/json`**: the backend then answers `200 { "status": "connected", "stripeConnectAccountId" }` instead of a 302. The `redirect: 'manual'` opaque-redirect path still works for other Accept values.
- Errors: `400` for a denied consent or a missing code/state; **`400 code: "STRIPE_CONNECT_FAILED"`** when Stripe rejects the code (bad, already used or expired), with Stripe's reason in `error`; **`502 code: "STRIPE_UNAVAILABLE"`** when Stripe itself fails. Show `error` and offer "Connect again". (Before 2026-10-30 a rejected code was a 500.)
- The backend does **not** validate `state`. The web's own check is the only one.
- `GET /settings/stripe/authorize` still exists and returns `200 { url }` as JSON (302 only on a top-level browser navigation).
- **Config:** register the redirect URIs in Stripe → Connect → Settings.

```http
POST /settings/stripe/disconnect
POST /settings/payment/gocardless/connect     { "accessToken": "...", "environment": "sandbox" | "live" }
     → { "status": "connected", "webhookUrl": "..." }
PATCH /settings/payment/gocardless/webhook-secret { "secret": "..." }
POST /settings/payment/gocardless/disconnect
```
- **Stop sending `?access_token=` on a top-level redirect** (`src/api/settings.api.ts:58-67`). Fetch the URL with the bearer header, then navigate to it.
- All of these work **during setup** after A6. Wire the wizard's "Connect Stripe" (`SetupWizard.tsx:398`).
- **`POST /setup/step/2` no longer accepts `gocardlessConnected` / `stripeConnected`.** Remove them from `mappers.ts`. During the transition release, sending them returns `400 code: "FIELD_REMOVED"`.
- Handle the `?stripe=` and `?ghl=` query params on `/settings/integrations` with a toast.

### 2.8 Mark invoice paid (A7 · GAP-027)
```http
POST /invoices/:id/mark-paid
{ "method": "BACS" | "CHEQUE" | "CASH", "reference"?: "CHQ 000123", "paidAt"?: "2026-10-30", "amount"?: 33.00 }
→ 200 { "invoice": { id, invoiceNumber, status: "PAID", paidAt, amount },
        "payment": { id, status: "PAID", method, amount, paidAt, "reference": "CHQ 000123" | null } }
400 bad method/date · 400 AMOUNT_MISMATCH (part payments not supported) · 409 INVOICE_ALREADY_PAID · 409 INVOICE_VOID
```
- `reference` (max 100 chars) is now stored on the Payment (`Payment.reference`). Cheque numbers captured in the mobile app (on completion and on debt payment) are stored there too, so show `reference` wherever a payment is listed.
- Mark-paid also auto-releases the customer's payment hold when nothing else is outstanding.
Add a "Mark as paid" button on the Payments tab row, the invoice modal, the invoice list (2.14) and the debt board row. The modal has method, reference and date fields.

### 2.9 Business profile (B1 · GAP-001)
`POST /setup/step/1`, `PATCH /settings/business-profile` and both GETs add:
```json
{ "addressLine1": "1 Audit Street", "addressLine2": null, "town": "Alnwick", "postcode": "NE66 1TD", "vatRate": 20 }
```
Remove the `CONTRACT-DIFF … frontend-only` handling in `features/setup/lib/mappers.ts:59-110`. The VAT rate select must send a number.

### 2.10 Round settings (B2 · GAP-003)
`POST /setup/step/4` and `PATCH /settings/round-settings`:
```json
{ "defaultCycleLength": 28,
  "reminderMode": "EVENING_BEFORE" | "MORNING_OF" | "NONE",
  "reminderTime": "19:00",
  "defaultCleanMethod": "TRADITIONAL" | "WATER_FED_POLE" | "BOTH",
  "autoCreateNextVisit": true }
```
`preCleanReminderTimings` is deprecated. Stop reading it.

### 2.11 Payment defaults (GAP-008)
`POST /setup/step/2` and `PATCH /settings/payment`:
```json
{ "paymentRule": "COLLECT_AFTER_VISIT" | "COLLECT_DAILY_BATCH", "debtHoldEnabled": true, "vatInInvoices": true,
  "defaultPaymentMethod": "BACS", "invoiceDueDays": 7, "noDirectDebitAction": "SEND_INVOICE" | "SEND_PAYMENT_LINK" }
```
"Once a day for all completed visits" maps to **`COLLECT_DAILY_BATCH`** (not `COLLECT_ON_DATE`).

### 2.12 Frequency change (B3 · GAP-018)
```http
PATCH /service-plans/:id
{ "cleaningFrequency": "SIX_WEEKLY", "createRoundIfMissing"?: boolean }
→ 200 { servicePlan, "movedToRound": { "id": "r9", "name": "Alnwick Fri 6wk", "created": true } | null }   // BREAKING: was the bare plan
409 { code: "NO_MATCHING_ROUND", error, "suggestions": [{ "id", "name", "frequency", "defaultDay" }], "proposedName": "Alnwick Fri 6wk" }

PATCH /properties/:id
{ "cleaningFrequency": "SIX_WEEKLY", "createRoundIfMissing"?: boolean, ...other property fields }
→ 200 { ...Property, "movedToRound": { id, name, created } | null }
409 NO_MATCHING_ROUND (same body as above; the property is left untouched)
```
- `PATCH /properties/:id` with `cleaningFrequency` (and no `roundId`) now runs the **same** move logic. The old "Round (Six Weekly)" copy-naming path is gone, along with its 409 for a missing service area. A property with no service plan ignores the frequency.
- Use `proposedName` in the prompt rather than building the name client-side.
On 409, ask: "No 6-weekly round in Alnwick. Create 'Alnwick Fri 6wk'?" Then retry with `createRoundIfMissing: true`. Afterwards invalidate the property, round and planner queries; the header must update without a reload.

### 2.13 Photos (B4 · GAP-019)
```http
GET /properties/:id/photos?type=BEFORE|AFTER|PROPERTY|ACCESS_ISSUE&page=1&pageSize=24
GET /visits/:id/photos
GET /technicians/:id/photos?page=1
→ { "rows": [{ "id", "type": "BEFORE", "url": "https://...signed (1h)" | null, "thumbnailUrl", "takenAt", "visitId", "visitDate",
               "technician": { "id", "name" } | null }], "pagination": {...} }
```
- `pageSize` defaults to 24, max 100. `GET /visits/:id/photos` returns everything as one page, oldest first. The other two are newest first.
- `thumbnailUrl` is the same signed URL for now (no server-side thumbnails). `url` is null if signing failed, so show a placeholder.
- `type` can be **`ACCESS_ISSUE`**: photos a technician attaches to an access-issue report in the app. Label them "Access issue"; they are not before/after photos. The admin rows don't carry the issue id yet.
Replace the "Coming Soon" overlays (`TechnicianPhotos.tsx:223`, `content/property-detail.ts:603`). Signed URLs expire after 1 h, so refetch when the tab gets focus.

### 2.14 Bulk invoices for today (B5 · GAP-014)
```http
POST /invoices/bulk/preview { "date": "2026-10-30", "excludeVisitIds": [] }
→ { "items": [{ "visitId", "customerName", "address", "amount", "vat", "total", "paymentMethod" }],
    "skipped": [{ "visitId", "customerName", "reason": "ALREADY_INVOICED" | "NOT_COMPLETED" | "ON_HOLD" }],
    "totals": { "count": 12, "amount": "246.00" } }

POST /invoices/bulk { "date", "excludeVisitIds", "sendNow": false, "channel"?: ... }
→ { "created": [{ "visitId", "invoiceId", "invoiceNumber", "total", "sent": boolean }], "failed": [{ "visitId", "error", "invoiceId"? }], "totals" }
```
- One failure doesn't roll back the rest. With `sendNow: true`, an invoice that was created but not sent has `sent: false` and also appears in `failed` with its `invoiceId`.

### 2.15 Technician KPIs and incidents (B6 · GAP-025)
```http
GET /dashboard/technician-kpis   // timeOnJobMinutes, revenuePerHour now computed; strikes, damages, upsells are counts
POST /technicians/:id/incidents  { "type": "STRIKE" | "DAMAGE" | "UPSELL", "amount"?: 12.5, "note": "...", "visitId"?: "..." }
GET  /technicians/:id/incidents?type&from&to   → paginated
DELETE /technician-incidents/:id
GET  /settings/kpi-thresholds → [{ "id", "metric": "strikes" | "damages" | "revenuePerHour" | "timeOnJobMinutes" | "upsells",
                                   "operator": "GT" | "LT", "value": 3 }]
PUT  /settings/kpi-thresholds   body: the array (without id), or { "thresholds": [...] }; replaces all. 400 on a duplicate metric+operator
GET /dashboard/alerts → { skippedNeedingReview, failedPayments, complaintRevisitsDue,
                          "kpiAlerts": [{ "type": "KPI_THRESHOLD", id, technicianId, technicianName, metric, value, threshold,
                                          operator, periodKey, createdAt }] }
```
- **`alerts.kpiAlerts` is a new array field** on the existing counts object, not a mixed list. A nightly job raises the alerts, at most one per technician + metric + month (`periodKey`).
- `GET /technicians/:id/incidents` → `{ rows: TechnicianIncident[], pagination }`, newest first. `POST` → 201 `{ id, technicianId, visitId, type, amount, note, createdById, createdAt }`. A given `visitId` must exist (404 otherwise).
- `/dashboard/technician-kpis` rows also gain `upsellValue`. Strikes = STRIKE incidents + upheld complaints.
`null` now only means "no data in period". Show "—", not "Coming in a later phase".

### 2.16 Customers (GAP-010, GAP-021, GAP-022)
```http
GET /customers/search?q=coates  → [{ "id", "name", "phone", "email", "propertyCount", "postcode" | null }]   // top 10, non-cancelled
                                   // matches name/email/postcode, and phone/landline by digits (3+). 400 if q is blank
POST /setup/step/9  { ..., "customerId"?: "c1" }  → { ..., "customerMatched": true }
GET /customers, /customers/:id  → paymentStatus: "NONE" | "PAID" | "UNPAID" | "OVERDUE" | "ON_HOLD" | "FAILED"
                                   amountDue (unpaid invoices), nextDue (falls back to next visit), badDebt: boolean
PATCH /customers/:id/bad-debt   { "flag": true, "reason"?: "..." }   → { "id", "badDebt" }   // reason goes to the activity log only
PATCH /customers/:id            { ..., "messagesOptOut": true }      // NEW: stops automated messages (pre-clean reminders, visit-completed)
GET /properties/:id/notes       → includes { "pinned": true, "source": "ACCESS" | "RISK", "body": "..." } entries first
```
Map **`NONE` to a blank or "No invoices" badge**. Don't fall back to "paid" (`features/customers/lib/mappers.ts:73-79`). **BREAKING:** `paymentStatus` was lowercase (`paid`/`hold`/`pending`/`overdue`/`failed`/`none`). It is now the uppercase enum, on both list rows and detail.
- **Where the fields live:**
  - **List rows** (`GET /customers`) are keyed by `customerId` and carry `paymentStatus`, `amountDue` and `nextDue` at the top level.
  - **Detail** (`GET /customers/:id`): `paymentStatus`, `amountDue` and `nextDue` are under **`standingInfo`**, and the flag is **`customer.badDebt`**.
- Customer detail: `servicePlans` is an array. `/customers/:id/invoices` rows carry `paidAt` + `payment`.
- `UNPAID`/`OVERDUE` come only from **SENT** invoices. A DRAFT invoice isn't owed yet, so a customer whose only invoice is a draft is still `NONE`.
- Add a "No automated messages" toggle to the customer edit form, bound to `messagesOptOut` (400 if not a boolean). Manual sends (send, remind, payment link) still go out.

### 2.17 Invoice and payment lists, exports (GAP-028)
```http
GET /invoices?status=DRAFT|SENT|PAID|VOID&from&to&customerId&q&page&pageSize
→ { rows: [{ id, invoiceNumber, customer: { id, name }, total, status, issuedAt, dueDate, paidAt, paymentMethod, visitId }], pagination }
GET /payments?status&method&from&to&page&pageSize
→ { rows: [{ id, customer: { id, name }, amount, method, status, paidAt, createdAt, visitId, visitDate, invoiceId, invoiceNumber }], pagination }
GET /invoices/export.csv?…  ·  GET /payments/export.csv?…   (text/csv; download with fetch+blob, bearer header)
```

### 2.18 Complaints (GAP-029)
- `POST /complaints/:id/schedule-revisit` → the complaint plus `visitId` (null when the complaint has no property). The free revisit visit appears in the planner. Rebooking moves it instead of adding another.
- **BREAKING:** `resolvedBy` is now `{ id, name }` (was a profile id string).
- `POST /complaints/:id/resolve` accepts `upheld?: boolean` (400 if not a boolean), and complaints carry `upheld`. Upheld complaints count as strikes.
- `technicianId` accepts pending-invite technicians, so stop filtering `PENDING_INVITE` out of the "Technician involved" dropdown (`LogComplaintModal.tsx:77`, `AssignTechnicianModal.tsx:50`).

### 2.19 Technician performance, availability, replace (GAP-030)
```http
GET  /technicians/:id/performance?period=thisMonth
→ { technicianId, period, from, to, visitsCompleted, revenue, timeOnJobMinutes, revenuePerHour, strikes, damages, upsells, upsellValue, complaints }
GET  /technicians/:id/availability → [{ id, technicianId, from, to, reason, createdAt }]
POST /technicians/:id/availability { from, to, reason? } → 201 { ...window, visitsRestamped }
DELETE /technicians/:id/availability/:availabilityId → 204
POST /technicians/:id/replace { "replacementTechnicianId": "t2", "from": "2026-11-02", "to"?: "2026-11-06" | null, "notify"?: true }
→ { "visitsReassigned": 14 }
```
- `timeOnJobMinutes` and `revenuePerHour` are null when no completed visit in the period has both start and complete timestamps.
- `replace` without `to` records an open-ended unavailability window (`to` = 2099-12-31). `notify` defaults to true.

### 2.20 Small contract changes (Low)
| Gap | Change |
|---|---|
| GAP-002 | `GET /setup/status` adds `wizardSteps: [{ key, step, complete }]` in the web's 10-step order. Keys (backend step): `business-profile` (1), `service-area` (7), `round-settings` (4), `first-round` (8), `service-catalogue` (3), `technician-management` (6), `payment-setup` (2), `sms-templates` (5), `add-property` (9), `generate-visits` (11). A step is complete once it has been saved; existing mid-setup tenants are backfilled. Drive the stepper from it instead of indexing `steps[]`. |
| GAP-031 | `GET /debt/kpis` adds `totalOutstandingsCount`, `badDebtCount`. |
| GAP-032 | `POST /invoices` returns `409 code: "VISIT_NOT_COMPLETED"` for non-completed visits. Only show "Generate" on completed visits. `dueDate` defaults server-side (`invoiceDueDays`). The `POST` answers only `{ id, invoiceNumber, status, … }`; read `dueDate` and `lineItems` from `GET /invoices/:id`. A new invoice is DRAFT. |
| GAP-035 | `GET /today` rounds gain `scheduledValue` and `completedValue` (`value` is deprecated), `etaMinutes: null`, and top-level `generatedAt`. Show "Updated HH:mm" from `generatedAt` (remove the hardcoded `18:10`, `content/todays-work.ts:97`). Hide ETA when null. |
| GAP-009 | `/setup/step/9/bulk`: every row needs a `phone`. Row errors carry `error` (plus the deprecated `message`). If `cleaningFrequency` is omitted, it inherits the round's. A different frequency is a row error unless `allowFrequencyMismatch: true`. |
| GAP-010 | `POST /setup/step/9` also takes `lastCleanedDate`, which seeds `nextDueDate`. A customer with the same mobile or email is reused (`customerMatched: true`). |
| — | Automated "Visit completed" message: on completion the backend queues a message using the tenant's **"Visit completed"** template (seeded for new tenants, with a built-in fallback). It is skipped when `messagesOptOut` is set. Optional: show the template in Settings › Message templates. |
| — | `POST /webhooks/stripe` returns 503 `WEBHOOK_NOT_CONFIGURED` when the env secret is missing (ops only). |
| GAP-006 | PayPal: out of scope (not needed). No contract change. |

---

## Part 3: Breaking changes and rollout order

| Order | Web change | Must ship **before** backend item |
|---|---|---|
| 1 | Handle `VisitStatus.CANCELLED` everywhere | A4 |
| 2 | Stop sending `gocardlessConnected` / `stripeConnected` on step 2 | A6 |
| 3 | Stripe/GHL authorize: fetch JSON `{url}` then navigate. Relay callbacks with `Accept: application/json` to get JSON | A5 / A6 (the old 302 still works for one release) |
| 4 | Map the uppercase `paymentStatus` (incl. `NONE`) | GAP-021 (there is **no** lowercase fallback) |
| 5 | Use `scheduledValue`/`completedValue` | GAP-035 (`value` kept one release) |
| 6 | `PUT /rounds/:id/technicians` → `{ roundId, allocation, visitsUpdated }`; reassign → `{ updated }` | A1 (no compatibility shim) |
| 7 | `resolvedBy` object; pause/resume `cancelledVisits`/`pauseScheduled`; `PATCH /service-plans/:id` → `{ servicePlan, movedToRound }` | A4 / B3 / GAP-029 |
| 8 | Debt ON_HOLD rows with `invoiceId: null`; `alerts.kpiAlerts` | A3 / B6 |
| 9 | Everything else | can follow the backend |

**Error-display rule (all screens):** on any non-2xx, show `ApiError.message`, i.e. the server's `error`. Generic toasts are only for network failures, and then offer **Retry** (GAP-005).

---

## Part 4: Built vs planned differences

| Area | Planned (first draft of this doc) | Built |
|---|---|---|
| GHL OAuth | Authorize returns JSON; GHL redirects back to `/settings/integrations` | Also takes an optional `redirectUri` (must be on the web origin). The callback is **public**, with a signed 10-minute `state`, and `Accept: application/json` gets JSON. |
| GHL status | `connectedAt` timestamp | `connectedAt` is always `null` (not stored yet). |
| Stripe callback | — | Still **bearer-authenticated**, and the backend does **not** validate `state`. Only the GHL callback is public with signed state. Returns JSON on `Accept: application/json`. |
| Payment link response | `{ url, messageId, channel }` | Same, plus `expiresAt` and the deprecated `id`/`paymentUrl`/`provider`. Extra 409 `INVOICE_NOT_PAYABLE`. |
| Invoice send | 409 if already SENT | `resend: true` overrides it. The 409 code is `INVOICE_ALREADY_SENT`. |
| Round default service | — | `Round.defaultServiceId` exists, and invoice line text falls back visit service → plan service → round default service → "Window cleaning". **No endpoint sets it yet.** |
| Automated messages | Pre-clean reminders | Reminders (behind the `PRECLEAN_REMINDERS_ENABLED` env flag) and visit-completed messages go through the outbox. They **only drain for GHL-connected tenants**; rows wait until GHL is connected. Opted-out customers (`messagesOptOut`) are skipped. |
| Frequency change | `PATCH /service-plans/:id` only | Also `PATCH /properties/:id` (same logic, with `movedToRound` on the property response). |
| Debt ON_HOLD | Invoice rows | One row per held customer. Invoice fields can be null, and `amount` is the customer total. |
| Pause | Cancels visits | A future start is a scheduled pause (`pauseScheduled: true`), applied by the nightly job. `reason` is validated but not stored. |
| `cancelReason` | `PAUSED` / `FREQUENCY_CHANGED` / `ROUND_CHANGED` | Free string; only `PAUSED` and `FREQUENCY_CHANGED` are written today. |
| Photos | `thumbnailUrl` | Same URL as `url` (no thumbnails yet). |
| Bad debt | `reason` stored | `reason` is only written to the activity log. |
| Errors | `{ error, code? }` | Extra typed fields (`fields`, `suggestions`, `proposedName`) are forwarded generically. |
| Health | — | `/health` returns 503 `migrating` during boot migrations; new `/health/ready`. |
| PayPal (GAP-006) | Out of scope | Out of scope. |


---

## Part 5: Web implementation status (2026-10-30)

Everything in Parts 1–3 is wired in `roundflow-frontend` (working tree, uncommitted). `src/api/types.gen.ts` is regenerated from the final spec.

| Area | Where it lives in the web |
|---|---|
| Breaking shapes (Part 3) | `CANCELLED` visits and the "cancelled (paused)" chip; uppercase `paymentStatus` incl. `NONE`; allocation/`{ updated }`; `resolvedBy` object; `scheduledValue`/`completedValue`; ON_HOLD rows with `invoiceId: null`; `alerts.kpiAlerts`. |
| Setup and settings (GAP-001/002/003/008/010/016/036) | The wizard stepper follows `wizardSteps`; the address, VAT rate, reminder, clean method and payment defaults are sent and read back; the activation preview uses `total`; customer search on Add Property; Stripe (client-built consent URL + `/settings/stripe/callback` page) and GoCardless (token form + webhook secret) in both the wizard and Settings. |
| GHL (GAP-017, GAP-034) | Settings › Integrations card: status, private token, OAuth, test, webhook URL, disconnect. `?ghl=`/`?stripe=` returns are toasted. Channel picker on send, remind and payment link. `STRIPE_NOT_CONNECTED`/`GHL_NOT_CONNECTED` show a CTA. |
| Billing (GAP-014/027/028/032) | Invoices page (filters, CSV export of invoices and payments); "Mark as paid" modal on the Payments tab, invoice modal, invoice list and debt board; bulk "Create invoices for today" with preview; "Generate" only on completed visits. |
| Property detail (GAP-018/019/020/022/026) | `NO_MATCHING_ROUND` prompt in Change Frequency: "Create '<proposedName>'" (retry with `createRoundIfMissing`) or "Move to <suggestion>" (`PATCH /properties/:id { roundId }`); toast "Moved to / Created <round>". The pause toast uses `pauseScheduled`/`cancelledVisits`. Visit History from `/customers/:id/visits`, pinned notes, bad-debt flag, and a Photos tab with an `ACCESS_ISSUE` filter. |
| Operations (GAP-012/013/023/025/029/030/035) | Split step (SINGLE/AUTO/MANUAL with `dryRun` preview). Reassign is in **Today's Work** (round → "Reassign Technician"). Map week/day controls. KPI cards, incidents, thresholds editor, alerts. Complaints with `upheld`, revisit and pending-invite technicians. Technician performance, availability and replace. "Updated HH:mm". |
| Errors (GAP-005/024) | The server's `error` is shown on every non-2xx; network failures offer Retry; the route error boundary replaces the crash. |

**Accessibility fix (applies everywhere):** `<Field>` labels are now linked to their `Input`/`Textarea` through `aria-labelledby`, unless the input has its own `aria-label`. Before, those inputs were only named by their placeholder.

**Verification**
- 297 unit and component tests, with per-file 100% gates on every new file and diff coverage on every changed line (`npm run test:coverage`, `npm run test:diff-coverage`).
- The `roundflow-e2e` Playwright suite drives the real web and backend against a local database. Every gap in scope passes; GAP-017/034 skip without GHL keys.

**Corrections found by the regression run** (already reflected above):
- §1.1 service-area rows are `{ serviceAreaId, serviceAreaName, assignedAt }`.
- §2.16 detail fields are under `standingInfo` / `customer`.
- §2.20 GAP-032 `POST /invoices` returns a summary, not the invoice.
- §2.7 a rejected Stripe code is now `400 STRIPE_CONNECT_FAILED`, not a 500.

**Known web gaps:**
- A held customer without an invoice can't be released from the debt board (see 2.4).
- Access-issue photos can't be grouped by report: no `issueId` on admin rows.
