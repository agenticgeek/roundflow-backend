# RoundFlow — Mobile API Handoff (Technician App)

> **Purpose:** everything needed to integrate the B2C technician app against the
> RoundFlow backend — exact endpoint contracts, request/response shapes, status
> codes, debt-gating policy, and gotchas.
>
> Design reference: `docs/mobile_design_findings.md` · `docs/mobile_flows.md`
> PDF with Figma screenshots: `docs/mobile_handoff.pdf`

**Base URL (dev):** `https://api-dev.roundflow.ai`  
**Content-Type:** `application/json` on all requests.  
**Auth:** `Authorization: Bearer <supabase_access_token>` on every request.  
**Tenant:** no tenant header. The tenant comes from the signed-in user's profile.  
**All routes are prefixed `/mobile`.**  
**Spec:** `GET /openapi.json` (tag "Mobile").

> **Updated 2026-10-30 (Phase 1 audit, backend item A8).** Changes: TECHNICIAN-only
> access, `NOT_YOUR_VISIT` ownership checks, the `payment` body on complete, cheque
> on debt-payment, `X-Idempotency-Key`, upsells, `VisitStatus.CANCELLED`, chat
> scoping and `isMine`. See §0.
>
> **Updated 2026-10-30 (mobile contract follow-ups).** `403 NO_PROFILE` code;
> signed read URLs (`avatarSignedUrl` on `/me`, `photoSignedUrls` on chat
> messages, `photos[].signedUrl` on visit detail); `startedAt`/`arrivedAt` on
> today's visit rows; access-issue photos (`type: ACCESS_ISSUE` upload-url +
> `photoPaths`). See §0, §3, §4, §10, §12, §14 and the new "Displaying media" note in §12.
>
> **App status (2026-10-30):** `roundflow-app` uses all of the above. The avatar and chat
> photos render from the signed URLs; the access-issue dialog attaches camera photos, which
> the offline queue uploads as `ACCESS_ISSUE` and sends as `photoPaths`; `NO_PROFILE` routes
> to the no-profile screen. Visit-detail `photos` are mapped but not displayed yet.

---

## 0. Access, errors and offline replay

**Who can call `/mobile/*`:** only profiles with role `TECHNICIAN` that are linked
to a Technician record (i.e. the invite was accepted). Otherwise every route returns:

| Status | `code` | When |
|---|---|---|
| `403` | `TECHNICIAN_ONLY` | Signed in as ADMIN / MANAGER. They use the web app. |
| `403` | `NO_TECHNICIAN` | TECHNICIAN profile with no linked Technician row. |
| `403` | `NO_PROFILE` | No profile for the signed-in user yet (invite not accepted). Show "Your invite hasn't been accepted yet". Branch on the code, not the message text. |

**Errors** are always `{ "error": string, "code"?: string }`. Show `error`; branch on `code`.

**Ownership:** `GET /mobile/visits/:id` and every `/mobile/visits/:id/*` action
check that the visit is assigned to you. If not:

```json
403 { "error": "This job is not assigned to you", "code": "NOT_YOUR_VISIT" }
```

Show "This job has been reassigned", then refetch today's visits. `404` still means
the visit doesn't exist.

**Idempotency (offline queue).** Every `/mobile/visits/:id/*` **write** accepts an
optional `X-Idempotency-Key` header (1-200 chars; use a UUID per queued action):
`start`, `arrive`, `skip`, `price`, `complete`, `access-issues`, `notes`, `photos`,
`debt-payment`, `upsells`. (`photos/upload-url` is not deduplicated: signed URLs
expire, so request a fresh one.)

| Situation | Response |
|---|---|
| No header | Runs normally. |
| First use of a key | Runs normally. A **2xx** response is stored for 7 days. |
| Same key again, same technician, same method + path | The stored status and body are replayed **without re-running the action**. Header `Idempotent-Replay: true`. |
| Key stored by another technician | `403 code: "IDEMPOTENCY_KEY_CONFLICT"` |
| Same technician, key reused for a different action or visit | `409 code: "IDEMPOTENCY_KEY_REUSED"` |
| Empty or > 200 chars | `400 code: "INVALID_IDEMPOTENCY_KEY"` |

