# RoundFlow — Customers, Properties & Rounds: Frontend Handoff

> **Purpose:** everything needed to build Screens 14, 15, and the Round Planner —
> exact API contracts, response shapes, status codes, business rules, and gotchas.
> No other doc is needed; cross-reference `/docs` (Swagger UI) if anything appears stale.

**Base URL (dev):** `http://localhost:3000`
**Content-Type:** `application/json` on all requests.
**Auth:** `Authorization: Bearer <supabase_access_token>` on every request.
**Role enforcement:** reads (`GET`) work for all roles (`ADMIN`, `MANAGER`, `TECHNICIAN`).
Mutations (`POST`, `PATCH`, `PUT`, `DELETE`) require `ADMIN` or `MANAGER` — `TECHNICIAN` gets `403`.

---

## 1. Data model overview

```
Customer (1) ──── (N) Property (1) ──── (N) ServicePlan
                      │
                      ├── roundId → Round
                      ├── serviceAreaId → ServiceArea
                      └── (N) Visit  ──── Payment, Invoice, Issues
```

- **Phase 1: one active property per customer.** Multi-property is Phase 2. All
  detail aggregates return the first active property (or first property if none active).
- **Lifecycle statuses** (`ACTIVE`, `PAUSED`, `CANCELLED`, `HOLD`):
  - `ACTIVE` — normal.
  - `PAUSED` — service paused; visits still scheduled but not charged.
  - `CANCELLED` — soft-deleted; removed from normal views.
  - `HOLD` — **derived** (not stored on Customer). A customer is `HOLD` when they have
    an open visit with `paymentHold = true`. It is **not** a DB field — it's computed
    and returned on list/detail responses.
- **`price` / `defaultPrice` come back as numbers** on customer/property responses
  (unlike the Settings service which returns them as strings). No parsing needed.

---

## 2. Customers — Screen 14 (list) + Screen 15 (detail)

### 2.1 GET /customers — list + KPIs

```
GET /customers
  ?search=         case-insensitive contains on customerName / addressLine / postcode
  ?roundId=        filter to properties assigned to this round
  ?status=         ACTIVE | PAUSED | CANCELLED | HOLD
  ?page=           1-based (default 1)
  ?pageSize=       max 100, default 50
```

**Response 200:**
```json
{
  "summary": {
    "totalCustomers": 42,
    "active": 38,
    "paymentHolds": 2,
    "amountDue": 340.00
  },
  "customers": [
    {
      "customerId": "cld...",
      "customerName": "John Smith",
      "status": "ACTIVE",
      "propertyId": "cle...",
      "addressLine": "12 Market Street",
      "postcode": "NE66 1SS",
      "roundId": "clf...",
      "roundName": "Alnwick Monday",
      "frequency": "FORTNIGHTLY",
      "price": 35,
      "technicianId": "clg...",
      "technicianName": "James Fisher",
      "nextDueDate": "2026-08-04T00:00:00.000Z",
      "paymentStatus": "paid",
      "onHold": false,
      "amountDue": 0
    }
  ],
  "pagination": {
    "page": 1,
    "pageSize": 50,
    "total": 42,
    "totalPages": 1
  }
}
```

**KPI notes:**
- `summary` is always **business-wide** — it ignores the current filter. Show it in the
  top cards regardless of what the user is searching/filtering.
- `amountDue` (summary and per-row) is **omitted entirely** for `TECHNICIAN` viewers —
  check for `undefined`, don't assume zero.
- `paymentStatus` badge values: `"paid"` · `"pending"` · `"overdue"` · `"failed"` ·
  `"hold"` · `"none"` (no payment history yet — render blank/dash, not "Paid").

**`HOLD` filter behaviour:**
`HOLD` is computed in memory (not a DB column), so the backend fetches all customers
and filters after. For large databases this is slower than other statuses — avoid
unnecessarily combining it with other filters.

**Errors:** `400` invalid `status` value · `401` · `403`.

---

### 2.2 POST /customers — create standalone customer

Creates a customer record with no property attached. Use this when you want to set up
a customer first and add their property later via `POST /customers/:id/properties`.

