# RoundFlow — Emergency Notifications: Frontend Handoff

> **Purpose:** Everything needed to build the emergency notification bell, the Emergency Notifications page, and the manager reassignment flow. A technician self-reports an emergency mid-round; managers are alerted, pick an available replacement, and confirm reassignment in one action.

**Base URL (dev):** `http://localhost:3000`  
**Content-Type:** `application/json` on all requests.  
**Auth:** `Authorization: Bearer <supabase_access_token>` on every request.  
**Role enforcement:** `POST /emergencies` is open to any authenticated user (technician self-reports). All other emergency endpoints require **ADMIN / MANAGER**.

---

## 1. Data Model Overview

```
TechnicianEmergency
  id                   String            cuid
  technicianId         String            FK → Technician (reporter)
  roundId              String            FK → Round
  remainingStops       Int               how many visits are unfinished
  lastLocation         String?           free text, e.g. "High Street, Alnwick"
  scheduledWindowEnd   DateTime?         when the customer window closes
  notes                String?           free text from the technician
  status               EmergencyStatus   ACTIVE | RESOLVED
  assignedTechnicianId String?           FK → Technician (replacement)
  resolvedAt           DateTime?         set when reassigned
  reportedAt           DateTime          auto, created timestamp
```

An emergency starts `ACTIVE`. It becomes `RESOLVED` the moment a manager confirms a reassignment — at which point all remaining unfinished visits in that round are bulk-reassigned to the replacement in the same DB transaction.

---

## 2. Response Shape

All endpoints that return a single emergency or a list use the same `EmergencyRow` shape:

```json
{
  "id": "clxyz...",
  "technicianId": "t1",
  "technicianName": "James",
  "roundId": "r1",
  "roundName": "Alnwick Monday",
  "remainingStops": 4,
  "lastLocation": "High Street",
  "scheduledWindowEnd": "2026-09-15T14:00:00.000Z",
  "notes": "Car broken down",
  "status": "ACTIVE",
  "assignedTechnicianId": null,
  "assignedTechnicianName": null,
  "resolvedAt": null,
  "reportedAt": "2026-09-15T10:23:00.000Z"
}
```

After reassignment, `status` becomes `"RESOLVED"`, `assignedTechnicianId` and `assignedTechnicianName` are populated, and `resolvedAt` is set.

---

## 3. Screens & API Wiring

### Screen 1 — Notification Bell (global header)

Poll `GET /emergencies?status=ACTIVE` on a regular interval (e.g. every 60 seconds) to drive the badge count on the bell icon. The badge shows the count of active emergencies. A count of 0 shows no badge.

**Endpoint:** `GET /emergencies?status=ACTIVE`

**Query parameters:**

| Param | Values | Default |
|---|---|---|
| `status` | `ACTIVE` \| `RESOLVED` | none (returns all) |

**Response (200):** Array of `EmergencyRow`.

On click: navigate to the Emergency Notifications page (`/emergencies`).

---

### Screen 2 — Emergency Notifications Page (`/emergencies`)

Displays all emergencies. Provide a toggle or tab for **Active** / **Resolved** / **All**.

- Active tab: `GET /emergencies?status=ACTIVE`
- Resolved tab: `GET /emergencies?status=RESOLVED`
- All tab: `GET /emergencies` (no status param)

**List row columns:**

| Column | Source field |
|---|---|
| Technician | `technicianName` |
| Round | `roundName` |
| Remaining stops | `remainingStops` |
| Last location | `lastLocation` (may be null — show `—`) |
| Window end | `scheduledWindowEnd` formatted as time (may be null — show `—`) |
| Reported | `reportedAt` formatted as relative time |
| Status badge | `status`: amber `ACTIVE` / green `RESOLVED` |
| Action | "View" button → opens detail/reassign modal |

---

### Screen 3 — Emergency Detail & Reassignment (modal or side panel)

Opened from the list row "View" button. Calls **two** endpoints in parallel:

**a) Emergency detail:**  
`GET /emergencies/:id`

Displays the full `EmergencyRow` including `notes` and `scheduledWindowEnd`.

**b) Available technicians:**  
`GET /emergencies/:id/available-technicians`

**Response (200):** Array of technician availability rows:

```json
[
  {
    "technicianId": "t2",
    "technicianName": "Sarah",
    "avatarUrl": "https://...",
    "jobsRemaining": 3,
    "availability": "BUSY"
  },
  {
    "technicianId": "t3",
    "technicianName": "Dan",
    "avatarUrl": null,
    "jobsRemaining": 0,
    "availability": "AVAILABLE"
  }
]
```