Non-2xx responses (validation errors, 5xx) are **not** stored, so you can fix the
request and retry with the same key.

---

## 1. Data model overview

```
Technician (linked to Supabase profile via profileId)
  └── Visit[]
        ├── status: SCHEDULED | IN_PROGRESS | COMPLETED | SKIPPED | CANCELLED
        ├── price: Decimal          ← adjustable mid-job (partial service)
        ├── startedAt / arrivedAt / completedAt
        ├── paymentMethod: CASH | GOCARDLESS | BACS | CHEQUE | STRIPE | null
        ├── roundId → Round
        ├── propertyId → Property
        │     ├── customer → Customer
        │     │     ├── badDebt: boolean
        │     │     └── invoices[]  (DRAFT/SENT = outstanding)
        │     └── notes[] (RISK_WARNING | INTERNAL | ACCESS_NOTE)
        └── issues[]
```

**Today is always UTC midnight–midnight.**  
**`CANCELLED`** (new): the office paused the customer. Cancelled visits are  
**excluded** from `/mobile/rounds/today`, `/mobile/visits/today` and
`/mobile/completions`, and can't be started, skipped or completed (`409`). Every
exhaustive switch on visit status must still handle `CANCELLED`.
**`paymentMethod`** in every visit response is the *effective* method: the visit's
own, else the service plan's, else the customer's default. `null` = none set.  
`position` on a visit row is its 1-based sequence within its round for today,
computed in-memory by sorting `[date asc, createdAt asc]`.

---

## 2. GET /mobile/rounds/today — home screen round cards

Returns a summary of each round the technician has visits in today.

```
GET /mobile/rounds/today
```

**Response 200:**
```json
[
  {
    "roundId": "clg...",
    "roundName": "Alnwick Monday",
    "totalCount": 5,
    "completedCount": 2,
    "date": "2026-10-02T00:00:00.000Z"
  }
]
```

Returns `[]` if you have no visits today. `CANCELLED` visits are not counted.

---

## 3. GET /mobile/visits/today — home screen job list

Returns all visits assigned to the technician for today, sorted `[date asc, createdAt asc]`.

```
GET /mobile/visits/today
```

**Response 200:**
```json
[
  {
    "visitId": "clg...",
    "status": "IN_PROGRESS",
    "price": 52.00,
    "paymentMethod": "CASH",
    "customerName": "Sarah Brown",
    "addressLine": "23 Bailiffgate",
    "postcode": "NE66 1KJ",
    "roundId": "clg...",
    "roundName": "Alnwick Monday",
    "serviceName": "Full exterior window clean",
    "notes": null,
    "issueCount": 0,
    "propertyNotes": [
      { "type": "ACCESS_NOTE", "body": "All windows reachable from pavement." }
    ],
    "startedAt": "2026-10-02T09:15:00.000Z",
    "arrivedAt": null,
    "completedAt": null,
    "hasDebt": false,
    "position": 3
  }
]
```

**Fields:**
- `paymentMethod` — effective method (visit → plan → customer). Drives the payment sheet on complete.
- `hasDebt` — `true` if the customer has `badDebt = true`. Drives the red "Overdue" badge on home job cards.
- `position` — 1-based position within the round for today. `null` for one-off visits not part of a round.
- `startedAt` / `arrivedAt` / `completedAt` — progress timestamps (null until that step happens). Use them for "Started" / "Arrived" chips on list cards without fetching the detail.
- `propertyNotes` — array of notes on the property (type: `RISK_WARNING` | `INTERNAL` | `ACCESS_NOTE`). Used to populate the Safety Note and Access Notes cards on the job detail screen.

---