```
POST /customers
{
  "name": "Sarah Jones",          // required
  "phone": "+44 7700 900222",     // optional
  "email": "sarah@example.com",   // optional
  "paymentMethod": "GOCARDLESS"   // optional, ∈ GOCARDLESS | STRIPE | CASH | BACS | CHEQUE
}
→ 201 { ...Customer row }
```

**Errors:** `400` missing `name` · `401` · `403`.

---

### 2.3 GET /customers/:id — full detail aggregate

Returns all six Screen 15 tabs in one call.

**Response 200:**
```json
{
  "customer": {
    "id": "cld...",
    "name": "John Smith",
    "phone": "+44 7700 900222",
    "email": "john@example.com",
    "status": "ACTIVE",
    "ghlContactId": null
  },
  "property": {
    "id": "cle...",
    "addressLine": "12 Market Street",
    "postcode": "NE66 1SS",
    "propertyType": "HOUSE",
    "accessNotes": "Key under mat",
    "riskNotes": null,
    "status": "ACTIVE",
    "roundId": "clf...",
    "roundName": "Alnwick Monday",
    "serviceAreaId": "clh..."
  },
  "servicePlan": {
    "id": "clm...",
    "serviceId": "cln...",
    "serviceName": "Full exterior window clean",
    "price": 35,
    "cleanMethod": "Water Fed Pole",
    "paymentMethod": "GOCARDLESS",
    "cleaningFrequency": "FORTNIGHTLY",
    "status": "ACTIVE",
    "nextDueDate": "2026-08-04T00:00:00.000Z",
    "lastCompleted": "2026-07-21T00:00:00.000Z",
    "pauseStartDate": null,
    "pauseEndDate": null,
    "paymentRule": "COLLECT_AFTER_VISIT"
  },
  "standingInfo": {
    "frequency": "FORTNIGHTLY",
    "assignedRound": "Alnwick Monday",
    "technicianName": "James Fisher",
    "paymentStatus": "paid",
    "outstandingBalance": 0,
    "lastPaymentDate": "2026-07-21T10:00:00.000Z",
    "issuesCount": 0,
    "nextVisitStatus": "SCHEDULED"
  },
  "tabs": {
    "overview": {
      "addressLine": "12 Market Street",
      "postcode": "NE66 1SS",
      "propertyType": "HOUSE",
      "accessNotes": "Key under mat",
      "riskNotes": null,
      "contact": { "name": "John Smith", "phone": "+44 7700 900222", "email": "john@example.com" }
    },
    "servicePlan": { /* same shape as servicePlan above */ },
    "visitHistory": [
      {
        "visitId": "clp...",
        "date": "2026-07-21T00:00:00.000Z",
        "roundName": "Alnwick Monday",
        "status": "COMPLETED",
        "paymentStatus": "PAID",
        "notes": "Gate was locked, used side access"
      }
    ],
    "payments": {
      "rows": [
        {
          "visitId": "clp...",
          "visitDate": "2026-07-21T00:00:00.000Z",
          "technicianName": "James Fisher",
          "amount": 35,
          "paymentStatus": "PAID",
          "paymentId": "clq...",
          "invoiceStatus": "SENT",
          "invoiceId": "clr...",
          "invoiceNumber": "INV-0001",
          "transactionId": "GC-123",
          "canGenerate": false,
          "canDownload": true
        }
      ]
    },
    "notes": [
      {
        "id": "cls...",
        "type": "INTERNAL",
        "body": "Customer prefers morning visits",
        "authorProfileId": "clt...",
        "authorName": null,
        "createdAt": "2026-07-21T10:00:00.000Z"
      }
    ],
    "photos": []
  }
}
```

**Field notes:**
- `property` is `null` if the customer has no property yet (standalone customer).
- `servicePlan` is `null` if no service plan exists.
- `tabs.payments` is **omitted entirely** for `TECHNICIAN` viewers (check `undefined`).
- `standingInfo.outstandingBalance` is **omitted** for `TECHNICIAN` viewers.
- `tabs.notes[].authorName` is currently `null` — cross-schema resolution is deferred.
- `visitHistory` and `payments.rows` are capped at **50 entries** (most recent first).
- `canGenerate`: `true` if the visit is `COMPLETED` and has no invoice yet (show "Generate Invoice").
- `canDownload`: `true` if an invoice exists (show "Download Invoice").

