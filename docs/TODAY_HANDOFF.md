# RoundFlow — Today's Work & Day Management: Frontend Handoff

> **Purpose:** everything needed to build Screen 12 (Today's Work aggregate),
> Screen 13 (Round today panel), close-day, push-missed, and technician
> reassignment — exact API contracts, response shapes, status codes, and gotchas.

**Base URL (dev):** `http://localhost:3000`
**Content-Type:** `application/json` on all requests.
**Auth:** `Authorization: Bearer <supabase_access_token>` on every request.
**Role enforcement:** reads work for all roles. `POST /today/close` and
`POST /rounds/:id/push-missed` require `ADMIN` or `MANAGER`.

---

## 1. Data model overview

```
Visit
  ├── date (UTC midnight)
  ├── status: SCHEDULED | IN_PROGRESS | COMPLETED | SKIPPED
  ├── paymentHold (bool)
  ├── roundId → Round
  ├── technicianId → Technician
  └── issues[] → IssueLog
```

**Today is always UTC midnight–midnight.** The server derives "today" using
`setUTCHours(0,0,0,0)` — the date shown (`kpi.date`) is always in `YYYY-MM-DD`
UTC format.

**`dayClosed`** is a flag on `BusinessSettings.lastClosedDate`. Once set for
today, `POST /today/close` returns `409` until the date rolls over.

---

## 2. GET /today — aggregate KPI (Screen 12)

```
GET /today
```

**Response 200:**
```json
{
  "date": "2026-08-12",
  "dayClosed": false,
  "kpi": {
    "totalStops": 15,
    "inProgress": 2,
    "completed": 8,
    "skipped": 1,
    "issues": 3,
    "paymentHolds": 1,
    "valueCompleted": 145.00
  },
  "rounds": [
    {
      "roundId": "clg...",
      "roundName": "Alnwick North Round",
      "technicianId": "clg...",
      "technicianName": "Dave Smith",
      "status": "in_progress",
      "total": 10,
      "completed": 6,
      "skipped": 0,
      "issueCount": 1,
      "paymentHolds": 0,
      "value": 90.00,
      "etaMinutes": 80
    }
  ],
  "technicians": [
    {
      "technicianId": "clg...",
      "technicianName": "Dave Smith",
      "completed": 6,
      "remaining": 4,
      "roundName": "Alnwick North Round",
      "issueCount": 1,
      "onTrack": false
    }
  ]
}
```

**Fields:**

`kpi` tile values:
- `totalStops` — all visits today regardless of status.
- `issues` — visits with **at least one** issue log (not total issue count).
- `valueCompleted` — sum of prices for `COMPLETED` visits only.

`rounds[]` per-round summary:
- `status` — `"not_started"` | `"in_progress"` | `"completed"`.
- `value` — revenue from completed visits in this round today.
- `etaMinutes` — rough estimate: remaining stops × 20 min. `null` if round is done.
- `technicianId/Name` — the primary technician (IN_PROGRESS visit first, then
  first SCHEDULED visit, then any).

`technicians[]` per-technician workload card:
- `onTrack` — `true` if `issueCount === 0`. Simple heuristic; refine in future.
- `roundName` — name of the first round this technician has a visit in today.

Rounds/technicians with **no visits today are excluded** from both arrays.

---

## 3. POST /today/close — close the operational day

```
POST /today/close
```

**Body:**
```json
{
  "unfinishedAction": "push_to_tomorrow"
}
```

| `unfinishedAction` | Effect on SCHEDULED / IN_PROGRESS visits |
|---|---|
| `"push_to_tomorrow"` | Reschedules to next working day (Mon–Fri). Fri → Mon, Sat → Mon, Sun → Mon. Status reset to `SCHEDULED`. |
| `"mark_as_skipped"` | Sets status to `SKIPPED`. Visits stay on today's date. |

**Response 200:**
```json
{
  "completedJobs": 8,
  "skippedJobs": 3,
  "outstanding": 4,
  "issues": 2,
  "paymentHolds": 1,
  "revenue": 145.00
}
```

- `skippedJobs` — includes visits that were already `SKIPPED` before close, plus
  those newly marked by `mark_as_skipped`.
- `outstanding` — count of visits pushed to tomorrow. `0` when `mark_as_skipped`.
- `revenue` — sum of prices for all `COMPLETED` visits today.

**Error cases:**
- `400` — invalid `unfinishedAction` value.
- `409` — day already closed (idempotency guard). Show "Day already closed" UI.

> **Weekend handling:** closing on a Friday pushes unfinished jobs to Monday.
> Closing on a Saturday or Sunday also pushes to Monday (UTC).

---

## 4. GET /rounds/:id/today — round today panel (Screen 13)

```
GET /rounds/:id/today
```

Returns the stop-by-stop panel for one round on today's date.

**Response 200:**
```json
{
  "roundId": "clg...",
  "roundName": "Alnwick North Round",
  "technicianId": "clg...",
  "technicianName": "Dave Smith",
  "status": "in_progress",
  "progress": {
    "total": 10,
    "completed": 6,
    "skipped": 0,
    "issues": 1
  },
  "stops": [
    {
      "visitId": "clg...",
      "customerName": "John Doe",
      "addressLine": "12 High Street, Alnwick",
      "status": "COMPLETED",
      "paymentHold": false,
      "hasIssue": false,
      "issueFlag": null
    },
    {
      "visitId": "clg...",
      "customerName": "Jane Smith",
      "addressLine": "34 Oak Lane, Alnwick",
      "status": "SCHEDULED",
      "paymentHold": true,
      "hasIssue": true,
      "issueFlag": "Gate code needed"
    }
  ]
}
```

`stops` are sorted alphabetically by `addressLine`.

`progress.issues` — count of stops with **at least one** issue (not total issue
count).

`technicianId/Name` — primary technician (same logic as `GET /today`).

`issueFlag` — first issue note for that visit; `null` if there are no issues or
the issue has no note text.

**`404`** if the round does not exist.

When the round has no visits today, `stops` is `[]` and `status` is
`"not_started"`.

---

## 5. POST /rounds/:id/push-missed — push today's SCHEDULED visits

```
POST /rounds/:id/push-missed
```

Moves all **`SCHEDULED`** (not IN_PROGRESS, not COMPLETED, not SKIPPED) visits in
this round from today to a new date. Used when a round is cancelled last-minute —
e.g. bad weather.

**Body:**
```json
{
  "newDate": "2026-08-18",
  "reason": "Weather closure",
  "technicianId": null,
  "notifyCustomers": false
}
```

| Field | Required | Notes |
|---|---|---|
| `newDate` | Yes | `YYYY-MM-DD`. Must be strictly after today (UTC). |
| `reason` | Yes | Free-form string. Stored for audit. |
| `technicianId` | No | If provided, reassigns pushed visits to this technician. `null` keeps the existing assignment. |
| `notifyCustomers` | No | Default `false`. Notification not yet implemented — field accepted but no email sent. |

**Response 200:**
```json
{
  "pushedCount": 7
}
```

`pushedCount` is `0` if no `SCHEDULED` visits exist for today in this round.
This is not an error — it means the round was already done or had no stops today.

**Error cases:**
- `400` — `newDate` is not a valid `YYYY-MM-DD` string.
- `400` — `newDate` is today or in the past.
- `404` — round not found.

> **Only SCHEDULED visits are moved.** IN_PROGRESS visits are not touched — the
> technician must complete or manually skip them first. If you need to move those
> too, reassign the technician first, then push-missed.

---

## 6. POST /rounds/:id/reassign — reassign technician mid-day

```
POST /rounds/:id/reassign
```

Reassigns today's visits from one technician to another. Used when a technician
calls in sick mid-shift.

**Body:**
```json
{
  "fromTechnicianId": "clg...",
  "toTechnicianId": "clg...",
  "scope": "remaining",
  "note": "Dave called in sick",
  "notify": false
}
```

| Field | Required | Notes |
|---|---|---|
| `fromTechnicianId` | Yes | Technician being replaced |
| `toTechnicianId` | Yes | Technician taking over |
| `scope` | Yes | `"remaining"` — only SCHEDULED/IN_PROGRESS visits; `"all"` — all visits today |
| `note` | No | Reason for reassignment |
| `notify` | No | Default `false`. Notification not yet implemented. |

**Response 200:**
```json
{
  "updatedCount": 5
}
```

**Error cases:**
- `400` — invalid `scope` value.
- `400` — `fromTechnicianId` and `toTechnicianId` are the same.
- `404` — round not found, or either technician not found.

---

## 7. Quick reference

| Action | Method | Path | Role |
|---|---|---|---|
| Today's Work aggregate | GET | `/today` | Any |
| Close operational day | POST | `/today/close` | ADMIN/MANAGER |
| Round today panel | GET | `/rounds/:id/today` | Any |
| Push missed SCHEDULED visits | POST | `/rounds/:id/push-missed` | ADMIN/MANAGER |
| Reassign technician mid-day | POST | `/rounds/:id/reassign` | ADMIN/MANAGER |

---

## 8. Gotchas

- **`dayClosed` is date-based, not time-based.** It resets automatically the next
  UTC day. Do not show "close day" UI if `dayClosed = true`.
- **Push-missed only moves SCHEDULED.** Always check if any IN_PROGRESS visits
  need manual handling before using push-missed.
- **`revenue` in close-day response uses pre-close state.** Visits pushed to
  tomorrow are not in the revenue figure.
- **`etaMinutes` is a rough estimate.** It is `remaining × 20` minutes — purely
  indicative. Do not present it as a precise ETA.
- **`GET /today` includes all rounds** with visits today. If you only need a
  single-round view, use `GET /rounds/:id/today`.
