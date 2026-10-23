# GHL Automation Readiness + Payment Reconciliation — Frontend Handoff

**Date:** 2026-10-23
**Audience:** frontend developer working on the Debt Board, customer payment history, or Settings → GHL integration screens.

**Short version:** almost everything in this round of backend work is invisible to the
frontend — it's backend-to-GHL plumbing (custom fields, tags, an inbound webhook) with no API
surface change at all. **There is exactly one new endpoint**, and everything needed to build
against it is now in place — read Action Required below before starting.

---

## Action required — BACS/cheque manual payment reconciliation

### What's new
```
PATCH /payments/:id/status
Body: { "status": "PAID" | "FAILED" }
Response (200): the updated Payment row
Response (404): { "error": "Payment not found" }
Response (409): { "error": "Only BACS and cheque payments can be manually reconciled" }
Response (409): { "error": "Payment is already paid and cannot be changed" }
Response (400): { "error": "status must be PAID or FAILED" }
```
ADMIN/MANAGER only (same role gate as everywhere else — TECHNICIAN gets a 403 from the shared
middleware before this code runs).

### Why this exists
BACS and cheque payments are created as `PENDING` when a visit is completed and, until now,
**nothing ever moved them out of that state** — no webhook exists for offline payment methods,
so a manager had no way to record "the cheque cleared" or "this BACS payment never arrived."
This endpoint is that missing action.

### Where to find what you need
The customer-detail endpoint's payment history (`PaymentRow`, from
`GET /customers/:id` — see `services/customer.service.ts`) now includes both fields you need
on each row:
```json
{
  "paymentId": "pay-1",
  "method": "BACS",        // GOCARDLESS | CASH | CHEQUE | BACS | STRIPE | null
  "paymentStatus": "PENDING",
  "amount": 35,
  "...": "unchanged fields: visitId, visitDate, technicianName, invoiceStatus, invoiceId, invoiceNumber, transactionId, canGenerate, canDownload"
}
```
The Debt Board (`GET /debt/board`) still doesn't expose a `paymentId` — it operates on
invoices, not payments — so build this against the customer detail page's payment history
list, not the Debt Board.

### What to build
Next to each row in that list, show "Mark as Paid" / "Mark as Failed" buttons only when
`method` is `"BACS"` or `"CHEQUE"` **and** `paymentStatus` is `"PENDING"`. On click, call
`PATCH /payments/:paymentId/status` with `{ "status": "PAID" }` or `{ "status": "FAILED" }`
(`:paymentId` is the row's `paymentId`) and refresh the row from the response. Any other
combination of method/status should just show the existing read-only payment status, same as
today.

---

## Everything else — no action needed

- **GHL custom fields, tags, lead-handoff webhook** — 100% backend-to-GHL. RoundFlow now writes
  5 custom fields and 2 new tags to GHL contacts, and accepts a new inbound webhook shape for
  lead handoff. None of this changes any API response the frontend reads, and there's no new
  endpoint tied to it.
- **`GET /settings/ghl/*` (authorize/callback/connect-private/disconnect/status)** — unchanged.
  No new query params, no new fields.
- **`GET /settings/payment`, Debt Board endpoints (`GET /debt/*`), invoices
  (`/invoices/*`)** — unchanged.
- **Customer/property data shapes** — unchanged. The GHL writes are one-directional outbound;
  nothing comes back into any RoundFlow API response as a result of this work.
- **GHL template/Snippet sync** — this was investigated as a possible future feature
  (syncing RoundFlow's message templates with GHL) and **dropped** — turned out to be
  technically impossible against GHL's public API in either direction. Message templates
  (Setup Wizard Step 5 / Settings → Templates) stay exactly as they are; nothing to build or
  remove here.

If you're not touching the Debt Board, customer payment history, or GHL settings screens,
there is nothing in this handoff that affects you.