**Errors:** `404` customer not found · `401` · `403`.

---

### 2.4 PATCH /customers/:id — M19 Edit Customer Record

Partial update. Every field is optional — send only what changed. Atomically updates
Customer + Property + ServicePlan in one transaction.

```
PATCH /customers/:id
{
  "name": "John Smith",               // Customer — optReqString: can't be null/blank if sent
  "phone": "+44 7700 900222",         // null = clear
  "email": "john@example.com",        // null = clear
  "addressLine": "14 Market Street",  // null not allowed if sent (optReqString)
  "postcode": "NE66 1SS",             // null not allowed if sent
  "propertyType": "HOUSE",            // null = clear; ∈ HOUSE|FLAT_APARTMENT|COMMERCIAL|OFFICE|CONSERVATORY
  "accessNotes": "Key under mat",     // null = clear
  "riskNotes": null,                  // null = clear
  "roundId": "clf...",                // null = unassign from round; id = assign/reassign
  "price": 35,                        // ServicePlan price (positive, max 9999.99)
  "cleanMethod": "Water Fed Pole",    // null = clear
  "paymentMethod": "GOCARDLESS"       // null = clear
}
→ 200 { "customerId": "...", "propertyId": "...", "servicePlanId": "..." }
```

**Round assignment behaviour:**
When `roundId` is changed, the service plan `cleaningFrequency` is automatically
synced to the new round's frequency. Setting `roundId: null` clears the frequency too.

**Errors:** `400` invalid field value · `404` customer or round not found · `401` · `403`.

---

### 2.5 DELETE /customers/:id — soft-delete

Marks the customer and all their properties/service-plans as `CANCELLED`.
Open visits are set to `SKIPPED`. This is irreversible from the UI.

```
DELETE /customers/:id
→ 204 (empty body)
→ 404 customer not found
```

---

## 3. Properties

### 3.1 POST /properties — M6 Add Property (creates Customer + Property + ServicePlan)

The primary "add customer" entry point. Creates a customer, their property, and
a service plan atomically in one call.

```
POST /properties
{
  "customerName": "John Smith",       // required
  "phone": "+44 7700 900222",         // optional
  "email": "john@example.com",        // optional
  "addressLine": "12 Market Street",  // required
  "postcode": "NE66 1SS",             // required
  "propertyName": "The Cottage",      // optional display name
  "propertyType": "HOUSE",            // optional; ∈ HOUSE|FLAT_APARTMENT|COMMERCIAL|OFFICE|CONSERVATORY
  "serviceAreaId": "clh...",          // required — must exist (404 if not)
  "serviceId": "cln...",              // optional — links service from catalogue
  "price": 35,                        // required — positive number, max 9999.99
  "cleanMethod": "Water Fed Pole",    // optional
  "paymentMethod": "GOCARDLESS",      // optional
  "nextDueDate": "2026-08-04",        // optional ISO date string
  "accessNotes": "Key under mat",     // optional
  "riskNotes": null,                  // optional
  "roundId": "clf..."                 // optional — null = "Save & Assign Later"
}
→ 201 { "customerId": "...", "propertyId": "...", "servicePlanId": "...", "assigned": true }
```

`assigned: true` means a round was provided and the property was placed in it.
`assigned: false` means `roundId` was `null` — property is unassigned; show
"Assign to Round" prompt.

**Errors:** `400` missing required field or invalid value · `404` serviceAreaId or roundId
not found · `401` · `403`.

---

### 3.2 POST /customers/:id/properties — add a second property to an existing customer

Same body as `POST /properties` (minus `customerName`/`phone`/`email`).
Returns `{ "propertyId": "...", "servicePlanId": "...", "assigned": true|false }` → `201`.

**Errors:** `400` · `404` customer not found · `409` customer is `CANCELLED` · `401` · `403`.

---

### 3.3 PATCH /properties/:id — edit property + Move Round

Partial update of the property. Also handles the "Move Round" (reassign) and
"Change Frequency" flows.

