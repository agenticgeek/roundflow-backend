# RoundFlow — Complaints: Frontend Handoff

> **Purpose:** Everything needed to build the Complaints section end-to-end — the list, the split-panel detail, the Log New Complaint modal, and all status-transition actions. Exact API contracts, response shapes, status codes, and screen-by-screen wiring.

**Base URL (dev):** `http://localhost:3000`  
**Content-Type:** `application/json` on all requests.  
**Auth:** `Authorization: Bearer <supabase_access_token>` on every request.  
**Role enforcement:** All complaint mutations are **ADMIN / MANAGER only** — TECHNICIAN receives `403` on every endpoint in this section.

---

## 1. Data Model Overview

```
Complaint
  ├── id
  ├── status:      OPEN | IN_REVIEW | REVISIT_BOOKED | RESOLVED
  ├── severity:    LOW | MEDIUM | HIGH
  ├── title
  ├── description  (nullable)
  ├── issueType    (nullable, free text e.g. "Missed Clean")
  ├── customerId   → Customer
  ├── propertyId   → Property  (nullable)
  ├── technicianId → Technician (nullable)
  ├── revisitDate  (nullable, YYYY-MM-DD — only set when status = REVISIT_BOOKED)
  └── createdAt
```

**Status meanings:**

| Status | Colour (design) | Meaning |
|---|---|---|
| `OPEN` | Orange | Newly logged, no action taken yet |
| `IN_REVIEW` | Blue | Under investigation |
| `REVISIT_BOOKED` | Red | A revisit date has been scheduled |
| `RESOLVED` | Green | Issue closed |

**Severity** (LOW / MEDIUM / HIGH) is metadata only — it does not affect list ordering or routing logic. The list is always sorted by `createdAt` descending (most recent first).

---

## 2. Complaint Response Shape

Every endpoint that returns a complaint returns this same object:

```json
{
  "id": "cmp1abc",
  "status": "OPEN",
  "severity": "MEDIUM",
  "title": "Missed conservatory roof",
  "description": "Second time this month the conservatory roof was not cleaned.",
  "issueType": "Missed Clean",
  "customerId": "cld123",
  "customerName": "David Harris",
  "propertyId": "prp456",
  "technicianId": null,
  "revisitDate": null,
  "createdAt": "2026-09-01T09:14:00.000Z"
}
```

---

## 3. Screens & API Wiring

### Screen 1 — Complaints List (`/complaints`)

**What the user sees:** Full-page list of all complaints, sorted newest first. Tabs: **All** and **My Work** (My Work = complaints assigned to the currently logged-in technician).

**Endpoint:** `GET /complaints`

**Query parameters:**

| Param | Type | Notes |
|---|---|---|
| `status` | string | `OPEN` \| `IN_REVIEW` \| `REVISIT_BOOKED` \| `RESOLVED` |
| `search` | string | Case-insensitive match on complaint title or customer name |
| `assignedTo` | `"me"` | Returns only complaints assigned to the calling user's technician record — use this for the **My Work** tab |
| `technicianId` | string | Filter by a specific technician ID |

**Response (200):** Array of complaint objects (same shape as §2).

**Card layout (per complaint):**
- Status badge (colour-coded per table in §1)
- `createdAt` date formatted as `DD Mon YYYY` (top-right of card)
- `title` (bold)
- `customerName · propertyId` (or address if available)
- Technician name (person icon) — from `technicianId`; show "Unassigned" if null
- Message count (speech bubble icon + number) — **not yet returned by the API; reserve the UI slot**
- Revisit date (calendar icon) — only show when `status === "REVISIT_BOOKED"` and `revisitDate` is non-null
- Priority badge: `severity` value

---

### Screen 2 — Complaint Detail (split panel)

Clicking a complaint card opens the right-panel detail view. The list narrows to the left; the selected complaint is highlighted.

**Endpoint:** `GET /complaints/:id` — returns a single complaint by ID (for deep-linking / page refresh).

You already have the complaint object from the list, so for normal navigation you don't need to call this — render the detail from the list data and replace it locally when action endpoints return the updated complaint.

**Right panel — layout:**

```
← Back to list                [Assign Technician] [Schedule Revisit] [Mark In Review] [Resolve]

David Harris
Alnwick · Technician: James

● OPEN   ● MEDIUM

[Messages (n)]  [Details]
```

**Action button visibility rules:**

| Button | Show when |
|---|---|
| Assign Technician | Always (when complaint is not RESOLVED) |
| Schedule Revisit | Always (when complaint is not RESOLVED) |
| Mark In Review | `status` is `OPEN` or `REVISIT_BOOKED` |
| Resolve | `status` is not `RESOLVED` |
| Reopen Complaint | `status` is `RESOLVED` — replaces all other buttons |