| Field | Notes |
|---|---|
| `availability` | `"AVAILABLE"` (0 remaining jobs today) or `"BUSY"` (has remaining jobs) |
| `jobsRemaining` | Count of today's unfinished visits for this technician |
| `avatarUrl` | May be null — show initials fallback |

The reporting technician is always excluded from this list.

**Display:** Show as a selectable list/cards. Highlight `AVAILABLE` technicians. Show `jobsRemaining` as context. `BUSY` technicians should be selectable but visually deprioritised — the manager has final say.

---

### Screen 4 — Confirm Reassignment

After the manager selects a replacement and clicks **Confirm**:

**Endpoint:** `POST /emergencies/:id/reassign`

**Request body:**
```json
{ "newTechnicianId": "t3" }
```

**Response (200):** Updated `EmergencyRow` with `status: "RESOLVED"`, `assignedTechnicianName`, `resolvedAt` all populated.

**On success:**
- Show a success toast: `"<TechnicianName> successfully reassigned to <RoundName>."`
- Update the emergency list — the reassigned emergency moves from Active to Resolved
- Close the modal/panel

**What happens server-side (for UI context):** The reassignment is atomic — it simultaneously marks the emergency as RESOLVED and bulk-reassigns all remaining unfinished visits in that round to the new technician. No further action is needed.

---

### Screen 5 — Technician Self-Report (mobile / technician app)

A technician reporting their own emergency triggers this endpoint. The ADMIN/MANAGER bell then lights up.

**Endpoint:** `POST /emergencies`

**Request body:**

```json
{
  "technicianId": "t1",
  "roundId": "r1",
  "remainingStops": 4,
  "lastLocation": "High Street",
  "scheduledWindowEnd": "2026-09-15T14:00:00.000Z",
  "notes": "Car broken down, cannot continue"
}
```

| Field | Required | Notes |
|---|---|---|
| `technicianId` | Yes | ID of the reporting technician |
| `roundId` | Yes | ID of the round they are currently running |
  | `remainingStops` | Yes | Integer — how many stops are left |
| `lastLocation` | No | Free-text string |
| `scheduledWindowEnd` | No | ISO 8601 datetime string |
| `notes` | No | Free-text string |

**Response (201):** Created `EmergencyRow`.

**On success:** Show confirmation: `"Emergency reported. A manager has been notified."` The technician's day is effectively paused at this point — the manager will action it.

**On 400:** Display the `error` field from the response body — one of the required fields was missing.

---

## 4. Error Handling Reference

All errors return:
```json
{ "error": "Human-readable message" }
```

| Status | Scenario | What to show |
|---|---|---|
| `400` | Missing required field on `POST /emergencies` or `POST /emergencies/:id/reassign` | Inline field validation message |
| `401` | Not authenticated | Redirect to login |
| `403` | Technician accessing ADMIN-only endpoint | Should not be reachable — guard in router |
| `404` | Emergency or technician ID not found | Toast: `"Emergency not found."` |
| `409` | Reassigning an already-resolved emergency | Toast: `"This emergency has already been resolved."` |
| `500` | Unexpected server error | Toast: `"Something went wrong, please try again."` |

---

## 5. Role-Based UI Rules

| UI element | ADMIN / MANAGER | TECHNICIAN |
|---|---|---|
| Notification bell + badge | Show | Hide |
| Emergencies page | Accessible | Hidden / 403 |
| Emergency detail + reassign | Accessible | Hidden / 403 |
| Available technicians list | Accessible | Hidden / 403 |
| "Report Emergency" button (technician app) | Hide | Show |
| `POST /emergencies` | Works (but not their flow) | Primary action |

---

## 6. Backend Complete

| Endpoint | Method | Role | Purpose |
|---|---|---|---|
| `/emergencies` | POST | Any auth | Technician self-reports an emergency |
| `/emergencies` | GET | ADMIN/MANAGER | List emergencies, optional `?status=ACTIVE\|RESOLVED` |
| `/emergencies/:id` | GET | ADMIN/MANAGER | Single emergency detail |
| `/emergencies/:id/available-technicians` | GET | ADMIN/MANAGER | List other active technicians with their remaining jobs |
| `/emergencies/:id/reassign` | POST | ADMIN/MANAGER | Confirm replacement — atomic reassign |

---

## 7. Swagger Docs

All endpoints are documented in the live Swagger UI:

- **Dev:** `http://localhost:3000/docs` → Emergencies section
- Tag: **Emergencies**