## 4. GET /mobile/visits/:id — job details screen

Full visit detail for the job details and active visit screens.

```
GET /mobile/visits/:id
```

**Response 200:**
```json
{
  "id": "clg...",
  "status": "IN_PROGRESS",
  "price": 52.00,
  "paymentMethod": "CASH",
  "notes": null,
  "skipReason": null,
  "completedAt": null,
  "startedAt": "2026-10-02T09:15:00.000Z",
  "arrivedAt": "2026-10-02T09:22:00.000Z",
  "property": {
    "id": "clg...",
    "addressLine": "12 Market Street",
    "postcode": "NE66 1AA",
    "customer": {
      "id": "clg...",
      "name": "Tom Atkinson",
      "badDebt": false,
      "invoices": []
    },
    "notes": [
      { "id": "clg...", "type": "RISK_WARNING", "body": "Uneven cobblestone at rear." },
      { "id": "clg...", "type": "ACCESS_NOTE",  "body": "Gate code: 1234." }
    ]
  },
  "round":      { "id": "clg...", "name": "Alnwick Monday" },
  "service":    { "id": "clg...", "name": "Full exterior + conservatory" },
  "technician": { "name": "James Carter", "role": "Field Technician" },
  "_count":     { "issues": 1 },
  "lastClean":  "2026-06-09T10:30:00.000Z",
  "roundPosition": { "position": 3, "total": 5 },
  "activityLog": [
    { "event": "dispatched", "timestamp": "2026-10-02T00:00:00.000Z" },
    { "event": "started",    "timestamp": "2026-10-02T09:15:00.000Z" },
    { "event": "arrived",    "timestamp": "2026-10-02T09:22:00.000Z" }
  ],
  "outstandingInvoices": [],
  "debtAmount": 0,
  "photos": [
    {
      "id": "clp...",
      "type": "BEFORE",
      "url": "<tenantId>/visits/<visitId>/before-1696248000000.jpg",
      "signedUrl": "https://<project>.supabase.co/storage/v1/object/sign/visit-photos/...?token=...",
      "issueId": null,
      "createdAt": "2026-10-02T09:20:00.000Z"
    }
  ]
}
```

**Fields:**
- `property.customer.invoices` — only invoices with status `DRAFT` or `SENT` (i.e. unpaid). Used to populate the In Debt flow.
- `lastClean` — `completedAt` of the most recent prior completed visit at this property. `null` if no prior visit.
- `roundPosition` — `{ position, total }` within today's round. `null` for one-off visits.
- `activityLog` — chronological events: `dispatched` → `started` → `arrived` → `completed`. Only events that have occurred are included.
- `outstandingInvoices` — same data as `property.customer.invoices` but with `amount` as a plain number.
- `debtAmount` — sum of all outstanding invoice amounts (£). `0` if no debt.
- `photos` — every photo on the visit, oldest first (`BEFORE` / `AFTER` / `ACCESS_ISSUE`). `url` is the stored path; display `signedUrl` (1 h, null if signing failed). `issueId` links `ACCESS_ISSUE` photos to their report.

`paymentMethod` is the effective method (visit → plan → customer) — it is `null`
only when none of the three is set, so keep a fallback picker for that case only.
The response also carries `canStart` and `blockReason` from the debt gate.

**Errors:** `403 NOT_YOUR_VISIT` · `404` visit not found.

---

## 5. PATCH /mobile/visits/:id/start — start visit

Transitions a `SCHEDULED` visit to `IN_PROGRESS` and records `startedAt`.

```
PATCH /mobile/visits/:id/start
```

No request body.

**Response 200:**
```json
{ "status": "IN_PROGRESS" }
```

**Debt-gating:** if `BusinessSettings.debtHoldEnabled = true`, the server checks
the customer's outstanding invoices before allowing the start. If the thresholds
are exceeded the request is rejected:

```json
{ "error": "Cannot start visit: customer has outstanding debt" }
```

