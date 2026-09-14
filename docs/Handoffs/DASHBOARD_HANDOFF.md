# RoundFlow — Dashboard: Frontend Handoff

> **Purpose:** Everything needed to build the Dashboard screen — KPI metric cards, alert cards, today's rounds table, technician performance panel, and bar charts. Exact API contracts, response shapes, query parameters, and screen-by-screen wiring.

**Base URL (dev):** `http://localhost:3000`  
**Content-Type:** `application/json` on all requests.  
**Auth:** `Authorization: Bearer <supabase_access_token>` on every request.  
**Role enforcement:** All dashboard endpoints are **ADMIN / MANAGER only** — TECHNICIAN receives `403`.

---

## 1. Data Model Overview

All dashboard endpoints are **derived queries** — no new schema models. Data is aggregated live from:

```
Visit       — status, date, price, technicianId, issues
Complaint   — status, severity, revisitDate, technicianId
Payment     — status
Round       — id, name
Technician  — id, name, active
```

---

## 2. Screens & API Wiring

### Screen 1 — Dashboard (`/dashboard`)

The dashboard makes **5 independent parallel calls** on mount. All are GET — no request bodies.

---

### 2.1 KPI Cards

**Endpoint:** `GET /dashboard/kpis`

**Response (200):**

```json
{
  "jobsScheduledToday": 48,
  "openComplaints": 2,
  "openComplaintsByPriority": { "high": 1, "medium": 1, "low": 0 },
  "cleanUnpaidAmount": 1240,
  "cleanUnpaidCount": 18,
  "monthlyRevenue": 12400
}
```

| Field | Meaning |
|---|---|
| `jobsScheduledToday` | Count of all visits with a date of today (any status) |
| `openComplaints` | Count of complaints where `status !== "RESOLVED"` |
| `openComplaintsByPriority` | Breakdown of open complaints by `severity` |
| `cleanUnpaidAmount` | Sum of `price` for COMPLETED visits this month with no payment record |
| `cleanUnpaidCount` | Distinct customer count with unpaid visits this month |
| `monthlyRevenue` | Sum of `price` for all COMPLETED visits this calendar month |

**Card layout (4 cards):**

| Card | Primary value | Secondary |
|---|---|---|
| Jobs Today | `jobsScheduledToday` | — |
| Open Complaints | `openComplaints` | Priority breakdown (high/medium/low chips) |
| Clean Unpaid | `cleanUnpaidAmount` formatted as currency | `cleanUnpaidCount` customers |
| Monthly Revenue | `monthlyRevenue` formatted as currency | — |

---

### 2.2 Alert Cards

**Endpoint:** `GET /dashboard/alerts`

**Response (200):**

```json
{
  "skippedNeedingReview": 4,
  "failedPayments": 7,
  "complaintRevisitsDue": 2
}
```

| Field | Meaning |
|---|---|
| `skippedNeedingReview` | Visits with `status: "SKIPPED"` today |
| `failedPayments` | Payments with `status: "FAILED"` or `"OVERDUE"` (all time) |
| `complaintRevisitsDue` | Open complaints with a `revisitDate` on or before end of this week |

**Card layout (3 expandable cards):** Each card shows its count as a badge. A count of 0 means no action needed — style accordingly (e.g. grey vs amber/red).

---

### 2.3 Today's Rounds Table

**Endpoint:** `GET /dashboard/rounds`

**Response (200):** Array of round rows.

```json
[
  {
    "roundId": "r1",
    "roundName": "Alnwick Monday",
    "technicianId": "t1",
    "technicianName": "James",
    "status": "in_progress",
    "total": 12,
    "completed": 8,
    "skipped": 1,
    "issueCount": 1,
    "paymentHolds": 0,
    "value": 220,
    "etaMinutes": null
  }
]
```