```
PATCH /properties/:id
{
  "addressLine": "14 Market Street",
  "postcode": "NE66 1SS",
  "propertyName": "The Cottage",
  "propertyType": "FLAT_APARTMENT",
  "serviceAreaId": "clh...",         // null = unassign from service area
  "accessNotes": "Ring doorbell",
  "riskNotes": null,
  "roundId": "clf...",               // null = unassign; id = assign/reassign (Move Round)
  "cleaningFrequency": "FOUR_WEEKLY" // see frequency-change rules below
}
→ 200 { ...Property row }
```

**Frequency-change rules (FR-FREQ):**
`roundId` and `cleaningFrequency` are **mutually exclusive** in a single PATCH — don't
send both.

| Scenario | What the backend does |
|---|---|
| `roundId` provided | Assigns round; syncs `cleaningFrequency` to that round's frequency |
| `roundId: null` | Unassigns round; clears `cleaningFrequency` |
| `cleaningFrequency` provided, no current round | Updates plan frequency only; no round change |
| `cleaningFrequency` = current round's frequency | Updates plan field only; stays in same round |
| `cleaningFrequency` ≠ current round's frequency, matching round exists | Moves property to the matching round (same service area, same frequency) |
| `cleaningFrequency` ≠ current round's frequency, no match exists | Creates a new round (copies current round name + "_(Frequency)"), moves property to it |
| Property has no `serviceAreaId` and `cleaningFrequency` differs | `409` — can't auto-assign without a service area |

**Errors:** `400` · `404` property/round/serviceArea not found · `409` no service area ·
`401` · `403`.

---

### 3.4 POST /properties/:id/pause — M9 Pause Service

```
POST /properties/:id/pause
{
  "reason": "Customer Holiday/Away",  // required — shown in UI, not persisted
  "pauseStartDate": "2026-08-01",     // required — ISO date (YYYY-MM-DD)
  "pauseEndDate": "2026-08-31"        // optional — null or omit = indefinite pause
}
→ 200 { ...ServicePlan row with status: "PAUSED" }
→ 409 if already paused
```

`pauseEndDate` must be **after** `pauseStartDate` when provided.

---

### 3.5 POST /properties/:id/resume — clear the pause

No body required.

```
POST /properties/:id/resume
→ 200 { ...ServicePlan row with status: "ACTIVE", pauseStartDate: null, pauseEndDate: null }
→ 409 if plan is not paused
```

---

### 3.6 GET /properties/:id/notes

Returns all notes for the property, newest first.

```
GET /properties/:id/notes
→ 200 [{ "id": "...", "type": "INTERNAL", "body": "...", "authorProfileId": "...", "authorName": null, "createdAt": "..." }]
```

`type` ∈ `INTERNAL` · `RISK_WARNING` · `CUSTOMER`

---

### 3.7 POST /properties/:id/notes — M20 Add Note

```
POST /properties/:id/notes
{
  "type": "INTERNAL",
  "body": "Customer confirmed new keypad code: 1234"
}
→ 201 { ...PropertyNote row }
```

`type` is required; `body` is required (non-empty).
**Errors:** `400` invalid `type` or blank `body` · `404` property not found · `401` · `403`.

---

### 3.8 DELETE /properties/:id — soft-delete

Marks the property and its service plan as `CANCELLED`. Open visits are `SKIPPED`.

```
DELETE /properties/:id
→ 204 (empty body)
→ 404 property not found
```

---

## 4. Rounds

### 4.1 GET /rounds — list all rounds

```
GET /rounds
  ?status=    ACTIVE | DRAFT | ARCHIVED   (optional; default = all)

→ 200 [
  {
    "id": "clf...",
    "name": "Alnwick Monday",
    "frequency": "FORTNIGHTLY",
    "defaultDay": "MON",
    "status": "ACTIVE",
    "serviceAreaId": "clh...",
    "serviceAreaName": "Morpeth",
    "technicianCount": 2,
    "propertyCount": 18
  }
]
```

`frequency` ∈ `FORTNIGHTLY` · `FOUR_WEEKLY` · `SIX_WEEKLY` · `EIGHT_WEEKLY` · `MONTHLY`
`defaultDay` ∈ `MON` · `TUE` · `WED` · `THU` · `FRI` · `SAT` · `SUN` · `null`

---

### 4.2 POST /rounds — create a round