Debt-gating thresholds (configured by admin via `PATCH /settings/payment`):

| Setting | Behaviour when `debtHoldEnabled = true` |
|---|---|
| `debtHoldMaxInvoices: null` | Block on any outstanding invoice |
| `debtHoldMaxInvoices: 2` | Only block when invoice count > 2 |
| `debtHoldMaxAmount: null` | Block on any outstanding amount |
| `debtHoldMaxAmount: 100` | Only block when total outstanding > £100 |

The check is OR — if *either* threshold is exceeded, the visit is blocked.

**Error cases:**
- `403` — debt-gating blocked (show debt warning UI, prompt to resolve before starting)
- `404` — visit not found
- `409` — visit is not `SCHEDULED` (already started, completed, or skipped)

---

## 6. PATCH /mobile/visits/:id/arrive — mark arrived

Records the technician's arrival at the property. Visit must be `IN_PROGRESS`.

```
PATCH /mobile/visits/:id/arrive
```

No request body.

**Response 200:**
```json
{ "status": "IN_PROGRESS" }
```

**Error cases:**
- `404` — visit not found
- `409` — visit is not `IN_PROGRESS`

---

## 7. PATCH /mobile/visits/:id/price — adjust price (partial service)

Adjusts the visit price mid-job when the technician can only complete part of the
work (e.g. front-of-property only, no rear access). Only allowed on `SCHEDULED`
or `IN_PROGRESS` visits.

```
PATCH /mobile/visits/:id/price
Body: { "price": 28.00 }
```

**Response 200:**
```json
{ "adjusted": true }
```

**Error cases:**
- `400` — `price` is missing, not a number, or negative
- `404` — visit not found
- `409` — visit is `COMPLETED` or `SKIPPED`

> The adjusted price is stored on the visit and used in all subsequent payment
> calculations (GoCardless charge, cash confirmation amount, invoice total).

---

## 8. PATCH /mobile/visits/:id/skip — skip property

```
PATCH /mobile/visits/:id/skip
Body: { "reason": "Gate locked", "description": "Padlock added since last visit" }
```

`reason` is required. `description` is only required when `reason = "Other"` (enforce
client-side). The stored `skipReason` is `reason` when no description, or
`"reason: description"` when both are provided.

**Response 200:**
```json
{ "status": "SKIPPED" }
```

**Error cases:**
- `400` — `reason` missing
- `404` — visit not found
- `409` — visit is already `COMPLETED`

Idempotent: calling skip on an already-`SKIPPED` visit returns `200` with no changes.

---

## 9. PATCH /mobile/visits/:id/complete — mark property complete

Marks the visit `COMPLETED` and records the payment.

```
PATCH /mobile/visits/:id/complete
X-Idempotency-Key: <uuid>            (optional, recommended)
Body: {
  "payment": { "method": "CASH" | "CHEQUE" | "NONE", "amount"?: 28.00, "chequeNumber"?: "000123" },
  "note"?: "Side gate stiff"
}
```

| `payment.method` | What happens |
|---|---|
| `CASH` | `PAID` cash Payment. `amount` = amount received; defaults to the visit price. |
| `CHEQUE` | `PENDING` cheque Payment (the office clears it when the cheque clears). `chequeNumber` **required**. `amount` defaults to the visit price. |
| `NONE` or no `payment` | The plan's method decides: `GOCARDLESS` (active mandate) → charged now, `PENDING` until the webhook; `BACS` / `CHEQUE` → `PENDING` for the office; `STRIPE` / none → no payment. If the effective method is `CASH`, `NONE` is rejected (`400 PAYMENT_CONFIRMATION_REQUIRED`): confirm the cash. |

- `cashConfirmed: true` is a **deprecated alias** for `payment: { method: "CASH" }`
  (kept for one release). If both are sent, `payment` wins.
- `note` (optional, ≤ 2000 chars) is saved as an internal property note for the office.
- No Payment is created if the visit already has one.
- The office's GHL automations get a `visit.completed` event, and the customer's
  "Visit completed" message is queued (customers who opted out are skipped).

