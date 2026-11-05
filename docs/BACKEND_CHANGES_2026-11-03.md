# Backend changes - 2026-11-03 (QA bug batch, verdict-summary bugs, rulings, chat)

Audience: the web (roundflow-web), app (roundflow-app) and e2e agents. Everything below is implemented in `roundflow-backend`. Error bodies are always `{ "error": "<message>", "code"?: "<CODE>" }` (extra fields only where stated). All admin endpoints need ADMIN/MANAGER unless stated; `/mobile/*` is TECHNICIAN only.

Migration: `prisma/tenant/migrations/20261103000000_qa_bugfix_batch/migration.sql` (additive, tenant schemas). It must be applied to each tenant schema through the normal provisioning/migration path; it was NOT applied to any database by this work. `prisma generate` was run (the Windows query-engine DLL could not be replaced because it was locked by another process; the JS client and typings are regenerated, the engine binary is unchanged).

Contents: 1 Settings (reminders, payment methods) - 2 Rounds (postcode sectors, property listing) - 3 Setup/pricing - 4 Property services (PUT) - 5 Visits (assign, completion, auto-invoice) - 6 Pause/resume - 7 Customers/properties - 8 Debt bulk - 9 Templates - 10 Mobile - 11 Technicians - 12 Time zone - 13 Chat - 14 Messages inbox - 15 Pagination audit - 16 Scripts - 17 Decisions / not done.

---

## 1. Settings

### BUG-01 Pre-clean reminders are a list
`GET/PATCH /settings/round-settings`, `GET/POST /setup/step/4` (the BusinessSettings object) now include:

```jsonc
"preCleanReminders": [ { "type": "EVENING_BEFORE", "time": "19:00" }, { "type": "MORNING_OF", "time": "07:00" } ]
```
- `type`: `EVENING_BEFORE` (sent the evening before the visit, at `time`, tenant-local) or `MORNING_OF` (the morning of the visit). At most one entry per type, max 2 entries. `[]` = no reminders. `time` is `HH:mm`; omitted -> `19:00` / `07:00`.
- Request: send `preCleanReminders` (array, validated: 400 on unknown type, duplicate type, bad time, more than 2). It wins over the legacy fields.
- Legacy (still accepted, still returned): `reminderMode` (`EVENING_BEFORE|MORNING_OF|NONE`) + `reminderTime`, and the deprecated `preCleanReminderTimings`. They are converted to the list; the legacy columns follow the first list entry (`NONE` + `19:00` when the list is empty). A bare `reminderTime` re-times the first entry.
- Existing single values were migrated into the list.
- Scheduler (`src/jobs/preCleanReminders.ts`): one message per enabled entry per visit; `Visit.reminderSentTypes` records which types were sent so none goes twice (and an overlapping run cannot double-send). Outbox payload gained `reminderType`.

