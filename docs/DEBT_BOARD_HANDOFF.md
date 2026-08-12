# Debt / Payment Risk Board — Frontend Handoff

## Overview

The Debt Board is a risk management screen (`/debt-payment` in the nav) that shows all customers with outstanding invoices, grouped into buckets, with actions to chase payment.

---

## Endpoints

### 1. KPI Tiles — `GET /debt/kpis`

Returns the 5 summary numbers displayed at the top of the screen.

**Response**
```json
{
  "totalOutstandings": 2264,
  "totalOutstandingsCount": 27,
  "failedGoCardless": 5,
  "dueBeforeClean": 2,
  "holdNextClean": 5,
  "badDebt": 460,
  "badDebtCount": 3
}
```

| Field | Tile label | Sub-label |
|---|---|---|
| `totalOutstandings` | Total Outstandings (£) | "Across N customers" → use `totalOutstandingsCount` |
| `failedGoCardless` | Failed GoCardless | "Requires immediate follow-up" |
| `dueBeforeClean` | Due Before Clean | "Next clean within 7 days" |
| `holdNextClean` | Hold Next Clean | "Blocked from next visit" |
| `badDebt` | Bad Debt (£) | "Manually flagged" |

Bad Debt tile uses `badDebt` as the £ figure (not a count).

---

### 2. Board (bucket list) — `GET /debt/board`

Returns the customer cards for the currently selected tab.

**Query params**

| Param | Required | Values |
|---|---|---|
| `bucket` | Yes | See bucket keys below |
| `roundId` | No | Round ID to filter by |
| `paymentMethod` | No | `GOCARDLESS` `CASH` `CHEQUE` `BACS` `STRIPE` |

**Bucket keys**

| Tab label | `bucket` value |
|---|---|
| Invoice Sent | `INVOICE_SENT` |
| Due Before Clean | `DUE_BEFORE_CLEAN` |
| Failed GC | `FAILED_GC` |
| 7 Days Over | `SEVEN_DAYS_OVER` |
| 14 Days Over | `FOURTEEN_DAYS_OVER` |
| On Hold | `ON_HOLD` |
| Bad Debt | `BAD_DEBT` |

**Response** — array of:
```json
[
  {
    "invoiceId": "clx...",
    "invoiceNumber": "INV-2026-001",
    "amount": 35,
    "dueDate": "2026-08-20T00:00:00.000Z",
    "customerId": "clx...",
    "customerName": "Tom Richards",
    "addressLine": "5 Oak Avenue",
    "postcode": "NE61 1AB",
    "paymentMethod": "GOCARDLESS",
    "lastContactedAt": "2026-08-11T14:00:00.000Z",
    "badDebt": false,
    "holdNextClean": false
  }
]
```

`lastContactedAt` is `null` → display "Not yet contacted". Otherwise display "Last contact: X days ago".

---

### 3. Send Payment Reminder — `POST /debt/:invoiceId/remind`

Opens the "Send Payment Reminder" modal. On submit call this endpoint.

**Body**
```json
{
  "channel": "EMAIL",
  "message": "Hi Tom, just a friendly reminder..."
}
```

`channel` — `"EMAIL"` | `"SMS"` | `"WHATSAPP"`

SMS and WhatsApp are logged in the Message table but not dispatched yet (no integration). EMAIL sends via Resend.

**Errors**
- `404` — invoice not found
- `400` — channel is EMAIL but customer has no email address

**Response**
```json
{ "id": "msg-clx..." }
```

---

### 4. Send Payment Link — `POST /debt/:invoiceId/payment-link`

Opens the "Send Payment Link" modal. A payment link is auto-generated and appended to the message body before sending.

**Body**
```json
{
  "message": "Hi Tom, here is your secure payment link for £35. Please pay at your convenience."
}
```

The backend appends: `\n\nhttps://pay.roundflow.app/i/INV-2026-001`

Currently uses a placeholder URL — Stripe integration is Phase 2. The message is sent via email and recorded as a `Message` row.

**Errors**
- `404` — invoice not found
- `400` — customer has no email address

**Response**
```json
{ "id": "msg-clx..." }
```

---

### 5. Flag Bad Debt — `PATCH /debt/:invoiceId/bad-debt`

Moves the customer into (or out of) the Bad Debt bucket. Acts on the **customer**, not just the invoice.

**Body**
```json
{ "flag": true }
```

**Response**
```json
{ "customerId": "clx...", "badDebt": true }
```

---

### 6. Flag Hold Next Clean — `PATCH /debt/:invoiceId/hold`

Blocks the customer from being included in the next round clean. Acts on the **customer**.

**Body**
```json
{ "flag": true }
```

**Response**
```json
{ "customerId": "clx...", "holdNextClean": true }
```

---

## UI Flow

### Board screen

1. On mount — call `GET /debt/kpis` and `GET /debt/board?bucket=INVOICE_SENT`
2. Tab click — call `GET /debt/board?bucket=<key>` (keep round/method filters applied)
3. Round filter change — re-call board with `&roundId=<id>` (or omit for All Rounds)
4. Methods filter change — re-call board with `&paymentMethod=<value>`
5. Search — client-side filter on `customerName`, `addressLine`, `postcode`

### Customer card actions

Each card shows:
- Customer name + address
- Amount owed (in red)
- Payment method
- Last contacted label
- **Send Reminder** button → opens reminder modal
- **View Invoice** button → navigate to `/invoices/:invoiceId`
- **⋮ menu** → Flag Bad Debt / Flag Hold (toggle based on current state)

### Send Reminder modal

Fields:
- **To** — read-only, customer name
- **Send via** — SMS | WhatsApp | Email tab (send `"SMS"` | `"WHATSAPP"` | `"EMAIL"`)
- **Template** — dropdown populated from `MessageTemplate` table (frontend-driven, pass the body as `message`)
- **Message** — editable textarea; show character count
- Submit → `POST /debt/:invoiceId/remind`

### Send Payment Link modal

Fields:
- **Customer** — read-only
- **Amount to collect** — read-only from card `amount`
- **Payment Method** — currently only "Stripe Link" (Phase 2)
- **Link Expiry** — dropdown (7 days / 14 days / 30 days) — cosmetic for now; backend ignores it
- **Message** — editable textarea with default copy
- Footer note: "A unique payment link will be generated and appended to the message automatically."
- Submit → `POST /debt/:invoiceId/payment-link`

---

## Bucket Logic (for reference)

| Bucket | What's included |
|---|---|
| INVOICE_SENT | SENT invoices not bad debt, not on hold, not failed GC, not upcoming clean, not overdue >7 days |
| DUE_BEFORE_CLEAN | Customer has a scheduled visit in the next 7 days and invoice is unpaid |
| FAILED_GC | Invoice's linked visit has a `Payment` row with `status=FAILED` and `method=GOCARDLESS` |
| SEVEN_DAYS_OVER | `dueDate` is 0–7 days in the past |
| FOURTEEN_DAYS_OVER | `dueDate` is >7 days in the past |
| ON_HOLD | `customer.holdNextClean = true` (and not bad debt) |
| BAD_DEBT | `customer.badDebt = true` |

Note: buckets are not mutually exclusive by design — a customer can appear in multiple tabs. The KPI tiles are independent counts.

---

## Auth

All endpoints require:
- `Authorization: Bearer <jwt>`
- `X-Tenant-Id: <tenantId>` (or resolved via subdomain middleware)
- Role: `ADMIN` or `MANAGER`

---

## Schema changes in this branch

- `Customer.holdNextClean Boolean @default(false)` — added via migration `20260812000001_customer_hold_next_clean`