**Validation happens before anything is written.** A `400` leaves the visit as it
was, so fix the input and call complete again.

**Response 200:**
```json
{ "id": "clg...", "status": "COMPLETED",
  "payment": { "id": "clp...", "method": "CHEQUE", "status": "PENDING", "amount": 28 } }
```
`payment` is `null` when no Payment was created (and on the idempotent repeat below).

**Error cases:**
- `400 INVALID_PAYMENT` — bad `payment` object, unknown `method`, `amount` not > 0 and ≤ 9999.99
- `400 CHEQUE_NUMBER_REQUIRED` — `CHEQUE` without `chequeNumber`
- `400 PAYMENT_CONFIRMATION_REQUIRED` — cash visit without `CASH` (or `cashConfirmed: true`)
- `403 NOT_YOUR_VISIT` · `404` visit not found
- `409` — visit is `SKIPPED` or `CANCELLED`

Idempotent: completing an already-`COMPLETED` visit returns `200 { id, status, payment: null }`
with no side effects.

---

## 10. POST /mobile/visits/:id/access-issues — report access problem

Records an access issue against the visit. Does not change visit status — the
technician must separately skip or proceed.

```
POST /mobile/visits/:id/access-issues
Body: {
  "type": "GATE_LOCKED",
  "description": "Padlock changed, old code doesn't work",
  "photoPaths": ["<tenantId>/visits/<visitId>/access_issue-1696248000000.jpg"]   // optional, max 10
}
```

**Attaching photos:** for each photo call `POST /mobile/visits/:id/photos/upload-url`
with `"type": "ACCESS_ISSUE"`, `PUT` the bytes to `signedUrl`, then send the returned
`path`s here as `photoPaths`. They're stored as `ACCESS_ISSUE` photos linked to the
issue (they appear in the visit detail `photos` with `issueId`). Paths must belong to
this visit (`<tenantId>/visits/<visitId>/…`). Do **not** record them with
`POST /photos`.

Valid `type` values: `ACCESS_PROBLEM` | `GATE_LOCKED` | `PAYMENT_ISSUE` | `DOG_LOOSE` |
`NO_REAR_ACCESS` | `UNSAFE_CONDITIONS` | `WRONG_ADDRESS` | `OTHER`

**Response 201:**
```json
{ "recorded": true, "id": "cli...", "photoCount": 1 }
```

**Error cases:**
- `400` — invalid `type` value, missing `description`, more than 10 `photoPaths`, or a path that isn't this visit's object
- `403 NOT_YOUR_VISIT` · `404` — visit not found

---

## 11. POST /mobile/visits/:id/notes — add note for office

Saves an internal property note. Not visible to the customer.

```
POST /mobile/visits/:id/notes
Body: { "text": "Conservatory panels needed extra attention today." }
```

**Response 201:**
```json
{ "recorded": true }
```

**Error cases:**
- `400` — `text` missing
- `404` — visit not found

---

## 12. Photo upload flow — two-step

Photos are uploaded directly to Supabase Storage. The flow is always:

**Step 1 — get a signed upload URL:**
```
POST /mobile/visits/:id/photos/upload-url
Body: {
  "type": "BEFORE",
  "mimeType": "image/jpeg",
  "contentLength": 1048576
}
```

`type`: `"BEFORE"` | `"AFTER"` | `"ACCESS_ISSUE"` (ACCESS_ISSUE paths go to §10 `photoPaths`, not step 3)  
`mimeType`: default `"image/jpeg"`. Allowed: `image/jpeg`, `image/png`, `image/webp`, `image/heic`  
`contentLength`: optional byte size. Rejected with `413` if it exceeds the limit (10 MB).

**Response 200:**
```json
{
  "signedUrl": "https://supabase-storage.../upload/...",
  "path": "<tenantId>/visits/<visitId>/before-1696248000000.jpg"
}
```