### BUG-05 Accepted payment methods
`GET/PATCH /settings/payment`, `GET/POST /setup/step/2`:
- New `acceptedPaymentMethods: PaymentMethod[]` (`GOCARDLESS|CASH|CHEQUE|BACS|STRIPE`). No provider connection is required to accept GOCARDLESS or STRIPE.
- `defaultPaymentMethod` must be in the list (400 otherwise). If only a default is sent while the list is empty, the list becomes `[default]`. Narrowing the list below the stored default is a 400. Existing tenants were backfilled with `[defaultPaymentMethod]` (or `[]`).
- New customers (`POST /customers`, `POST /properties`), properties added to a customer, plans and setup/CSV imports take `defaultPaymentMethod` when no method is sent (add-property: the customer's own method first). This also fixes verdict item A7.

## 2. Rounds

### BUG-04 `postcodeSectors`
- `Round.postcodeSectors: string[]` (upper-cased, deduped, e.g. `"CH41"`, `"CH41 2"`).
- Accepted on `POST /rounds`, `PATCH /rounds/:id` (`[]` clears), `POST /setup/step/8`. Returned by `GET /rounds` (summary), `GET /rounds/:id` / create / update (detail), `GET /setup/step/8`.
- Validation: 400 for an invalid sector format; when the round's service area has a `postcodeSector` (single value or comma/semicolon list) every round sector must sit inside one of them ("CH41 2" is inside "CH41"); areas without sector data are not checked.

### Round property listing
`GET /rounds/:id/properties?page=1&pageSize=50` (pageSize max 100, any page number) ->
```jsonc
{ "rows": [ { "propertyId", "addressLine", "postcode", "status", "customerId", "customerName",
              "assignedTechnicianId", "servicePlans": [ { "servicePlanId", "serviceName", "price", "status" } ] } ],
  "pagination": { "page", "pageSize", "total", "totalPages" } }
```
Cancelled properties are excluded. 404 unknown round.

## 3. Setup / import pricing (BUG-06)
`POST /setup/step/9` and `POST /setup/step/9/bulk` rows:
- With a non-empty `serviceIds` the client `price` is ignored (and is optional): one plan per distinct service id at that service's own catalogue `defaultPrice`; the property/customer total is the sum. The old even `splitPrice` logic is gone.
- The single legacy path (`serviceId` or none) keeps the supplied `price` (required there).
- Unknown service -> 404 (single) / row error field `serviceId|serviceIds` (bulk); inactive -> 400 `SERVICE_INACTIVE` / row error. Nothing is written for a rejected single request.
- `paymentMethod` omitted -> business default (BUG-05).

## 4. Property services - BUG-08
### `PUT /properties/:id/services`
Request: `{ "serviceIds": ["svcA","svcB"], "prices"?: { "svcB": 12.5 } }`
- `serviceIds` required, non-empty (400 `SERVICES_REQUIRED`), deduped. `prices` (optional): serviceId -> number >= 0 (<= 9999.99); keys must be in `serviceIds`. Applies to added services (override the catalogue price) and to kept services (re-price).
- One transaction:
  - **Added** service: new ServicePlan at catalogue price (or `prices`), inheriting `cleaningFrequency`, `paymentMethod`, `cleanMethod`, `nextDueDate` (and status + pause window) from the primary plan (oldest ACTIVE plan, else oldest PAUSED); the round comes from the property. If the primary plan has an upcoming SCHEDULED visit, a mirrored SCHEDULED visit (same date/round/technician, new plan, price) is created. A legacy plan with no service adopts the first added service instead.
  - **Removed** service: plan -> `CANCELLED`; that plan's `SCHEDULED` visits -> `CANCELLED` with `cancelReason: "SERVICE_REMOVED"`. Completed/in-progress/skipped visits and all invoices are untouched.
  - **Kept** service named in `prices`: plan price changes and its upcoming (date >= today) SCHEDULED visits that were not hand-adjusted (`originalPrice` null) get the new price.
  - An `ActivityLog` row is written (`type: PROPERTY_SERVICES_CHANGED`, `entityId` = property id, actor id/role, human `message`, `details` = `{ oldServices, newServices, added, removed }`).
- Response 200: `{ "propertyId", "servicePlans": [ { "servicePlanId", "serviceId", "serviceName", "price", "status" } ], "totalPrice", "added": [serviceIds], "removed": [serviceIds], "cancelledVisits": n }` (`servicePlans` = live ACTIVE/PAUSED plans after the change).
- Errors: 400 `SERVICES_REQUIRED`; 400 `SERVICE_INACTIVE` (only for services being added - a kept service may be inactive); 404 unknown property or service; 409 cancelled property or no live plan.

### `GET /properties/:id/services/history?page&pageSize`
`{ "rows": [ { "id", "changedAt", "actorId", "actorRole", "oldServices": [snapshot], "newServices": [snapshot], "added": [], "removed": [] } ], "pagination" }` newest first; snapshot = `{ servicePlanId, serviceId, serviceName, price }`. 404 unknown property.

## 5. Visits
### BUG-02 No auto-held visits
Generated visits (nightly job, `POST /rounds/:id/generate-visits`) and activation (setup step 11) always create `paymentHold: false`. A customer's manual hold (`PATCH /debt/:id/hold`, Pause) still holds their NEXT visits when applied and the debt gate still blocks. Existing held visits are NOT reset. Read-only PM listing: `npx tsx scripts/list-generated-held-visits.ts` (see section 16).

### `PATCH /visits/:id/assign` (B2)
`{ "technicianId": "<id>" | null }` (field required; `null` unassigns). SCHEDULED visits only. Sets `technicianOverride: true` (later restamps leave it alone, also for an unassign).
200 `{ id, status, technicianId, technicianName, technicianOverride }`. 400 technician inactive (`TECHNICIAN_INACTIVE`) / invite not accepted / missing field; 404 unknown visit or technician; 409 `VISIT_NOT_SCHEDULED`.

### Completion: `PATCH /visits/:id/complete` and `PATCH /mobile/visits/:id/complete`
Response gains `invoice: { id, status } | null`.
- **A1** An invoice is created automatically right after the completion commits (DRAFT, or PAID per A2). It is skipped (`invoice: null`) when the visit or customer is on payment hold, or the visit already has an invoice (idempotent with "Create invoices for today"); a failure in the billing step is logged and never fails the completion.
- **A2** `POST /invoices` (create invoice from a visit) and the auto-invoice: if the visit's payment is `PAID` the invoice is created `PAID` with `paidAt = payment.paidAt` and the customer's debt hold is released when settled.
- **A3** Cash (and cheque/BACS/GoCardless) defaults to the VAT-inclusive total (price + VAT when `vatInInvoices`, at `vatRate`); an explicit `payment.amount` still wins. GoCardless charges the gross pence. `POST /invoices/:id/mark-paid` already required `amount == invoice total`.
- **A6** `ServicePlan.lastCompleted` is set to the completion time (drives "Last clean").

### Close day (B6)
`POST /today/close` body gains optional `skipReason` (<= 255 chars). With `mark_as_skipped` every visit skipped by the close stores it as `Visit.skipReason` (default `"Not completed - day closed"`).

## 6. Pause / resume (item 8 review)
Path: `POST /service-plans/:id/pause|resume`, `POST /properties/:id/pause|resume`.
Defects fixed:
- A CANCELLED plan could be paused: now 409 `"Service plan is cancelled and cannot be paused"`.
- Pause dates were stored with the request's time-of-day, so the nightly pause/resume job and visit generation (which compare date-only values) started/ended a day late: `pauseStartDate`/`pauseEndDate` are now stored as UTC midnight.
- `pauseEndDate <= pauseStartDate` is now also rejected in the service (400 `"pauseEndDate must be after pauseStartDate"`), not only in the route.
Verified (tests added): held customers' and unassigned (no round) properties pause/resume without error; only `SCHEDULED` visits in the window are cancelled; a future start keeps the plan ACTIVE with the window stored (`pauseScheduled: true`); resuming a scheduled pause clears it; messages: 404 `"Service plan not found"`, 409 `"Service plan is already paused"`, 409 `"Service plan is not paused"`.

## 7. Customers / properties
- **Customer list** `GET /customers`: row `status` is `PAUSED` when the customer is ACTIVE and its (primary) plan is PAUSED (E2E-028). `?status=PAUSED` = ACTIVE customer with a PAUSED plan and no ACTIVE plan; `?status=ACTIVE` excludes those. Deleted (`CANCELLED`) customers are no longer listed unless `?status=CANCELLED`; `summary.totalCustomers` excludes them.
- **Delete consistency** `DELETE /customers/:id` (204) cancels the customer, its properties and plans and skips open visits. `DELETE /properties/:id` (204) cancels the property + plans, skips open visits, and ALSO cancels the customer when it was the customer's last live property, so the customer drops out of the list. Deleting with an unpaid invoice is still allowed (open decision B5).
- **POST /customers** (`name`, `phone?`, `email?`, `paymentMethod?`) and **POST /customers/:id/properties** (add property to an existing customer; 404 unknown customer/area/round, 409 cancelled customer, 400 `ROUND_SERVICE_AREA_MISMATCH`) are complete and covered by tests; both default the payment method (BUG-05).
- **B4** `ROUND_SERVICE_AREA_MISMATCH` (400): a round from a different service area than the property is refused by `POST /properties`, `POST /customers/:id/properties`, `PATCH /properties/:id` (round change, or an area change that no longer fits the current round) and `PATCH /customers/:id`.
- **B3 Round change** (`PATCH /properties/:id` with `roundId`, `PATCH /customers/:id` with `roundId`): when the round really changes to another round, the property's future (date >= today) `SCHEDULED` visits move to the new round (dates unchanged), get `technicianId: null`, `technicianOverride: false`, `Property.assignedTechnicianId` is cleared and each ACTIVE plan's `nextDueDate` is recomputed for the new round's day (shared helper `moveFutureVisitsToRound`, same model as the frequency-change path). Unassigning a round (`roundId: null`) does not move visits.
- **C5** Creating a property/plan with an unknown service -> 404, inactive -> 400 `SERVICE_INACTIVE`.

## 8. Debt bulk (Stage 3)
`POST /debt/bulk`
```jsonc
{ "ids": ["<invoiceId>", ...], "action": "remind" | "hold" | "bad-debt",
  "channel"?: "SMS|EMAIL|WHATSAPP|AUTO", "message"?: "...", "reason"?: "...", "notify"?: true }
```
`ids`: 1..100 invoice ids (the debt board row id), deduped. Each id runs the single-row service call (`remind` = POST /debt/:id/remind, `hold` = PATCH /debt/:id/hold flag=true with reason/notify/message, `bad-debt` = PATCH /debt/:id/bad-debt flag=true). Always 200 for a valid request:
```jsonc
{ "action", "total", "succeeded", "failed",
  "results": [ { "id", "ok": true } | { "id", "ok": false, "error": "...", "code"?: "NO_CONTACT_FOR_CHANNEL|GHL_NOT_CONNECTED|..." } ] }
```
400 for a bad `action`, empty/oversized/non-string `ids`, non-string `reason`, non-boolean `notify`.

## 9. Message templates (C5, Stage 3) - snake_case aliases are now accepted, see section 18
`POST /settings/message-templates`, `PATCH /settings/message-templates/:id`, `POST /setup/step/5` reject unknown `{{placeholders}}` in `body` and `subject`: 400 `UNKNOWN_PLACEHOLDER`. Allowed: `{{address}} {{amount}} {{businessName}} {{customerName}} {{date}} {{dueDate}} {{firstName}} {{invoiceNumber}} {{paymentLink}} {{roundName}} {{technicianName}}` (the union of every sender's variables; `[Customer Name]` style text is not checked). SMS template create (201) and delete (204) work; delete of an unknown id is 404.

## 10. Mobile app (technician)
- **C1** A deactivated technician gets `403 TECHNICIAN_INACTIVE` on every `/mobile/*` request.
- **A3** `GET /mobile/visits/:id` adds `vatAmount`, `vatRate` (0 when the business does not add VAT) and `grossTotal` = price + VAT. The cash-received default should be `grossTotal`. `price` stays net.
- **C2** `GET /mobile/visits/:id` -> `property.accessNotes` and `property.riskNotes` (free text from the customer/property forms). The app mapper (`src/api/mappers.ts`) already lists them first; nothing further needed backend-side.
- **C3** `POST /mobile/visits/:id/access-issues` now sets `Issue.propertyId` and creates a dated INTERNAL PropertyNote `"<YYYY-MM-DD> - Access problem (<TYPE>) reported by <technician name>: <description>"`.
- **A8** Collecting a debt in cash (`POST /mobile/visits/:id/debt-payment`) sets `paidAt` on the paid invoices and releases a settled hold.
- Chat additions: see section 13.

## 11. Technicians (C1 release)
Deactivating a technician (`PATCH /technicians/:id` or `PATCH /settings/technicians/:id` with `active:false`) sets their future (>= today) `SCHEDULED` visits to `technicianId: null` (`technicianOverride: false`) and clears `Property.assignedTechnicianId` that pointed at them. Generation/restamping/activation ignore inactive round technicians.

## 12. Business time zone (EMU-6)
"Today" for Today's Work, dashboard, mobile jobs/rounds, round reassign, day-close checks, technician lists and the nightly visit generation is the tenant-local calendar day: `BusinessSettings.timezone` (IANA) or `Europe/London` when unset/invalid. Dates remain UTC-midnight date-only values. Pre-clean reminders already used this zone.

## 13. Chat (office <-> technician), polling only
One thread per round. Models: `ChatMessage` gains `senderRole` (`TECHNICIAN|OFFICE`) and `clientMsgId` (unique per `(roundId, senderProfileId, clientMsgId)`); new `ChatRead(profileId, roundId, lastReadAt)`. No websocket/SSE: clients poll `since` and the unread endpoints.

Message row (all chat endpoints):
```jsonc
{ "id", "roundId", "senderProfileId", "senderRole": "TECHNICIAN"|"OFFICE", "senderName"?: "...",   // senderName: office endpoints only
  "body": "...|null", "type": "TEXT"|"PHOTOS"|"WORK_PHOTOS", "visitId": "...|null",
  "photoUrls": [...], "photoSignedUrls": [...], "clientMsgId": "...|null", "createdAt": "ISO", "isMine": true|false }
```
Rules: text 1..2000 chars (trimmed; 400 `CHAT_TEXT_TOO_LONG` above 2000); `photoUrls` max 10 and must be `"<tenantId>/chat/<roundId>/..."` paths from the chat attachment upload-url (400 `INVALID_PHOTO_URL`); `clientMsgId` max 100 chars - a repeated `(round, sender, clientMsgId)` returns the EXISTING message with 200 instead of 201 and does not notify again. List queries: `since` (ISO; ascending from that instant, strictly newer), `before` (ISO; messages older than it), `limit` 1..200 (default 100, larger values are capped). `since` + `before` together -> 400. Without `since` you get the newest `limit` messages; always returned oldest first.

### Office (ADMIN/MANAGER; technicians get 403)
- `GET /chat/threads` -> `{ "threads": [ { "roundId", "roundName", "technicians": [ { "id","name","active" } ], "lastMessage": { "id","type","body","senderRole","senderProfileId","createdAt" } | null, "unreadCount" } ] }` - rounds with at least one message, most recent activity first.
- `GET /chat/rounds/:roundId/messages?since&before&limit` -> `{ "messages": [row], "hasMore": boolean }` (hasMore: more rows exist in the direction read). 404 unknown round (also another tenant's round).
- `POST /chat/rounds/:roundId/messages` `{ "text"?, "photoUrls"?, "clientMsgId"? }` (text required unless photoUrls given) -> 201 (or 200 duplicate) row with `senderRole: "OFFICE"`. The round's active technicians (round technicians + anyone with an open visit on the round) get an in-app Notification (`type: "CHAT"`, title "New message from the office") and a best-effort push (no-op without registered devices; failures are logged, never fail the send).
- `POST /chat/rounds/:roundId/read` -> `{ "roundId", "lastReadAt" }` (read marker is per signed-in user).
- `GET /chat/unread-count` -> `{ "total", "rounds": [ { "roundId", "unread" } ] }` (rounds with unread > 0). Unread = messages from other senders newer than the user's marker (never read = all of them).

### Technician (`/mobile/chat/*`, round membership required: 403 `NOT_YOUR_ROUND`)
- `GET /mobile/chat/messages?roundId&since&before&limit` -> `[row]` (array, unchanged shape plus `senderRole`, `clientMsgId`; `limit` default 100). Rows from the office have `isMine:false`, `senderRole:"OFFICE"`.
- `POST /mobile/chat/messages` `{ roundId, type?: TEXT|PHOTOS|WORK_PHOTOS, text?, photoUrls?, visitId?, clientMsgId? }` -> 201 (200 on duplicate clientMsgId) row. WORK_PHOTOS still needs the visit to be the caller's (403 `NOT_YOUR_VISIT`).
- `GET /mobile/chat/unread[?roundId]` -> `{ total, rounds: [ { roundId, unread } ] }` over the rounds the technician is assigned to or had a visit on in the last 30 days (or just `roundId`).
- `POST /mobile/chat/read` `{ roundId }` -> `{ roundId, lastReadAt }`.

## 14. Inbound replies inbox
Inbound GHL messages already stored by the webhook (`Message.direction = INBOUND`) now carry `readAt` (null = unread).
- `GET /messages/inbox?customerId=&unreadOnly=true&page=&pageSize=` -> `{ "rows": [ { "id","customerId","customerName","channel","body","receivedAt","unread" } ], "unreadCount", "pagination": { page, pageSize, total, totalPages } }` newest first (`unreadCount` honours `customerId`).
- `POST /messages/inbox/read` `{ "ids"?: [..], "customerId"?: ".." }` -> `{ "updated": n }`; 400 when neither is given.

## 14b. Technician schedule (future and past work) - `GET /mobile/schedule`
Technician only (`/mobile/*` guard; `403 TECHNICIAN_ONLY|NO_TECHNICIAN|TECHNICIAN_INACTIVE`). Always the signed-in technician's own visits - another technician's visits can never be returned. Chosen name: `/mobile/schedule` (sits next to `/mobile/visits/today` and `/mobile/rounds/today`); the calendar summary is part of the same response, there is no separate summary endpoint.

Query (all optional): `from=YYYY-MM-DD`, `to=YYYY-MM-DD` (tenant-local days, `BusinessSettings.timezone`, default Europe/London), `page` (default 1), `pageSize` (default 100, max 200).
- Defaults: `from` = today, `to` = from + 13 days.
- Span `to - from + 1` must be <= 62 days.
- Errors: `400 INVALID_DATE_RANGE` (malformed or impossible date such as 2026-02-30, or `from` > `to`), `400 RANGE_TOO_LARGE`, `400` for bad `page`/`pageSize`.

Response 200:
```jsonc
{ "from": "2026-11-03", "to": "2026-11-16", "timeZone": "Europe/London",
  "rows": [ { /* same fields as GET /mobile/visits/today rows: visitId, status, price, paymentMethod, customerName,
                 addressLine, postcode, latitude, longitude, roundId, roundName, serviceName, notes, issueCount,
                 propertyNotes, startedAt, arrivedAt, completedAt, hasDebt, position */
             "date": "2026-11-04",        // tenant-local scheduled day
             "paymentHold": false,
             "vatAmount": 4,              // 0 when the business does not add VAT
             "grossTotal": 24 } ],        // price + VAT; equals price when no VAT
  "summary": [ { "date": "2026-11-04", "count": 3, "completedCount": 1 } ],   // whole range, days with visits only
  "pagination": { "page": 1, "pageSize": 100, "total": 3, "totalPages": 1 } }
```
- CANCELLED visits are excluded; COMPLETED and SKIPPED are included.
- `rows` are ordered by date, then round, then round order; `position` is the 1-based order within that day and round (null for visits without a round).
- `summary` and `pagination.total` cover the whole range regardless of `page`.

## 15. Pagination audit (item 9)
`GET /reports/activity` and `GET /technicians/:id/incidents` already return `{ rows, pagination: { page, pageSize, total, totalPages } }` (same shape as every other paged list); no change needed. The round property listing (section 2) is new and pages past 100 with `total`. `GET /customers?roundId=` already pages (`pagination.total`).

## 16. Scripts
`npx tsx scripts/list-generated-held-visits.ts` - READ-ONLY. Per tenant, lists open (`SCHEDULED`) generated visits (plan-linked, not one-off, not a complaint revisit) with `paymentHold = true`, with `customerOnHold` showing whether the customer still has a manual hold. Nothing is modified.

## 17. Decisions / not done
- Weather hold, disputed debt, reorder stops, post-setup CSV, scheduled messages, email invoicing, complaints from the app and technician SMS are deferred as instructed.
- B1 auto-assign unchanged. B5 (delete with unpaid invoice) left allowed.
- Property-services endpoint: a mirrored visit is only created for the primary plan's next upcoming SCHEDULED visit; later visits are produced by nightly generation. Visit dates are kept when a property changes round (only round/technician change).
- Chat notifications only create in-app Notification rows + best-effort Expo push; there is no email/SMS fallback.


---

# Part 2 - Test round 1 follow-ups (contract, written before implementation)

Decision numbers D12+ are recorded in ARCHITECTURE_LATEST.md section 17.9.

## 18. Template placeholders: both spellings accepted (replaces the 400 in section 9 for snake_case)
Applies to `POST /setup/step/5`, `POST /settings/message-templates`, `PATCH /settings/message-templates/:id` (body and subject), and rendering.
- On save, snake_case aliases are **normalised to the canonical camelCase token** (whitespace inside the braces is also trimmed), so stored templates use one form. The response returns the normalised text.
- Rendering tolerates legacy snake_case already stored (old tenants, wizard defaults saved earlier).
- Genuinely unknown tokens are still rejected: `400 UNKNOWN_PLACEHOLDER`, message lists the offending tokens as typed and the canonical allowed list.
- `[Customer Name]` style text is still not checked.

Alias table (snake_case -> canonical):

| Alias | Canonical |
|---|---|
| `customer_name` | `customerName` |
| `first_name` | `firstName` |
| `business_name` | `businessName` |
| `invoice_number` | `invoiceNumber` |
| `due_date` | `dueDate` |
| `payment_link` | `paymentLink` |
| `round_name` | `roundName` |
| `technician_name` | `technicianName` |
| `visit_date`, `next_visit_date`, `next_clean_date` | `date` |

Canonical set (unchanged): `address amount businessName customerName date dueDate firstName invoiceNumber paymentLink roundName technicianName`.

## 19. `GET /properties/:id` (single property) and the properties list on `GET /customers/:id`
`GET /properties/:id` (ADMIN/MANAGER; 404 `Property not found`):
```jsonc
{ "id", "customerId", "propertyName", "addressLine", "postcode", "latitude", "longitude", "propertyType",
  "status": "ACTIVE|CANCELLED", "accessNotes", "riskNotes",
  "serviceAreaId", "serviceAreaName", "roundId", "roundName", "roundDefaultDay", "assignedTechnicianId", "assignedTechnicianName",
  "customer": { "id", "name", "phone", "landline", "email", "status", "paymentMethod", "badDebt", "holdNextClean", "messagesOptOut" },
  "servicePlans": [ { "id", "serviceId", "serviceName", "price", "cleanMethod", "paymentMethod", "cleaningFrequency",
                      "status", "nextDueDate", "lastCompleted", "pauseStartDate", "pauseEndDate", "isPrimary" } ],
  "pause": { "state": "NONE" | "PAUSED" | "SCHEDULED", "pauseStartDate": null, "pauseEndDate": null },   // of the primary plan
  "paymentStatus": "NONE|PAID|UNPAID|OVERDUE|ON_HOLD|FAILED", "amountDue": 0,
  "nextVisit": { "id", "date", "status", "technicianId", "technicianName", "paymentHold" } | null,
  "createdAt" }
```
`pause.state`: `PAUSED` = primary plan PAUSED (dates give the window); `SCHEDULED` = plan still ACTIVE with a stored `pauseStartDate`; `NONE` otherwise. Cancelled plans are included in `servicePlans` with `status: "CANCELLED"`.

`GET /customers/:id` (already existed) now also returns **`properties`**: every property of the customer (cancelled ones included, flagged by `status`):
`[ { "id", "propertyName", "addressLine", "postcode", "status", "roundId", "roundName", "serviceAreaId", "primaryPlanStatus", "price", "nextDueDate" } ]`. The existing single-property fields stay as before (the "primary" property). Use `GET /properties/:id` for any property's page; the web must stop scanning `GET /customers`.

## 20. Customers with no property are never invisible
- `POST /customers` accepts an optional **`property`** object. Fields are those of `POST /customers/:id/properties`: `addressLine`, `postcode`, `serviceAreaId` (required), `price` (required), `serviceId?`, `propertyName?`, `propertyType?`, `cleanMethod?`, `paymentMethod?`, `nextDueDate?`, `lastCleanedDate?`, `accessNotes?`, `riskNotes?`, `roundId?`. Customer + property + first plan are created in **one transaction** (nothing is created if any part fails: 400/404 as for the property endpoints, incl. `ROUND_SERVICE_AREA_MISMATCH`, `SERVICE_INACTIVE`).
  Response 201: the Customer object as before, plus (only when `property` was sent) `propertyId`, `servicePlanId`, `assigned`.
- `GET /customers` now returns customers with **zero properties** as a row with `propertyId: null`, `addressLine: null`, `postcode: null`, `latitude/longitude/roundId/roundName/frequency/price/nextDue/nextDueDate/technician*: null` and **`hasNoProperty: true`**. Every other row has `hasNoProperty: false`. Name search finds them. The round filter and `status=HOLD` still require a property, so a property-less customer does not match those filters.
  The row's `customerId` opens `GET /customers/:id`; add a property with `POST /customers/:id/properties`.

## 21. Pause validation and cancelling a scheduled pause
- `POST /service-plans/:id/pause` and `POST /properties/:id/pause`: `pauseStartDate` before **today in the tenant time zone** -> **`400 PAUSE_START_IN_PAST`** (`"pauseStartDate must be today or later"`). Today and future dates are accepted (today pauses immediately; a future date keeps the plan ACTIVE with a stored window, `pauseScheduled: true`). The nightly job is unaffected.
- **Cancel a scheduled pause**: `POST /service-plans/:id/resume` (or `POST /properties/:id/resume`) already clears a future-dated scheduled pause on an ACTIVE plan (`pauseStartDate`/`pauseEndDate` -> null; 409 `"Service plan is not paused"` only when there is no pause at all). Use it for the web's Resume/cancel control: show it when `pause.state` is `PAUSED` or `SCHEDULED`. Visits already cancelled inside the window are not restored; `nextDueDate` is recomputed and the nightly generator creates the next visit.

## 22. Mobile
- **Round position** (`GET /mobile/visits/:id` `roundPosition: { position, total }`) now uses the same ordering and scope as the Today list and `GET /mobile/schedule`: the visit's own technician's visits in that round on the visit's day, ordered by `createdAt` then `id`, CANCELLED excluded. It no longer counts other technicians' visits and no longer changes when the visit starts. `total` = that technician's stops in the round that day.
- **Notes**: `property.notes[]` items now carry `{ id, type, body, createdAt, source: "TECHNICIAN" | "OFFICE", mine: boolean }`. The technician's own "note for office" is `type: "INTERNAL"`, `source: "TECHNICIAN"`, `mine: true`; it is **not** an access note. Access notes are only `property.accessNotes` (risk: `property.riskNotes` plus `type: "RISK_WARNING"` notes). The app must render `source === "TECHNICIAN"` notes in a separate "Notes for office" list, not under ACCESS NOTES. Notes created by the technician app now store the author profile id (older ones without an author count as `OFFICE`).

## 23. Database outage -> 503
Prisma connectivity errors (`P1001`, `P1002`, `P1017`, pool timeout `P2024`, and `PrismaClientInitializationError`) are answered **`503 { "error": "The service is temporarily unavailable. Please try again in a moment.", "code": "DATABASE_UNAVAILABLE" }`** with `Retry-After: 5`, instead of a bare 500. Clients should treat 503 as retryable.

## 24. Debt bulk and single-visit assign (shapes, for the web)
Unchanged; the full contract is in sections 5 and 8 above. `POST /debt/bulk` -> `{ action, total, succeeded, failed, results: [{ id, ok, error?, code? }] }` (HTTP 200 even when some ids fail; per-id `code` can be `NO_CONTACT_FOR_CHANNEL`, `GHL_NOT_CONNECTED`, `GHL_SEND_FAILED`; an unknown invoice id gives `error: "Invoice not found"` without a code); request validation errors are plain 400 without per-id results. `PATCH /visits/:id/assign` -> `{ id, status, technicianId, technicianName, technicianOverride }`, errors 400 (`technicianId` missing, `TECHNICIAN_INACTIVE`, invite not accepted), 404, 409 `VISIT_NOT_SCHEDULED`.

## 25. Finding templates that still hold snake_case tokens (read-only)
`npx tsx scripts/list-snake-case-templates.ts` lists, per tenant, message templates whose body or subject contains a snake_case alias, with the offending tokens. Nothing is rewritten; saving such a template from Settings normalises it (section 18), and rendering already tolerates the old form.
