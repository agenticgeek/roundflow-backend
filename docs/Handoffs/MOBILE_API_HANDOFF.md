# RoundFlow — Mobile API Handoff (Technician App)

> **Purpose:** everything needed to integrate the B2C technician app against the
> RoundFlow backend — exact endpoint contracts, request/response shapes, status
> codes, debt-gating policy, and gotchas.
>
> Design reference: `docs/mobile_design_findings.md` · `docs/mobile_flows.md`
> PDF with Figma screenshots: `docs/mobile_handoff.pdf`

**Base URL (dev):** `http://localhost:3000`  
**Content-Type:** `application/json` on all requests.  
**Auth:** `Authorization: Bearer <supabase_access_token>` on every request.  
**Tenant header:** `x-tenant-id: <tenantId>` on every request.  
**All routes are prefixed `/mobile`.**

---

## 1. Data model overview

```
Technician (linked to Supabase profile via profileId)
  └── Visit[]
        ├── status: SCHEDULED | IN_PROGRESS | COMPLETED | SKIPPED
        ├── price: Decimal          ← adjustable mid-job (partial service)
        ├── startedAt / arrivedAt / completedAt
        ├── paymentMethod: CASH | DIRECT_DEBIT | GOCARDLESS | BACS | CHEQUE
        ├── roundId → Round
        ├── propertyId → Property
        │     ├── customer → Customer
        │     │     ├── badDebt: boolean
        │     │     └── invoices[]  (DRAFT/SENT = outstanding)
        │     └── notes[] (RISK_WARNING | INTERNAL | ACCESS_NOTE)
        └── issues[]
```

**Today is always UTC midnight–midnight.**  
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

Returns `[]` if the authenticated profile has no technician record or no visits today.

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
    "completedAt": null,
    "hasDebt": false,
    "position": 3
  }
]
```

**Fields:**
- `hasDebt` — `true` if the customer has `badDebt = true`. Drives the red "Overdue" badge on home job cards.
- `position` — 1-based position within the round for today. `null` for one-off visits not part of a round.
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
  "debtAmount": 0
}
```

**Fields:**
- `property.customer.invoices` — only invoices with status `DRAFT` or `SENT` (i.e. unpaid). Used to populate the In Debt flow.
- `lastClean` — `completedAt` of the most recent prior completed visit at this property. `null` if no prior visit.
- `roundPosition` — `{ position, total }` within today's round. `null` for one-off visits.
- `activityLog` — chronological events: `dispatched` → `started` → `arrived` → `completed`. Only events that have occurred are included.
- `outstandingInvoices` — same data as `property.customer.invoices` but with `amount` as a plain number.
- `debtAmount` — sum of all outstanding invoice amounts (£). `0` if no debt.

**Error:** `404` if visit not found.

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

Marks the visit `COMPLETED` and triggers payment collection.

```
PATCH /mobile/visits/:id/complete
Body: { "cashConfirmed": true }
```

`cashConfirmed` is only required when the effective payment method is `CASH` —
passing `false` or omitting it for a cash visit returns `400`.

**Response 200:**
```json
{ "id": "clg...", "status": "COMPLETED" }
```

**Payment side effects (automatic, no extra call needed):**

| Payment method | Behaviour |
|---|---|
| `GOCARDLESS` | If customer has an active mandate, a GoCardless payment is created immediately (status `PENDING`). Payment flips to `PAID` via webhook. |
| `CASH` | `cashConfirmed: true` required. Payment record created as `PAID` instantly. |
| `BACS` / `CHEQUE` | Payment record created as `PENDING` for manual reconciliation. |
| `DIRECT_DEBIT` | No payment record created at completion time. |

**Error cases:**
- `400` — `cashConfirmed` missing/false for a cash visit
- `404` — visit not found
- `409` — visit is already `SKIPPED`

Idempotent: completing an already-`COMPLETED` visit returns `200` immediately.

---

## 10. POST /mobile/visits/:id/access-issues — report access problem

Records an access issue against the visit. Does not change visit status — the
technician must separately skip or proceed.

```
POST /mobile/visits/:id/access-issues
Body: { "type": "GATE_LOCKED", "description": "Padlock changed, old code doesn't work" }
```

Valid `type` values: `GATE_LOCKED` | `DOG_ON_PREMISES` | `NO_REAR_ACCESS` |
`UNSAFE_CONDITIONS` | `WRONG_ADDRESS` | `OTHER`

**Response 201:**
```json
{ "recorded": true }
```

**Error cases:**
- `400` — invalid `type` value or missing `description`
- `404` — visit not found

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

`type`: `"BEFORE"` | `"AFTER"`  
`mimeType`: default `"image/jpeg"`. Allowed: `image/jpeg`, `image/png`, `image/webp`, `image/heic`  
`contentLength`: optional byte size. Rejected with `413` if it exceeds the limit (10 MB).

**Response 200:**
```json
{
  "signedUrl": "https://supabase-storage.../upload/...",
  "path": "tenants/clg.../visits/clg.../before_1696248000000.jpg"
}
```

**Step 2 — upload the file** directly to `signedUrl` via `PUT` with the image bytes.

**Step 3 — record the photo:**
```
POST /mobile/visits/:id/photos
Body: { "type": "BEFORE", "url": "https://cdn.supabase.../..." }
```