```
POST /rounds
{
  "name": "Alnwick Wednesday",   // required
  "frequency": "FORTNIGHTLY",    // required
  "serviceAreaId": "clh...",     // required — must exist (404 if not)
  "defaultDay": "WED",           // optional
  "description": "..."           // optional
}
→ 201 { ...RoundDetail (see §4.3) }
```

New rounds are always created as `ACTIVE`.

---

### 4.3 GET /rounds/:id — round detail

```
GET /rounds/:id
→ 200 {
  "id": "clf...",
  "name": "Alnwick Monday",
  "frequency": "FORTNIGHTLY",
  "defaultDay": "MON",
  "description": null,
  "status": "ACTIVE",
  "serviceAreaId": "clh...",
  "serviceAreaName": "Morpeth",
  "technicians": [
    { "id": "clg...", "name": "James Fisher", "active": true }
  ],
  "propertyCount": 18
}
```

---

### 4.4 PATCH /rounds/:id — partial update

```
PATCH /rounds/:id
{
  "name": "Alnwick Monday Revised",
  "frequency": "FOUR_WEEKLY",   // null = clear frequency
  "serviceAreaId": "clh...",    // null = unassign service area
  "defaultDay": "TUE",          // null = clear
  "description": "...",
  "status": "ARCHIVED"          // to archive a round
}
→ 200 { ...RoundDetail }
```

To **archive** a round set `status: "ARCHIVED"`. There is no separate archive endpoint.

---

### 4.5 PUT /rounds/:id/technicians — assign technicians (replace semantics)

Replaces the entire technician list. Send an empty array to clear all.

```
PUT /rounds/:id/technicians
{
  "technicianIds": ["clg...", "cli..."]
}
→ 200 { ...RoundDetail }
```

- **`409`** is not returned; **`400`** if an ID refers to an inactive technician.
- **`404`** if any ID doesn't exist.
- Duplicates are silently de-duped.

---

## 5. Round Planner

The planner drives the calendar view (Screen — occurrence list) and the day view
(occurrence detail: stop list + map).

### 5.1 GET /rounds/:id/planner/occurrences — calendar view

Returns one entry per visit-date bucket (not per visit). Requires at least one
date bound; max range is **90 days**.

```
GET /rounds/:id/planner/occurrences?from=2026-07-01&to=2026-07-31
→ 200 [
  {
    "date": "2026-07-07",
    "stopCount": 18,
    "totalValue": 630,
    "completedCount": 18,
    "completionPct": 100,
    "holdCount": 0,
    "issueCount": 0
  },
  {
    "date": "2026-07-21",
    "stopCount": 18,
    "totalValue": 630,
    "completedCount": 12,
    "completionPct": 67,
    "holdCount": 1,
    "issueCount": 2
  }
]
```

- `?from=` and `?to=` must be `YYYY-MM-DD` format.
- At least one of `from` / `to` is required — **`400`** if both are missing.
- Range > 90 days → **`400`**.
- Returns an **empty array** (not 404) if no visits exist in the range.

---

### 5.2 GET /rounds/:id/planner/occurrences/:date — day view

Returns all stops for a single date (the list/map view).

```
GET /rounds/:id/planner/occurrences/2026-07-21
→ 200 {
  "roundId": "clf...",
  "roundName": "Alnwick Monday",
  "date": "2026-07-21",
  "stops": [
    {
      "visitId": "clp...",
      "propertyId": "cle...",
      "propertyName": "The Cottage",
      "addressLine": "12 Market Street",
      "postcode": "NE66 1SS",
      "customerName": "John Smith",
      "price": 35,
      "status": "COMPLETED",
      "paymentHold": false,
      "technicianId": "clg...",
      "technicianName": "James Fisher",
      "issues": [{ "id": "clx...", "type": "ACCESS", "note": "Gate was locked" }],
      "completedAt": "2026-07-21T09:45:00.000Z"
    }
  ],
  "summary": {
    "stopCount": 18,
    "totalValue": 630,
    "completedCount": 18,
    "completionPct": 100,
    "holdCount": 0,
    "issueCount": 0
  }
}
```

- Stops are ordered by `addressLine` ascending (for map/route ordering).
- `completedAt` is `null` if not yet completed.
- `paymentHold: true` means show the payment-hold badge on that stop.
- Returns `{ stops: [], summary: { stopCount: 0, ... } }` (not 404) if no visits on that date.

