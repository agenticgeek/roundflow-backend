# Backend Changes — 25 Aug 2026

Three changes shipped today. All are additive/breaking changes to existing field shapes — read each section carefully before deploying the frontend.

---

## 1. Cleaning Frequency — New Options

**What changed:** The `CleaningFrequency` enum has been replaced. The old values are gone; new values are in.

| Removed | Replaced with |
|---------|--------------|
| `FORTNIGHTLY` | — |
| `MONTHLY` | — |
| — | `TWELVE_WEEKLY` |

**Full new set:**
```
FOUR_WEEKLY    (4 weeks)
SIX_WEEKLY     (6 weeks)
EIGHT_WEEKLY   (8 weeks)
TWELVE_WEEKLY  (12 weeks)
```

**Where this appears:**
- `POST /rounds` — `frequency` field (required)
- `PATCH /rounds/:id` — `frequency` field (optional)
- `POST /setup/step/8` — `frequency` field (optional)
- Any response that includes a round object — `frequency` field

**Action required:**
- Update the dropdown in the Round Settings / Add Round form to use the four new values above
- Remove `FORTNIGHTLY` and `MONTHLY` from any hardcoded lists
- If you store the frequency label locally (e.g. for display), update your label map:
  ```
  FOUR_WEEKLY   → "4 Weekly"
  SIX_WEEKLY    → "6 Weekly"
  EIGHT_WEEKLY  → "8 Weekly"
  TWELVE_WEEKLY → "12 Weekly"
  ```
- Sending `FORTNIGHTLY` or `MONTHLY` will now return **400 Bad Request**

---

## 2. Pre-Clean Reminder Timings — Multi-Select

**What changed:** `preCleanReminderTimings` is a new field on `PATCH /settings/round-settings`. It stores up to two reminder timings as an array of strings.

**Endpoint:** `PATCH /settings/round-settings`

**New request body field:**
```json
{
  "preCleanReminderTimings": ["EVENING_BEFORE", "TWO_HOURS_BEFORE"]
}
```

**Allowed values:**
```
EVENING_BEFORE      — reminder sent the evening before the clean
TWO_HOURS_BEFORE    — reminder sent 2 hours before the clean
```

**Rules:**
- Optional — omit the field entirely to leave existing timings unchanged
- Send an empty array `[]` to clear all reminders
- Maximum 2 values
- Must be an array of strings — sending a plain string will return **400 Bad Request**

**Response:** The `BusinessSettings` object returned by `GET /settings/round-settings` now includes `preCleanReminderTimings: string[]` (empty array by default for existing records).

**Action required:**
- Replace the single-select reminder dropdown with a multi-select (max 2 selections)
- On save, send the full selected array (or omit the key if unchanged)
- On load, read `preCleanReminderTimings` from the settings response and pre-select accordingly

---

## 3. Customer Landline Number

**What changed:** A `landline` field has been added alongside the existing `phone` (mobile) field on the Customer model.

**Where this appears:**

### `POST /properties` (Add Property / Create Customer)
```json
{
  "customerName": "John Smith",
  "phone": "+44 7700 900111",
  "landline": "+44 1665 000111",
  ...
}
```

### `PATCH /customers/:id` (Edit Customer)
```json
{
  "phone": "+44 7700 900111",
  "landline": "+44 1665 000111",
  ...
}
```

**Rules:**
- Both `phone` and `landline` are optional strings, nullable
- Existing `phone` field is unchanged — this is a purely additive field
- Omitting `landline` in a PATCH leaves the existing value untouched
- Sending `landline: null` explicitly clears it

**Response:** Customer objects and the Customer Detail aggregate (`GET /customers/:id`) now include `landline: string | null`.

**Action required:**
- Add a "Landline" input field in the Add Property form (alongside the existing mobile field)
- Add a "Landline" input field in the Edit Customer modal
- Display `landline` in the customer detail view where contact info is shown

---

---

## 4. One-off Job — `POST /visits`

**What changed:** New endpoint for creating a standalone, ad-hoc visit (not tied to a service plan or recurring schedule).

**Endpoint:** `POST /visits`

**Request body:**
```json
{
  "propertyId": "cle123...",
  "date": "2026-09-03",
  "price": 45.00,
  "serviceId": "csv456...",
  "technicianId": "ctn789...",
  "roundId": null,
  "notes": "One-off gutter clean — customer rang in",
  "paymentMethod": "CASH"
}
```

| Field | Required | Notes |
|---|---|---|
| `propertyId` | **yes** | Must exist |
| `date` | **yes** | `YYYY-MM-DD` format |
| `price` | **yes** | `> 0`, max `9999.99` |
| `serviceId` | no | Must be an active service; `null` = no service |
| `technicianId` | no | Must have accepted their invite (see §5) |
| `roundId` | no | Supply to show in Round Planner; `null` = Today's Work only |
| `notes` | no | Free text |
| `paymentMethod` | no | `GOCARDLESS \| STRIPE \| CASH \| BACS \| CHEQUE` |

**Response (201):**
```json
{
  "id": "clv...",
  "date": "2026-09-03",
  "status": "SCHEDULED",
  "isOneOff": true,
  "price": 45,
  "notes": "One-off gutter clean — customer rang in",
  "paymentMethod": "CASH",
  "propertyId": "cle...",
  "addressLine": "12 Market Street",
  "postcode": "NE66 1SS",
  "customerId": "cld...",
  "customerName": "John Smith",
  "roundId": null,
  "roundName": null,
  "serviceId": "csv...",
  "serviceName": "Gutter Clean",
  "technicianId": "ctn...",
  "technicianName": "James Fisher"
}
```

**Rules:**
- `isOneOff` is always `true`, `status` is always `SCHEDULED` — not client-settable
- The visit appears in `GET /today` on the matching date
- If `roundId` is supplied, also appears in `GET /rounds/:id/planner/occurrences`

**Action required:**
- Wire the "Add One-off Job" quick action to `POST /visits`
- On success, refresh the Today's Work / Round Planner view
- Auth: `TECHNICIAN` role gets `403` — only `ADMIN`/`MANAGER` can create one-off jobs

---

## 5. Technician Assignment — Invite-Pending Validation

**What changed:** Assigning a technician who has been invited but **has not yet accepted** now returns `400` instead of silently succeeding. This applies to three operations:

| Endpoint | Operation |
|---|---|
| `PUT /rounds/:id/technicians` | Set the technician list for a round |
| `POST /rounds/:id/reassign` | Reassign today's jobs to a different technician |
| `POST /visits` | Create a one-off visit with a `technicianId` |

**Error response (400):**
```json
{ "error": "Cannot assign technician(s) with a pending invite: ctn789..." }
```
or for reassign/visit:
```json
{ "error": "Technician has not accepted their invite" }
```

**Action required:**
- When populating technician dropdowns for round assignment or one-off job creation, **only show technicians whose `appStatus` is `ACTIVE` or `INACTIVE`** — filter out `PENDING_INVITE`
- `GET /technicians` already returns `appStatus` per technician — use that field to drive the filter
- If the user somehow submits a pending technician, surface the 400 message directly

---

## Swagger Docs

All changes are documented in the live Swagger UI:
- **Dev:** https://api-dev.roundflow.ai/docs
- **QA:** https://api-qa.roundflow.ai/docs
