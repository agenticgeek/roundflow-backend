# RoundFlow — Invoicing: Frontend Handoff

> **Purpose:** everything needed to build the Generate Invoice modal (Screen 15),
> Invoice Preview modal, and the customer invoice list — exact API contracts,
> response shapes, status codes, business rules, and gotchas.

**Base URL (dev):** `http://localhost:3000`
**Content-Type:** `application/json` on all requests.
**Auth:** `Authorization: Bearer <supabase_access_token>` on every request.
**Role enforcement:** all invoice endpoints require `ADMIN` or `MANAGER`. `TECHNICIAN` gets `403`.

---

## 1. Data model overview

```
Visit (1) ──── (0..1) Invoice
  │                     ├── invoiceNumber  INV-YYYY-NNN (unique, sequential per year)
  │                     ├── status         DRAFT | SENT | PAID
  │                     ├── dueDate        nullable — set at generation time
  │                     ├── sentToCustomer bool
  │                     └── sentAt         timestamp
  │
  └── paymentMethod  falls back to Customer.paymentMethod if null on Visit
```

**One invoice per visit.** Attempting to generate a second invoice for the same visit returns `409`.

**Invoice number format:** `INV-{YEAR}-{NNN}` — sequential within the current year, zero-padded to 3 digits (e.g. `INV-2026-001`). Auto-generated — never sent by the frontend.

**VAT:** controlled by `BusinessSettings.vatInInvoices`. When `false` (default), `vatAmount` is always `0`. When `true`, VAT is calculated at 20%.

---

## 2. GET /invoices/preview?visitId= — preview before generating

Use this to populate the Generate Invoice modal before the user confirms.
**Does not write anything to the database.**

```
GET /invoices/preview?visitId=<visitId>
```

**Response 200:**
```json
{
  "invoiceNumber": "INV-2026-004",
  "invoiceDate": "2026-08-12",
  "visitDate": "2026-08-12",
  "dueDate": null,
  "paymentMethod": "GOCARDLESS",
  "customer": {
    "name": "John Smith",
    "addressLine": "12 Market Street",
    "postcode": "NE66 1SS",
    "email": "john@example.com",
    "phone": "07700 900000"
  },
  "lineItems": [
    {
      "description": "Window Cleaning Service — Alnwick Monday — 2026-08-12",
      "technicianName": "James Smith",
      "amount": 35.00
    }
  ],
  "subtotal": 35.00,
  "vatAmount": 0.00,
  "total": 35.00,
  "amount": 35.00,
  "business": {
    "name": "Acme Window Cleaning",
    "email": "support@acme.co.uk"
  }
}
```

**Error cases:**
- `400` — `visitId` query param missing.
- `404` — visit not found.
- `409` — visit already has an invoice.

> `dueDate` is always `null` on preview — the user sets it in the modal before confirming.
> `amount` is an alias of `total` — use either.

---

## 3. POST /invoices — generate invoice

Saves the invoice and optionally sends it to the customer via email in one step.

```
POST /invoices
```

**Body:**
```json
{
  "visitId": "clg...",
  "dueDate": "2026-08-26",
  "notes": "Please pay via bank transfer.",
  "sendEmail": true
}
```

| Field | Required | Notes |
|---|---|---|
| `visitId` | Yes | The visit to invoice. |
| `dueDate` | No | `YYYY-MM-DD`. If omitted, `dueDate` is stored as `null`. |
| `notes` | No | Free-form text appended to the invoice. |
| `sendEmail` | No | Default `false`. If `true`, sends the invoice email via Resend immediately and sets status to `SENT`. If `false`, status is `DRAFT`. |

**Response 201:**
```json
{
  "id": "clg...",
  "invoiceNumber": "INV-2026-004",
  "status": "DRAFT",
  "sentToCustomer": false,
  "sentAt": null
}
```

**Error cases:**
- `400` — `visitId` missing or not a string.
- `404` — visit not found.
- `409` — visit already has an invoice.

