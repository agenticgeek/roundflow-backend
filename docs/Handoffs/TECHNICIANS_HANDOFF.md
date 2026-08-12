# RoundFlow — Technicians: Frontend Handoff

> **Purpose:** everything needed to build the Technicians section — exact API
> contracts, response shapes, status codes, business rules, and gotchas.
> Cross-reference `/docs` (Swagger UI) for live schema if anything appears stale.

**Base URL (dev):** `http://localhost:3000`
**Content-Type:** `application/json` on all requests.
**Auth:** `Authorization: Bearer <supabase_access_token>` on every request.
**Role enforcement:** ALL `/technicians` endpoints require `ADMIN` or `MANAGER`.
A `TECHNICIAN` role gets `403` on every route here.

---

## 1. Data model overview

```
Technician
  ├── id (cuid)
  ├── name, phone, role, email, notes
  ├── active (bool)
  ├── profileId → Profile (null until invite accepted)
  ├── serviceAreas → TechnicianServiceArea[] (join table)
  └── roundTechnicians → Round[] (which rounds they are assigned to)
```

**`appStatus`** is derived (never stored):

| Condition | `appStatus` |
|---|---|
| `active = false` | `INACTIVE` |
| `active = true`, `profileId = null` | `PENDING_INVITE` |
| `active = true`, `profileId` set | `ACTIVE` |

- A newly created technician (no invite sent) is `PENDING_INVITE`.
- Deactivating sets `appStatus` to `INACTIVE`; it does **not** cascade to
  scheduled visits — those must be reassigned manually.
- Reactivating returns to `PENDING_INVITE` (profile still null) or `ACTIVE`.

---

## 2. Endpoints

### 2.1 GET /technicians — list all

```
GET /technicians
```

**Response 200:**
```json
[
  {
    "id": "clg...",
    "name": "Dave Smith",
    "phone": "07700100001",
    "role": "Technician",
    "email": null,
    "notes": null,
    "active": true,
    "appStatus": "PENDING_INVITE",
    "serviceAreas": [
      {
        "serviceAreaId": "clg...",
        "serviceAreaName": "Alnwick North",
        "assignedAt": "2026-08-12T10:00:00.000Z"
      }
    ],
    "createdAt": "2026-08-12T09:00:00.000Z"
  }
]
```

Returns all technicians (active and inactive) for the tenant. No pagination —
technician counts are expected to be small.

---

### 2.2 GET /technicians/:id — detail

```
GET /technicians/:id
```

**Response 200:**
```json
{
  "id": "clg...",
  "name": "Dave Smith",
  "phone": "07700100001",
  "role": "Technician",
  "email": null,
  "notes": null,
  "active": true,
  "appStatus": "PENDING_INVITE",
  "serviceAreas": [
    {
      "serviceAreaId": "clg...",
      "serviceAreaName": "Alnwick North",
      "assignedAt": "2026-08-12T10:00:00.000Z"
    }
  ],
  "createdAt": "2026-08-12T09:00:00.000Z",
  "roundNames": ["Alnwick North Round"],
  "todayWorkload": [
    {
      "roundId": "clg...",
      "roundName": "Alnwick North Round",
      "total": 12,
      "completed": 4,
      "skipped": 1,
      "remaining": 7
    }
  ]
}
```

Extends the list shape with:
- `roundNames` — names of all rounds this technician is currently assigned to.
- `todayWorkload` — per-round breakdown of today's visit counts. Empty array if no
  visits today.

**`404`** if the technician does not exist in this tenant.

---

### 2.3 POST /technicians — create

```
POST /technicians
```

**Body:**
```json
{
  "name": "Dave Smith",
  "phone": "07700100001",
  "role": "Technician",
  "email": "dave@example.com",
  "notes": "Covers Alnwick area",
  "serviceAreaId": "clg...",
  "sendInvite": false
}
```

| Field | Required | Notes |
|---|---|---|
| `name` | No | Technician display name |
| `phone` | No | Free-form string |
| `role` | No | Free-form label (e.g. "Technician", "Lead") |
| `email` | No | Normalised to lowercase. Required when `sendInvite: true` |
| `notes` | No | Internal notes |
| `serviceAreaId` | No | Assigns to one service area on creation |
| `sendInvite` | No | Default `false`. If `true`, sends an invite email via Resend |

**Response 201:** same shape as the list item (`TechnicianRecord`).

**Error cases:**
- `400` — invalid email format, or `sendInvite: true` without an email.
- `409` — `sendInvite: true` and a pending invite for that email already exists.
  Use `POST /invites` to resend.
- `503` — technician was created but invite email delivery failed. Retry with
  `POST /invites` (technician row is NOT rolled back).

> **Important:** email must be unique within the tenant's Technician table.
> Submitting a duplicate email returns a `500` (unhandled constraint). Validate
> uniqueness before submitting, or omit the email and set it later via PATCH.

---

### 2.4 PATCH /technicians/:id — update

```
PATCH /technicians/:id
```

**Body (all fields optional):**
```json
{
  "name": "Dave Smith (Updated)",
  "phone": "07700100099",
  "role": "Lead Technician",
  "email": "dave.new@example.com",
  "notes": "Updated notes",
  "active": false,
  "serviceAreaId": "clg..."
}
```

**`serviceAreaId` semantics:**
- `"clg..."` — replaces all current service areas with this one.
- `null` — clears all service area assignments.
- `undefined` (omit the field) — no change to service areas.

**`active` semantics:**
- `false` — sets `appStatus` to `INACTIVE`. Does **not** unassign from rounds or
  cancel visits. Assigning an inactive technician to a round returns `400`.
- `true` — reactivates. `appStatus` returns to `PENDING_INVITE` (if no profile)
  or `ACTIVE` (if invite was already accepted).

**Response 200:** same shape as the list item (`TechnicianRecord`).

**Error cases:**
- `404` — technician not found.
- `404` — `serviceAreaId` given but service area does not exist.

---

## 3. Invite flow (no separate invite endpoint)

To create a technician and immediately send them an app invite in one call:

```bash
POST /technicians
{
  "name": "Dave Smith",
  "email": "dave@example.com",
  "sendInvite": true
}
```

The invite email is sent via Resend to `dave@example.com`. The link in the email
points to `{INVITE_BASE_URL}/accept-invite?token=<uuid>`. On the frontend, read
the token from the URL and call `POST /invites/:token/accept` after the user has
authenticated via Supabase.

To resend an invite (e.g. link expired, email bounced) use `POST /invites` — see
the Invites handoff.

---

## 4. Role-to-round assignment

Assigning technicians to a round is done via `PUT /rounds/:id/technicians` — see
the Customers, Properties & Rounds handoff (§4.5). That endpoint is on the Rounds
router, not here.

---

## 5. Quick reference

| Action | Method | Path | Status |
|---|---|---|---|
| List all technicians | GET | `/technicians` | ADMIN/MANAGER |
| Technician detail | GET | `/technicians/:id` | ADMIN/MANAGER |
| Create technician | POST | `/technicians` | ADMIN/MANAGER |
| Update / activate / deactivate | PATCH | `/technicians/:id` | ADMIN/MANAGER |