| Field | Notes |
|---|---|
| `status` | `"not_started"` \| `"in_progress"` \| `"complete"` |
| `total` | Total visits in this round today |
| `completed` / `skipped` | Visit counts by status |
| `issueCount` | Visits with at least one issue logged |
| `paymentHolds` | Visits with `paymentHold: true` |
| `value` | Sum of `price` for all visits in the round today |
| `etaMinutes` | Always `null` (Phase 2 stub — no time-tracking yet) |

**Table columns (per design):** Round Name · Technician · Status badge · Progress (`completed / total`) · Issues · Value · ETA

---

### 2.4 Technician Performance Panel

**Endpoint:** `GET /dashboard/technician-kpis?period=monthly`

**Query parameters:**

| Param | Values | Default | Notes |
|---|---|---|---|
| `period` | `monthly` \| `yearly` | `monthly` | Monthly = current calendar month; yearly = Jan 1 → Dec 31 |

**Response (200):** Array, one row per active technician.

```json
[
  {
    "technicianId": "t1",
    "technicianName": "James",
    "jobsCompleted": 42,
    "valueCompleted": 840,
    "openComplaints": 1,
    "issueCount": 3,
    "timeOnJobMinutes": null,
    "strikes": null,
    "damages": null,
    "upsells": null
  }
]
```

| Field | Notes |
|---|---|
| `jobsCompleted` | COMPLETED visits in the period |
| `valueCompleted` | Sum of `price` for those visits |
| `openComplaints` | Non-RESOLVED complaints linked to this technician |
| `issueCount` | Issues raised on their visits in the period |
| `timeOnJobMinutes` / `strikes` / `damages` / `upsells` | Always `null` — Phase 2 stubs. Reserve the UI column slots but show `—` |

**Toggle:** Monthly / Yearly toggle fires a new request with the appropriate `period` param.

---

### 2.5 Bar Charts

**Endpoint:** `GET /dashboard/charts?range=6m`

**Query parameters:**

| Param | Values | Default | Notes |
|---|---|---|---|
| `range` | `6m` \| `12m` | `6m` | Number of calendar months to include |

**Response (200):**

```json
{
  "months": ["Apr", "May", "Jun", "Jul", "Aug", "Sep"],
  "valueCompleted": [1200, 1400, 980, 1100, 1600, 1340],
  "issueCount": [3, 5, 2, 4, 6, 3],
  "revenuePerHour": null
}
```

The three arrays are always the same length and positionally aligned — feed them directly into your chart library.

| Field | Chart type | Notes |
|---|---|---|
| `valueCompleted` | Bar chart | Value of work completed per month |
| `issueCount` | Bar chart | Issues raised per month |
| `revenuePerHour` | — | Always `null` (Phase 2 stub) |

**Toggle:** 6M / 12M toggle fires a new request with the appropriate `range` param.

---

## 3. Error Handling Reference

All errors return:
```json
{ "error": "Human-readable message" }
```

| Status | Meaning | What to show |
|---|---|---|
| `401` | Not authenticated | Redirect to login |
| `403` | Wrong role | Should not be reachable — hide dashboard nav for TECHNICIAN |
| `500` | Unexpected server error | Toast: "Something went wrong, please refresh" |

---

## 4. Role-Based UI Rules

| UI element | ADMIN / MANAGER | TECHNICIAN |
|---|---|---|
| Dashboard nav item | Show | Hide |
| All dashboard endpoints | Accessible | 403 |

---

## 5. Backend Complete

| Endpoint | Method | Purpose |
|---|---|---|
| `/dashboard/kpis` | GET | 6 top metric values |
| `/dashboard/alerts` | GET | 3 live alert counts |
| `/dashboard/rounds` | GET | Today's round rows |
| `/dashboard/technician-kpis` | GET | Per-technician stats (period toggle) |
| `/dashboard/charts` | GET | Monthly bar chart series (range toggle) |

---

## 6. Swagger Docs

All endpoints are documented in the live Swagger UI:

- **Dev:** `http://localhost:3000/docs` → Dashboard section
- Tag: **Dashboard**