**Messages tab:** See §4.6 and §4.7 for the full message thread API.

**Details tab:** Render the following fields from the complaint object:

| Label | Field |
|---|---|
| ISSUE TYPE | `issueType` |
| PRIORITY | `severity` |
| DATE REPORTED | `createdAt` (formatted `DD Mon YYYY`) |
| TECHNICIAN ASSIGNED | technician name (resolve via `technicianId`) |
| CUSTOMER PHONE | resolve via `customerId` → customer record |
| CUSTOMER EMAIL | resolve via `customerId` → customer record |
| PROPERTY ADDRESS | resolve via `propertyId` → property record |

---

### Screen 3 — Log New Complaint Modal

**Trigger:** "+ Log Complaint" button (top-right of Complaints page, and in the complaint list header when in split-panel view).

**Endpoint:** `POST /complaints`

**Request body:**
```json
{
  "customerId": "cld123abc",
  "title": "Missed conservatory roof",
  "description": "Second time this month the conservatory roof was not cleaned.",
  "issueType": "Missed Clean",
  "severity": "MEDIUM",
  "propertyId": "prp456def",
  "technicianId": null
}
```

| Field | Required | Notes |
|---|---|---|
| `customerId` | **yes** | Must reference an existing customer — use a customer search/autocomplete, not a free-text input |
| `title` | **yes** | Free text |
| `description` | no | Free text, multiline |
| `issueType` | no | Free text — suggest a dropdown with common types: "Missed Clean", "Damaged Property", "Rude Technician", "Streaky Windows", "Other" |
| `severity` | no | `LOW` \| `MEDIUM` \| `HIGH` — default `MEDIUM` |
| `propertyId` | no | Should be auto-populated when customer is selected (if customer has one property); show a dropdown if multiple |
| `technicianId` | no | Only show technicians whose `appStatus` is `ACTIVE` or `INACTIVE` — **never show `PENDING_INVITE`** |

**Response (201):** The created complaint object (§2).

**On success:**
- Close the modal
- Prepend the new complaint to the list (or refresh the list)
- Show toast: `"Complaint logged successfully"`

**On error:**
- `400` — show `error` field from response body inline in the form
- `404` — customer, property, or technician not found; surface the `error` message

> **Important:** The Figma design shows free-text customer fields (name, address, phone, email). **Do not implement it that way.** The API requires an existing `customerId`. Wire this as a **customer search autocomplete** — search by name using `GET /customers?search=` and let the user select. Once selected, auto-populate `propertyId` from the customer's properties list.

---

## 4. Action Endpoints

All action endpoints follow the same pattern: `POST /complaints/:id/<action>`. They return `200` with the updated complaint object on success.

---

### 4.1 Mark In Review

**Endpoint:** `POST /complaints/:id/mark-in-review`

**Request body:** none

**Response (200):** Updated complaint with `status: "IN_REVIEW"`.

**When to call:** User clicks "Mark In Review" button on the detail panel.

**On success:**
- Update the complaint in local state (status badge changes to blue "In Review")
- Show toast: `"Marked for in-review!"`

---

### 4.2 Schedule Revisit

**Endpoint:** `POST /complaints/:id/schedule-revisit`

**Request body:**
```json
{
  "revisitDate": "2026-09-10"
}
```

| Field | Required | Notes |
|---|---|---|
| `revisitDate` | **yes** | `YYYY-MM-DD` format |

**Response (200):** Updated complaint with `status: "REVISIT_BOOKED"` and `revisitDate` set.

**UI behaviour:** Clicking "Schedule Revisit" expands an inline date picker directly below the customer/address line in the detail panel (not a separate modal). The picker has a "Confirm" button that fires this endpoint.

**On success:**
- Update the complaint in local state
- Collapse the inline date picker
- Show toast: `"Revisit scheduled"`
- The complaint card in the list should now show the calendar icon with `revisitDate`

**On error:**
- `400` — invalid date format; show inline validation

---

### 4.3 Resolve

**Endpoint:** `POST /complaints/:id/resolve`

**Request body:** none

**Response (200):** Updated complaint with `status: "RESOLVED"`.

**On success:**
- Update local state
- The detail panel switches to resolved state: all action buttons replaced with single "Reopen Complaint" button
- A green resolution message appears in the Messages thread: `"Issue resolved — revisit completed successfully. Resolved by [current user name] · [timestamp]"` — render this client-side using the current user's name and the response timestamp

---

### 4.4 Reopen

**Endpoint:** `POST /complaints/:id/reopen`

**Request body:** none