---

## 6. Shared enum reference

| Enum | Values |
|---|---|
| `LifecycleStatus` | `ACTIVE` `PAUSED` `CANCELLED` |
| `CleaningFrequency` | `FORTNIGHTLY` `FOUR_WEEKLY` `SIX_WEEKLY` `EIGHT_WEEKLY` `MONTHLY` |
| `RoundStatus` | `ACTIVE` `DRAFT` `ARCHIVED` |
| `DayOfWeek` | `MON` `TUE` `WED` `THU` `FRI` `SAT` `SUN` |
| `PropertyType` | `HOUSE` `FLAT_APARTMENT` `COMMERCIAL` `OFFICE` `CONSERVATORY` |
| `PaymentMethod` | `GOCARDLESS` `STRIPE` `CASH` `BACS` `CHEQUE` |
| `NoteType` | `INTERNAL` `RISK_WARNING` `CUSTOMER` |
| `VisitStatus` | `SCHEDULED` `IN_PROGRESS` `COMPLETED` `SKIPPED` |
| `PaymentStatus` | `NOT_DUE` `PENDING` `PAID` `OVERDUE` `FAILED` |
| `IssueType` | (from DB enum — `ACCESS`, `DAMAGE`, `COMPLAINT`, etc.) |

---

## 7. ⚠️ Critical rules

> **Money fields on customers/properties are numbers.** Unlike the Settings service
> (where `defaultPrice` returns as a string), `price` / `totalValue` on customer and
> planner responses are already numbers. Do not parse them.
>
> **`HOLD` status is derived, not stored.** Never try to set `status: "HOLD"` via
> PATCH — it doesn't exist on the Customer model. It's computed from `paymentHold`
> flags on open visits and returned in list/detail responses.
>
> **`tabs.payments` and `standingInfo.outstandingBalance` are omitted for TECHNICIANs.**
> Always guard with `!== undefined` before rendering the Payments tab or outstanding
> balance. A `TECHNICIAN` viewer legitimately receives no financial data.
>
> **`roundId` and `cleaningFrequency` are mutually exclusive in `PATCH /properties/:id`.**
> Sending both in one request will result in the `roundId` branch winning and
> `cleaningFrequency` being ignored.
>
> **Frequency change may auto-create a new round.** When you `PATCH` a property's
> `cleaningFrequency` and no matching round exists, the backend silently creates one.
> Refetch `GET /rounds` after any frequency-change PATCH if you're displaying a round list.
>
> **`POST /properties/{id}/pause` validates date ordering server-side.** If `pauseEndDate`
> is before or equal to `pauseStartDate` you get `400`. Validate client-side too.
>
> **The planner requires at least one date bound.** `GET …/occurrences` with no
> `?from=` or `?to=` returns `400`. Always supply at least one. Max range is 90 days.
>
> **Soft-delete is permanent from the UI perspective.** `DELETE /customers/:id` and
> `DELETE /properties/:id` set status to `CANCELLED` — there is no restore endpoint.
> Gate both behind a confirmation modal.
>
> **`PUT /rounds/:id/technicians` is replace-all.** Sending `{ "technicianIds": [] }`
> removes everyone. Always send the full desired list, not just additions.

---

## 8. Quick-reference table