**Step 2 — upload the file** directly to `signedUrl` via `PUT` with the image bytes.

**Step 3 — record the photo:**
```
POST /mobile/visits/:id/photos
Body: { "type": "BEFORE", "path": "<path from step 1>" }      (or "url": "..." )
```
Send the `path` returned by step 1 (preferred; `url` is still accepted). The office
sees the photo on the visit and property galleries with a signed URL.

**Response 201:**
```json
{ "recorded": true }
```

**Error cases (upload-url):**
- `400` — invalid `type` or unsupported `mimeType`
- `403 NOT_YOUR_VISIT` · `404` — visit not found
- `413` — `contentLength` exceeds 10 MB

**Displaying media (the bucket is private).** Always store/send the `path`, and
display the server-signed read URL (1 h TTL; refetch the resource to refresh):

| Media | Stored field | Display field |
|---|---|---|
| Avatar | `GET /mobile/me` `avatarUrl` (set via `PATCH /mobile/me { avatarUrl: <path> }`) | `avatarSignedUrl` |
| Chat images | message `photoUrls[]` | `photoSignedUrls[]` (index-aligned) |
| Visit photos | `GET /mobile/visits/:id` `photos[].url` | `photos[].signedUrl` |

A signed field is `null` when signing failed or the path isn't in your tenant —
show a placeholder. External (non-storage) URLs are passed through unchanged.

---

## 13. POST /mobile/visits/:id/debt-payment — collect debt on site

Used in the In Debt flow when the technician collects the customer's outstanding
invoices on site.

```
POST /mobile/visits/:id/debt-payment
Body: { "method": "CASH" }
   or { "method": "CHEQUE", "chequeNumber": "000123" }
```

`cashConfirmed: true` is still accepted as a deprecated alias for `method: "CASH"`.

| `method` | Effect | Response 200 |
|---|---|---|
| `CASH` | All outstanding invoices → `PAID`, one `PAID` cash Payment, `badDebt` cleared. | `{ "cleared": true, "amountPaid": 80, "amountPending": 0, "method": "CASH" }` |
| `CHEQUE` | One `PENDING` cheque Payment for the total. The invoices stay open until the office clears the cheque. | `{ "cleared": false, "amountPaid": 0, "amountPending": 80, "method": "CHEQUE" }` |

With no outstanding invoices, `badDebt` is cleared and the amounts are `0`.

**Error cases:**
- `400 INVALID_PAYMENT` — `method` missing or not `CASH` / `CHEQUE`
- `400` — `chequeNumber` missing for `CHEQUE` (max 50 chars)
- `403 NOT_YOUR_VISIT` · `404` — visit not found

---

## 13a. POST /mobile/visits/:id/upsells — record an upsell

The technician records extra work sold on the job (counts toward technician KPIs).

```
POST /mobile/visits/:id/upsells
X-Idempotency-Key: <uuid>            (optional)
Body: { "description": "Gutter clear", "amount": 25.00 }
```

`description` required (≤ 500 chars). `amount` required, a number > 0 and ≤ 9999.99.

**Response 201:**
```json
{ "id": "cli...", "type": "UPSELL", "amount": 25, "note": "Gutter clear",
  "visitId": "clg...", "createdAt": "2026-10-30T10:12:00.000Z" }
```

**Error cases:** `400` validation · `403 NOT_YOUR_VISIT` · `404` visit not found.

---

## 14. Chat — GET /mobile/chat/messages

Polls for round-scoped chat messages. Recommended poll interval: **5 seconds**.

```
GET /mobile/chat/messages?roundId=clg...&since=2026-10-02T09:30:00.000Z
```

`roundId` is required and must be a round you're on (assigned to it, or holding a
visit on it), otherwise `403 code: "NOT_YOUR_ROUND"`. `since` is an ISO timestamp
cursor — only messages created after this time are returned. Omit `since` on first
load to get all messages.