**Response 201:**
```json
{ "recorded": true }
```

**Error cases (upload-url):**
- `400` — invalid `type` or unsupported `mimeType`
- `404` — visit not found
- `413` — `contentLength` exceeds 10 MB

---

## 13. POST /mobile/visits/:id/debt-payment — collect debt in cash

Used in the In Debt flow when the technician collects outstanding invoices as cash
on-site. Marks all outstanding invoices `PAID`, creates a cash payment record,
and clears the customer's `badDebt` flag.

```
POST /mobile/visits/:id/debt-payment
Body: { "cashConfirmed": true }
```

`cashConfirmed: true` is required — enforces explicit confirmation before clearing debt.

**Response 200:**
```json
{ "cleared": true, "amountPaid": 80.00 }
```

`amountPaid` is the total of all invoices that were cleared. `0` if no
outstanding invoices existed (flag is cleared anyway).

**Error cases:**
- `400` — `cashConfirmed` missing or `false`
- `404` — visit not found

---

## 14. Chat — GET /mobile/chat/messages

Polls for round-scoped chat messages. Recommended poll interval: **5 seconds**.

```
GET /mobile/chat/messages?roundId=clg...&since=2026-10-02T09:30:00.000Z
```

`roundId` is required. `since` is an ISO timestamp cursor — only messages created
after this time are returned. Omit `since` on first load to get all messages.

**Response 200:**
```json
[
  {
    "id": "clg...",
    "roundId": "clg...",
    "senderProfileId": "uuid...",
    "body": "Running 10 minutes late on stop 3.",
    "type": "TEXT",
    "visitId": null,
    "createdAt": "2026-10-02T09:31:00.000Z"
  }
]
```

`type`: `"TEXT"` | `"WORK_PHOTOS"`  
`visitId`: populated on `WORK_PHOTOS` messages to link to the visit's photo gallery.

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

**Response 201:** the created message object (same shape as the GET response item).

**Error cases:**
- `400` — `roundId` missing, or `text` missing for TEXT, or `visitId` missing for WORK_PHOTOS
- `400` — invalid `type` value

---

## 16. GET /mobile/completions — completions / revenue screen

```
GET /mobile/completions
```

**Response 200:**
```json
{
  "revenueToday": 58.00,
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
- `revenueChangePercent` — integer percentage change vs the same technician's
  completed revenue exactly 7 days ago. `null` if no prior-week data exists.
- `visits` — only `COMPLETED` visits, sorted by `completedAt desc`.
- `roundName` — name of the first round in today's visit list (header label).

Returns zeros/empty if no technician record for the authenticated profile.

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
| Complete visit | PATCH | `/mobile/visits/:id/complete` | `cashConfirmed?` |
| Report access issue | POST | `/mobile/visits/:id/access-issues` | `type`, `description` |
| Add note for office | POST | `/mobile/visits/:id/notes` | `text` |
| Get photo upload URL | POST | `/mobile/visits/:id/photos/upload-url` | `type`, `mimeType?`, `contentLength?` |
| Record photo | POST | `/mobile/visits/:id/photos` | `type`, `url` |
| Collect debt cash | POST | `/mobile/visits/:id/debt-payment` | `cashConfirmed` |
| Poll chat | GET | `/mobile/chat/messages` | `?roundId=`, `?since=` |
| Send chat message | POST | `/mobile/chat/messages` | `roundId`, `type?`, `text?`, `visitId?` |
| Completions / revenue | GET | `/mobile/completions` | — |

---

## 18. Gotchas

- **`position` is null for one-off visits.** Don't assume every visit has a round. Guard `position` and `roundId` as nullable before rendering the position badge.
- **Debt-gating is enforced server-side on start.** The mobile app should show the debt UI from `GET /mobile/visits/:id` (`debtAmount > 0` or `hasDebt = true`) and disable the Start CTA, but the `403` from `/start` is the real gate. Always handle it gracefully.
- **Price adjustment must happen before completion.** `PATCH /mobile/visits/:id/price` is rejected on `COMPLETED` / `SKIPPED` visits. Adjust the price before tapping "Mark property complete".
- **GoCardless payment is async.** After a GOCARDLESS visit completes, the payment status starts as `PENDING` — it becomes `PAID` only after the GoCardless webhook fires. Do not show a "payment confirmed" state immediately.
- **Cash confirmation is part of the complete call.** There is no separate endpoint for recording cash. Send `cashConfirmed: true` in the body of `PATCH /mobile/visits/:id/complete`. The confirmation bottom sheet should gate on this before calling complete.
- **Debt payment does not complete the visit.** `POST /mobile/visits/:id/debt-payment` only clears the outstanding invoices and resets `badDebt`. The technician must still proceed through the normal visit flow (start → arrive → complete) after clearing debt.
- **Photos are optional and unordered.** The API accepts any number of BEFORE and AFTER photos in any order. The app should allow adding more photos after the first without re-triggering the upload flow.
- **`since` cursor on chat poll.** Store the `createdAt` of the latest message received and pass it as `since` on the next poll. On first load, omit `since` entirely to fetch all messages.
- **`revenueChangePercent` can be negative.** Render it with a sign and colour accordingly (red for negative, green for positive).