**Response (200):** Updated complaint with `status: "OPEN"` and `revisitDate: null`.

**When to call:** User clicks "Reopen Complaint" button (only visible when `status === "RESOLVED"`).

**On success:**
- Update local state — action buttons return, status badge goes back to orange "Open"
- Show toast: `"Complaint reopened"`

---

### 4.5 Assign Technician

**Endpoint:** `POST /complaints/:id/assign-technician`

**Request body:**
```json
{
  "technicianId": "ctn789abc"
}
```

| Field | Required | Notes |
|---|---|---|
| `technicianId` | **yes** | Must exist and have accepted their invite |

**Response (200):** Updated complaint with `technicianId` set.

**UI behaviour:** Clicking "Assign Technician" opens a modal or dropdown to search/select a technician.

**On success:**
- Update local state (`technicianId` and technician name in the detail panel)
- Show toast: `"Assigned to [technician name] successfully!"`

**On error:**
- `404` — technician not found
- `400` with message `"Technician has not accepted their invite"` — this should not be reachable if you filter the dropdown correctly (see below)

> **Technician dropdown rule:** Only show technicians whose `appStatus` is `ACTIVE` or `INACTIVE`. Never show `PENDING_INVITE`. Source the list from `GET /technicians`.

---

## 5. Error Handling Reference

All errors return:
```json
{ "error": "Human-readable message" }
```

| Status | Meaning | What to show |
|---|---|---|
| `400` | Validation failed | Inline form error or toast with `error` text |
| `401` | Not authenticated | Redirect to login |
| `403` | TECHNICIAN role | Should not be reachable — hide all complaint mutation buttons for TECHNICIAN role |
| `404` | Entity not found | Toast or inline: `error` text from response |

---

## 6. Role-Based UI Rules

| UI element | ADMIN / MANAGER | TECHNICIAN |
|---|---|---|
| Complaints nav item | Show | Show (read-only view — no action buttons) |
| "+ Log Complaint" button | Show | Hide |
| Mark In Review / Resolve / etc. buttons | Show | Hide |
| Assign Technician button | Show | Hide |

Since all mutation endpoints return `403` for TECHNICIAN, hiding the buttons client-side is a UX improvement — the backend enforces it regardless.

---

## 7. Technician Dropdown — Shared Rule

Applies to: Log New Complaint modal (`technicianId`) and Assign Technician action.

```
GET /technicians
```

Filter the returned list to only show technicians where `appStatus !== "PENDING_INVITE"`. The `appStatus` field is already returned by `GET /technicians` — use it directly. Do not show pending technicians in any dropdown across the app.

---

## 4.6 List Messages

**Endpoint:** `GET /complaints/:id/messages`

**Response (200):** Array of message objects, oldest first.

```json
[
  {
    "id": "msg1abc",
    "direction": "INBOUND",
    "channel": "EMAIL",
    "body": "The conservatory roof was not cleaned again.",
    "complaintId": "cmp1abc",
    "createdAt": "2026-09-01T09:10:00.000Z"
  }
]
```

| Field | Notes |
|---|---|
| `direction` | `INBOUND` = message from the customer; `OUTBOUND` = reply from your team |
| `channel` | Always `EMAIL` for outbound replies |

**When to call:** On mount of the Messages tab in the complaint detail panel.

---

## 4.7 Add Reply (Outbound Message)

**Endpoint:** `POST /complaints/:id/messages`

**Request body:**
```json
{
  "body": "We'll send someone out on Thursday to take a look."
}
```

**Response (201):** The created message object (same shape as §4.6).

**UI behaviour:** The Messages tab has a text area at the bottom and a "Send Reply" button. On submit, call this endpoint. On success, append the returned message to the thread.

---

## 8. Backend Complete

All endpoints are implemented. The full list:

---

| Endpoint | Method | Purpose |
|---|---|---|
| `/complaints` | GET | List all complaints (filterable) |
| `/complaints` | POST | Log a new complaint |
| `/complaints/:id` | GET | Fetch single complaint |
| `/complaints/:id/mark-in-review` | POST | Set status IN_REVIEW |
| `/complaints/:id/schedule-revisit` | POST | Set status REVISIT_BOOKED + date |
| `/complaints/:id/resolve` | POST | Set status RESOLVED |
| `/complaints/:id/reopen` | POST | Reset to OPEN |
| `/complaints/:id/assign-technician` | POST | Set technicianId |
| `/complaints/:id/messages` | GET | List message thread |
| `/complaints/:id/messages` | POST | Send outbound reply |

---

## 9. Swagger Docs

All endpoints are documented in the live Swagger UI:

- **Dev:** `http://localhost:3000/docs` → Complaints section
- Tag: **Complaints**