**Response 200:**
```json
[
  {
    "id": "clg...",
    "roundId": "clg...",
    "senderProfileId": "clp...",
    "body": "Running 10 minutes late on stop 3.",
    "type": "TEXT",
    "visitId": null,
    "photoUrls": [],
    "photoSignedUrls": [],
    "createdAt": "2026-10-02T09:31:00.000Z",
    "isMine": true
  }
]
```

`type`: `"TEXT"` | `"WORK_PHOTOS"` | `"PHOTOS"`  
`visitId`: populated on `WORK_PHOTOS` messages to link to the visit's photo gallery.  
`senderProfileId`: the sender's **Profile id** (older messages may hold a Supabase user id).  
`isMine`: `true` when you sent it. Use this to align bubbles, not `senderProfileId`.
`photoSignedUrls`: 1 h signed read URLs for `photoUrls` (same order; entry null if unsignable). Display these.

---

## 15. Chat — POST /mobile/chat/messages

Sends a message to the round chat.

**Text message:**
```
POST /mobile/chat/messages
Body: { "roundId": "clg...", "type": "TEXT", "text": "Running 10 mins late." }
```

**Work photos notification:**
```
POST /mobile/chat/messages
Body: { "roundId": "clg...", "type": "WORK_PHOTOS", "visitId": "clg..." }
```

`type` defaults to `"TEXT"` if omitted.

**Photos message:**
```
POST /mobile/chat/messages
Body: { "roundId": "clg...", "type": "PHOTOS", "photoUrls": ["<path>"], "text"?: "Broken pane" }
```
Upload the images first with `POST /mobile/messages/attachments/upload-url { roundId, mimeType? }`
(same round check).

**Response 201:** the created message object (same shape as the GET response item, `isMine: true`).

**Error cases:**
- `400` — `roundId` missing, or `text` missing for TEXT, or `visitId` missing for WORK_PHOTOS, or empty `photoUrls` for PHOTOS
- `400` — invalid `type` value
- `403 NOT_YOUR_ROUND` — not on that round · `403 NOT_YOUR_VISIT` — WORK_PHOTOS for someone else's visit

---

## 16. GET /mobile/completions — completions / revenue screen

```
GET /mobile/completions
```

**Response 200:**
```json
{
  "revenueToday": 58.00,
  "revenueByMethod": { "cash": 30.00, "directDebit": 28.00, "other": 0 },
  "revenueChangePercent": 14,
  "completedCount": 2,
  "skippedCount": 0,
  "totalCount": 5,
  "roundName": "Alnwick Monday",
  "visits": [
    {
      "visitId": "clg...",
      "status": "COMPLETED",
      "price": 28.00,
      "paymentMethod": "DIRECT_DEBIT",
      "customerName": "Sarah Brown",
      "addressLine": "23 Bailiffgate",
      "postcode": "NE66 1KJ",
      "roundId": "clg...",
      "roundName": "Alnwick Monday",
      "serviceName": "Full exterior window clean",
      "notes": null,
      "issueCount": 0,
      "propertyNotes": [],
      "completedAt": "2026-10-02T10:45:00.000Z",
      "hasDebt": false,
      "position": null
    }
  ]
}
```

**Fields:**
- `revenueToday` — sum of `price` for `COMPLETED` visits only.
- `revenueByMethod` — `revenueToday` split by effective payment method (visit → plan → customer): `CASH` → `cash`, `GOCARDLESS` → `directDebit`, everything else → `other`.
- `CANCELLED` visits are excluded from every count.
- `revenueChangePercent` — integer percentage change vs the same technician's
  completed revenue exactly 7 days ago. `null` if no prior-week data exists.
- `visits` — only `COMPLETED` visits, sorted by `completedAt desc`.
- `roundName` — name of the first round in today's visit list (header label).

Returns zeros/empty when you have no visits today.

---

## 17. Quick reference

