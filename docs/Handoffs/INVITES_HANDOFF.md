# RoundFlow — Invites: Frontend Handoff

> **Purpose:** everything needed to build the invite flow — sending invites,
> pre-filling the accept screen, and linking a new Supabase user to their
> technician record. Cross-reference the Auth handoff for how Supabase sign-up
> works once the invite is accepted.

**Base URL (dev):** `http://localhost:3000`
**Content-Type:** `application/json` on all requests.
**Invite TTL:** 7 days from creation.

---

## 1. Overview

Technicians do **not** self-signup. The flow is:

```
Admin/Manager                Frontend                   Technician
      │                          │                            │
      │ POST /technicians         │                            │
      │   sendInvite: true  ──►  │                            │
      │                          │── invite email ──────────► │
      │                          │                            │
      │                          │   (technician opens link)  │
      │                          │ ◄──── GET /invites/:token ─│
      │                          │  (pre-fill email/role)     │
      │                          │                            │
      │                          │ (tech signs up via Supabase)
      │                          │ ◄── POST /invites/:token/accept
      │                          │     (Profile created,      │
      │                          │      Technician linked)    │
```

There are two ways to trigger an invite email:
1. `POST /technicians` with `sendInvite: true` — creates the technician and
   immediately sends the email in one call. Preferred for new technicians.
2. `POST /invites` — standalone invite (re-send or invite without pre-existing
   technician). Requires ADMIN/MANAGER auth.

---

## 2. Endpoints

### 2.1 POST /invites — send a standalone invite

Requires `ADMIN` or `MANAGER`. Use this to resend an expired/bounced invite, or
to invite someone without creating a technician record first.

```
POST /invites
Authorization: Bearer <access_token>
```

**Body:**
```json
{
  "email": "dave@example.com",
  "role": "TECHNICIAN",
  "technicianId": "clg..."
}
```

| Field | Required | Notes |
|---|---|---|
| `email` | Yes | Invite destination; normalised to lowercase |
| `role` | No | `ADMIN`, `MANAGER`, or `TECHNICIAN` (default `TECHNICIAN`) |
| `technicianId` | No | Links invite to an existing Technician row. When accepted, `Technician.profileId` is set. |

**Response 201:**
```json
{
  "id": "clg...",
  "token": "a7f3e9b2-...",
  "tenantId": "clg...",
  "email": "dave@example.com",
  "role": "TECHNICIAN",
  "technicianId": "clg...",
  "expiresAt": "2026-08-19T10:00:00.000Z",
  "acceptedAt": null,
  "createdAt": "2026-08-12T10:00:00.000Z"
}
```

**Error cases:**
- `400` — invalid email format, or invalid `role`.
- `404` — `technicianId` given but technician not found.
- `409` — a pending (not yet accepted) invite for this email already exists.
  The existing invite must expire before a new one can be sent.
- `409` — `technicianId` given but technician has already accepted an invite.
- `503` — email delivery failed. The invite row is **rolled back** — safe to
  retry.

---

### 2.2 GET /invites/:token — pre-fill the accept screen

**No auth required.** Called by the frontend when the technician lands on the
accept-invite page, before they sign up.

```
GET /invites/:token
```

**Response 200:**
```json
{
  "email": "dave@example.com",
  "role": "TECHNICIAN",
  "tenantId": "clg...",
  "expiresAt": "2026-08-19T10:00:00.000Z"
}
```

Use this to pre-fill the sign-up form with the technician's email address and to
show them which business is inviting them.

**Error cases:**
- `404` — token not found.
- `410` — invite already accepted or expired.

---

### 2.3 POST /invites/:token/accept — complete sign-up

**Auth required (Supabase token).** Called after the technician has authenticated
via Supabase sign-up. Creates their Profile and links them to their Technician row.

```
POST /invites/:token/accept
Authorization: Bearer <supabase_access_token>
```

**Body:**
```json
{
  "name": "Dave Smith"
}
```

| Field | Required | Notes |
|---|---|---|
| `name` | Yes | Display name stored on Profile |

**Response 201** (first accept):
```json
{
  "profile": {
    "id": "clg...",
    "supabaseUserId": "...",
    "tenantId": "clg...",
    "role": "TECHNICIAN",
    "name": "Dave Smith",
    "createdAt": "2026-08-12T10:00:00.000Z"
  }
}
```

**Response 200** (idempotent re-call — profile already exists):
```json
{ "profile": { /* same profile object */ } }
```

**Error cases:**
- `400` — `name` is blank or missing.
- `403` — authenticated user's email doesn't match the invite email.
- `403` — authenticated user belongs to a different organisation.
- `404` — token not found.
- `410` — invite has expired. The technician must be re-invited.

---

## 3. Invite lifecycle

```
PENDING  ──► ACCEPTED (acceptedAt set)
         └──► EXPIRED  (expiresAt < now, never stored — computed on read)
```

- An accepted invite can never be re-accepted — `GET /invites/:token` returns `410`.
- An expired invite must be re-created with a fresh `POST /invites` call.
- `409` on `POST /invites` means a **pending** invite already exists. The pending
  invite must expire naturally (7 days) before a new one can be sent. There is no
  admin endpoint to force-expire or delete an invite — wait for TTL or contact
  backend.

---

## 4. Frontend flow for the accept-invite page

```
1. Parse ?token from URL.
2. GET /invites/:token → pre-fill email, show business name (not returned but
   can be fetched from GET /setup/step/1 with the tenant token if needed).
   Show 410 error if expired/accepted.
3. Render Supabase sign-up form with email pre-filled and locked.
4. On Supabase sign-up success: supabase.auth.session() gives access_token.
5. POST /invites/:token/accept   { name: "Dave Smith" }
   Authorization: Bearer <access_token>
6. On 201/200: redirect to the app dashboard (tech is now signed in).
```

> **Token in URL:** the invite URL sent by email is
> `{INVITE_BASE_URL}/accept-invite?token=<uuid>`. The token is a UUID — read it
> from `req.query.token` (Next.js) or `useSearchParams` (React Router).

---

## 5. Quick reference

| Action | Method | Path | Auth |
|---|---|---|---|
| Send standalone invite | POST | `/invites` | ADMIN/MANAGER |
| Read invite (pre-fill) | GET | `/invites/:token` | None (public) |
| Accept invite | POST | `/invites/:token/accept` | Supabase token |