| Operation | Method | Path | Auth | Notes |
|---|---|---|---|---|
| List customers + KPIs | GET | `/customers` | Any role | Supports search/filter/page |
| Create standalone customer | POST | `/customers` | ADMIN/MANAGER | No property |
| Customer detail (all tabs) | GET | `/customers/:id` | Any role | Phase 1: 1 property |
| Edit customer + property + plan | PATCH | `/customers/:id` | ADMIN/MANAGER | Partial; atomic |
| Soft-delete customer | DELETE | `/customers/:id` | ADMIN/MANAGER | Cascades to property/plan |
| Add property (new customer) | POST | `/properties` | ADMIN/MANAGER | Creates customer+property+plan |
| Add property to existing customer | POST | `/customers/:id/properties` | ADMIN/MANAGER | 409 if customer CANCELLED |
| Edit property / Move Round | PATCH | `/properties/:id` | ADMIN/MANAGER | Frequency may auto-create round |
| Pause service | POST | `/properties/:id/pause` | ADMIN/MANAGER | 409 if already paused |
| Resume service | POST | `/properties/:id/resume` | ADMIN/MANAGER | 409 if not paused |
| Get notes | GET | `/properties/:id/notes` | Any role | Newest first |
| Add note | POST | `/properties/:id/notes` | ADMIN/MANAGER | type + body required |
| Soft-delete property | DELETE | `/properties/:id` | ADMIN/MANAGER | Cancels plan + skips visits |
| List rounds | GET | `/rounds` | Any role | Optional ?status filter |
| Create round | POST | `/rounds` | ADMIN/MANAGER | Always ACTIVE |
| Round detail | GET | `/rounds/:id` | Any role | Includes technicians + count |
| Edit round | PATCH | `/rounds/:id` | ADMIN/MANAGER | Archive via status: ARCHIVED |
| Assign technicians | PUT | `/rounds/:id/technicians` | ADMIN/MANAGER | Replace-all semantics |
| Planner — calendar | GET | `/rounds/:id/planner/occurrences` | Any role | from/to required; max 90 days |
| Planner — day view | GET | `/rounds/:id/planner/occurrences/:date` | Any role | YYYY-MM-DD |

---

## 9. Happy-path examples

```bash
TOKEN="<access_token>"
BASE=http://localhost:3000
AUTH=(-H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json")

# Screen 14 — list customers with search
curl "${AUTH[@]}" "$BASE/customers?search=smith&status=ACTIVE&page=1&pageSize=25"

# M6 — Add new customer + property (most common entry point)
curl "${AUTH[@]}" -X POST "$BASE/properties" -d '{
  "customerName": "John Smith",
  "addressLine": "12 Market Street",
  "postcode": "NE66 1SS",
  "serviceAreaId": "<area-id>",
  "price": 35,
  "roundId": "<round-id>"
}'

# Screen 15 — full detail
curl "${AUTH[@]}" "$BASE/customers/<customer-id>"

# M19 — Edit customer name + round assignment
curl "${AUTH[@]}" -X PATCH "$BASE/customers/<customer-id>" \
  -d '{"name":"John A. Smith","roundId":"<round-id>"}'

# Move Round (change property to a different round)
curl "${AUTH[@]}" -X PATCH "$BASE/properties/<property-id>" \
  -d '{"roundId":"<new-round-id>"}'

# Change frequency (may auto-create a new round)
curl "${AUTH[@]}" -X PATCH "$BASE/properties/<property-id>" \
  -d '{"cleaningFrequency":"FOUR_WEEKLY"}'

# M9 — Pause service for a holiday
curl "${AUTH[@]}" -X POST "$BASE/properties/<property-id>/pause" \
  -d '{"reason":"Customer on holiday","pauseStartDate":"2026-08-01","pauseEndDate":"2026-08-31"}'

# Resume when they return
curl "${AUTH[@]}" -X POST "$BASE/properties/<property-id>/resume"

# M20 — Add a note
curl "${AUTH[@]}" -X POST "$BASE/properties/<property-id>/notes" \
  -d '{"type":"INTERNAL","body":"New gate code: 4321"}'

# Rounds — list active rounds only
curl "${AUTH[@]}" "$BASE/rounds?status=ACTIVE"

# Assign technicians to a round (replace-all: always send the full list)
curl "${AUTH[@]}" -X PUT "$BASE/rounds/<round-id>/technicians" \
  -d '{"technicianIds":["<tech-id-1>","<tech-id-2>"]}'

# Round Planner — calendar view for July 2026
curl "${AUTH[@]}" "$BASE/rounds/<round-id>/planner/occurrences?from=2026-07-01&to=2026-07-31"

# Round Planner — stops for a specific day
curl "${AUTH[@]}" "$BASE/rounds/<round-id>/planner/occurrences/2026-07-21"
```

---

*Cross-reference: `docs/designFindings.md` Screens 14/15 + planner screens (visual/field
detail), `docs/SETTINGS_API_HANDOFF.md` (rounds and service areas are seeded in Settings),
`docs/SETUP_WIZARD_HANDOFF_v2.md` (rounds and areas first configured in setup), and
`/docs` (Swagger UI, tags **Customers**, **Properties**, **Rounds**) for the live spec.*