| Screen / Action | Method | Path | Body fields |
|---|---|---|---|
| Home — round cards | GET | `/mobile/rounds/today` | — |
| Home — job list | GET | `/mobile/visits/today` | — |
| Job details | GET | `/mobile/visits/:id` | — |
| Start visit | PATCH | `/mobile/visits/:id/start` | — |
| Mark arrived | PATCH | `/mobile/visits/:id/arrive` | — |
| Adjust price (partial job) | PATCH | `/mobile/visits/:id/price` | `price` |
| Skip property | PATCH | `/mobile/visits/:id/skip` | `reason`, `description?` |
| Complete visit | PATCH | `/mobile/visits/:id/complete` | `payment?: { method, amount?, chequeNumber? }`, `note?` (`cashConfirmed?` deprecated) |
| Report access issue | POST | `/mobile/visits/:id/access-issues` | `type`, `description`, `photoPaths?` |
| Add note for office | POST | `/mobile/visits/:id/notes` | `text` |
| Get photo upload URL | POST | `/mobile/visits/:id/photos/upload-url` | `type` (`BEFORE`/`AFTER`/`ACCESS_ISSUE`), `mimeType?`, `contentLength?` |
| Record photo | POST | `/mobile/visits/:id/photos` | `type`, `path` (or `url`) |
| Collect debt | POST | `/mobile/visits/:id/debt-payment` | `method: CASH \| CHEQUE`, `chequeNumber?` |
| Record upsell | POST | `/mobile/visits/:id/upsells` | `description`, `amount` |
| Poll chat | GET | `/mobile/chat/messages` | `?roundId=`, `?since=` |
| Send chat message | POST | `/mobile/chat/messages` | `roundId`, `type?`, `text?`, `visitId?`, `photoUrls?` |
| Completions / revenue | GET | `/mobile/completions` | — |

---

## 18. Gotchas

- **`position` is null for one-off visits.** Don't assume every visit has a round. Guard `position` and `roundId` as nullable before rendering the position badge.
- **Debt-gating is enforced server-side on start.** The mobile app should show the debt UI from `GET /mobile/visits/:id` (`debtAmount > 0` or `hasDebt = true`) and disable the Start CTA, but the `403` from `/start` is the real gate. Always handle it gracefully.
- **Price adjustment must happen before completion.** `PATCH /mobile/visits/:id/price` is rejected on `COMPLETED` / `SKIPPED` visits. Adjust the price before tapping "Mark property complete".
- **GoCardless payment is async.** After a GOCARDLESS visit completes, the payment status starts as `PENDING` — it becomes `PAID` only after the GoCardless webhook fires. Do not show a "payment confirmed" state immediately.
- **Payment is part of the complete call.** There is no separate endpoint for recording cash or a cheque. Send `payment: { method: "CASH", amount }` or `payment: { method: "CHEQUE", chequeNumber }` in `PATCH /mobile/visits/:id/complete`; send `method: "NONE"` for GoCardless / Stripe / BACS customers. `cashConfirmed: true` still works for one release.
- **Send `X-Idempotency-Key` on every queued write.** Replaying the same key returns the original response, so a completion queued offline can't be recorded twice.
- **`403 NOT_YOUR_VISIT` means the office reassigned the job.** Drop it from the local queue, show "This job has been reassigned" and refetch today.
- **Debt payment does not complete the visit.** `POST /mobile/visits/:id/debt-payment` only clears the outstanding invoices and resets `badDebt`. The technician must still proceed through the normal visit flow (start → arrive → complete) after clearing debt.
- **Photos are optional and unordered.** The API accepts any number of BEFORE and AFTER photos in any order. The app should allow adding more photos after the first without re-triggering the upload flow.
- **`since` cursor on chat poll.** Store the `createdAt` of the latest message received and pass it as `since` on the next poll. On first load, omit `since` entirely to fetch all messages.
- **`revenueChangePercent` can be negative.** Render it with a sign and colour accordingly (red for negative, green for positive).