---

## 4. POST /invoices/:id/send — send or resend invoice

Sends the invoice email to the customer and marks it as `SENT`.
Use this for the "Preview Invoice → Send" flow, or to resend a draft.

```
POST /invoices/:id/send
```

No body required.

**Response 200:**
```json
{
  "id": "clg...",
  "invoiceNumber": "INV-2026-004",
  "status": "SENT",
  "sentToCustomer": true,
  "sentAt": "2026-08-12T17:00:00.000Z"
}
```

**Error cases:**
- `400` — customer has no email address on record.
- `404` — invoice not found.
- `409` — invoice is already `SENT`. Show "Already sent" UI — do not offer resend for SENT invoices.

---

## 5. GET /invoices/:id — get single invoice

```
GET /invoices/:id
```

**Response 200:**
```json
{
  "id": "clg...",
  "invoiceNumber": "INV-2026-004",
  "status": "SENT",
  "amount": 35.00,
  "dueDate": "2026-08-26T00:00:00.000Z",
  "notes": null,
  "sentToCustomer": true,
  "sentAt": "2026-08-12T17:00:00.000Z",
  "createdAt": "2026-08-12T17:00:00.000Z",
  "customerId": "clg...",
  "visitId": "clg..."
}
```

**Error cases:**
- `404` — invoice not found.

---

## 6. GET /customers/:id/invoices — list invoices for a customer

Returns all invoices for a customer, newest first.

```
GET /customers/:id/invoices
```

**Response 200:**
```json
[
  {
    "id": "clg...",
    "invoiceNumber": "INV-2026-004",
    "status": "SENT",
    "amount": 35.00,
    "dueDate": "2026-08-26T00:00:00.000Z",
    "sentToCustomer": true,
    "sentAt": "2026-08-12T17:00:00.000Z",
    "createdAt": "2026-08-12T17:00:00.000Z",
    "visitId": "clg..."
  }
]
```

Returns `[]` if the customer has no invoices (not a `404`).

---

## 7. Frontend flow — Generate Invoice modal

```
1. User clicks "Generate Invoice" on a visit row
2. GET /invoices/preview?visitId=<id>         → populate modal fields
3. User sets dueDate, notes, sendEmail toggle
4. Click "Preview Invoice"                    → render InvoicePreview component from preview data (no extra call)
5. Click "Generate & Send"
   → POST /invoices { visitId, dueDate, notes, sendEmail: true }
   → on 201: show success toast, close modal
   OR
   Click "Generate" (save as draft)
   → POST /invoices { visitId, dueDate, notes, sendEmail: false }
   → on 201: show "Saved as draft" toast, offer "Send now" button
6. "Send now" → POST /invoices/:id/send
```

---

## 8. Invoice status lifecycle

```
DRAFT ──→ SENT ──→ PAID
            ↑
     (POST /:id/send)
```

- `PAID` is set externally (payment collection flow — not yet implemented).
- Once `SENT`, the send endpoint returns `409` — do not show a resend option for `SENT` invoices.
- `dueDate` is nullable. If `null`, show "On receipt" in the UI.

---

## 9. Gotchas

- **One invoice per visit.** `GET /invoices/preview` returns `409` if the visit already has one — hide the "Generate Invoice" button if `visit.invoice` is not null.
- **sendEmail requires a customer email.** Check `customer.email` before showing the email toggle. If null, disable the toggle and show a warning.
- **VAT is always 0 unless `BusinessSettings.vatInInvoices = true`.** Don't hardcode the VAT row — use `vatAmount` from the preview response.
- **Invoice number is server-generated.** Never send it from the frontend — it is always assigned by the API.
- **`dueDate` comes back as a full ISO timestamp** (`2026-08-26T00:00:00.000Z`) on `GET` responses, but the frontend sends it as `YYYY-MM-DD` on `POST`. Parse with `.slice(0, 10)` for display.
