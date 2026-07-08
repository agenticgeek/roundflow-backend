# RoundFlow — Settings API: Frontend Handoff

> **Purpose of this document:** everything needed to build the Settings screens
> end-to-end — contract (paths, bodies, status codes) **and** behavior
> (semantics, the setup guard, per-section rules, gotchas) — in one place. No
> other doc should be needed, though the Swagger UI at `/docs` (tag **Settings**)
> is available to cross-check live.

**Base URL (dev):** `http://localhost:3000`
**Content-Type:** `application/json` on every request.
**Auth:** every `/settings/*` route requires `Authorization: Bearer <access_token>`
(same Supabase ES256 JWT as `/setup/*` — see the Auth handoff for how to get it).

---

## 1. Overview

Settings is the **post-completion editing surface** for the same data the Setup
Wizard seeds. **21 endpoints across 7 sub-sections.**

- **GET endpoints are always open** (even before setup completes) so the Setup
  Wizard can read back saved values.
- **Mutations (PATCH, POST, DELETE) require setup to be complete.** They return
  **`403`** if `setupCompleted = false` (or the business-settings row doesn't
  exist yet). Check `GET /setup/status` before rendering Settings (see §2).
- **Single-tenant (Phase 1):** one shared business config. Any admin token
  operates on the same Settings state; there is no per-user instance.
- This is the **inverse** of the wizard: `/setup/*` mutations require setup to be
  *incomplete*; `/settings/*` mutations require it to be *complete*.

---

## 2. The setup guard

On app load (once authenticated), call **`GET /setup/status`**:

- If **`setupCompleted = false`** → **do not render Settings**; redirect the user
  to the **Setup Wizard** (`/setup`).
- If **`setupCompleted = true`** → Settings is fully accessible.

The guard is **also enforced server-side** — every mutating Settings endpoint
calls `assertSetupComplete` and returns `403` when setup isn't complete. So you
never have to trust the frontend state alone: even if a mutation slips through,
the backend rejects it. On a `403` from a Settings mutation, treat it as "setup
not complete" and route to the wizard (see §11).

---

## 3. Base URL and auth

Identical to the Setup Wizard: `Authorization: Bearer <access_token>` on **every**
request (GET included). Get the token from the Supabase JS client
(`supabase.auth.getSession()`), or via **Auth › login** in `/docs`. Missing /
invalid / expired token on any `/settings/*` route → `401 { "error": "Unauthorized" }`.

---

## 4. Section-by-section reference

### 4.1 Business Profile — Screen 23
- **Endpoints:** `GET /settings/business-profile` · `PATCH /settings/business-profile`
- **GET:** returns the `BusinessSettings` singleton (or **`null`** if nothing saved yet).
- **PATCH semantics:** **partial upsert of step-1 fields only.** Omitted fields
  are **untouched**; a field sent as `null` is **cleared**. Never touches
  round-settings fields (see §9).
- **Owns:** `businessName`, `phone`, `email`, `companyNumber`, `vatRegistered`,
  `vatRegistration`, `timezone`, `currency`, `defaultWorkingDays`.
- **Request body** (all optional):
  ```json
  { "businessName": "Northumberland Window Cleaning", "phone": "+44 1665 111111", "email": "hello@northumberlandwindows.co.uk", "vatRegistered": true, "timezone": "Europe/London", "currency": "GBP" }
  ```
- **Response 200:** the full `BusinessSettings` row (see §8 for the shape).
- **Errors:** `400` bad field type · `401` no token · `403` setup not complete.
- **Gotcha:** `defaultWorkingDays` is **shared** with Round Settings — see §9.

### 4.2 Round Settings — Screen 33
- **Endpoints:** `GET /settings/round-settings` · `PATCH /settings/round-settings`
- **GET:** returns the **same `BusinessSettings` singleton** — read `defaultCycleLength` / `defaultWorkingDays`.
- **PATCH semantics:** partial upsert of **round fields only**.
- **Owns:** `defaultCycleLength` (Int, **days**) · `defaultWorkingDays` (shared).
- **Request body:**
  ```json
  { "defaultCycleLength": 28, "defaultWorkingDays": ["MON","TUE","WED","THU","FRI"] }
  ```
- **Response 200:** the full `BusinessSettings` row.
- **Errors:** `400` · `401` · `403`.
- **Gotcha:** the UI shows the cycle as *Week / 2-week / 3-week / 4-week* but the
  API stores **days** — map weeks → days client-side (7 / 14 / 21 / 28). Clean
  method, auto-generate-visits, and reminder timing are **not** in the API yet.

### 4.3 Service Catalogue — Screen 24 (+ M16 Add, M17 Edit)
- **Endpoints:** `GET /settings/services` · `POST /settings/services` · `PATCH /settings/services/:id` · `DELETE /settings/services/:id`
- **GET:** returns `Service[]` (`[]` if none).
- **POST** (M16 Add New Service): creates one service → **`201`**. `name` +
  `defaultPrice` required; `category` defaults to `DEFAULT`; `active` defaults to `true`.
- **PATCH /:id** (M17 Edit Service): partial update — omitted fields untouched.
- **DELETE /:id:** `204` on success; **`409`** if any `ServicePlan` or `Visit`
  references the service; `404` if not found.
- **Request body (POST):**
  ```json
  { "name": "Gutter clear", "category": "GUTTER_FASCIA", "description": "Clear + flush gutters and downpipes", "defaultPrice": 60, "active": true }
  ```
- **Response (Service):**
  ```json
  { "id": "clx...", "name": "Gutter clear", "category": "GUTTER_FASCIA", "description": "Clear + flush gutters and downpipes", "defaultPrice": "60", "active": true, "createdAt": "2026-07-08T10:00:00.000Z", "updatedAt": "2026-07-08T10:00:00.000Z" }
  ```
- **Errors:** `400` (blank `name`, non-number `defaultPrice`, invalid `category`) · `401` · `403` · `404` (PATCH/DELETE) · `409` (DELETE in use).
- **Gotcha:** `defaultPrice` **comes back as a string** (`"60"`) — parse on read, send as a number on write. `category` ∈ `DEFAULT · WINDOW_CLEANING · GUTTER_FASCIA · EXTERIOR_CLEANING · SPECIALIST`.

### 4.4 Service Areas — Screen 36
- **Endpoints:** `GET /settings/service-areas` · `POST /settings/service-areas` · `PATCH /settings/service-areas/:id` · `DELETE /settings/service-areas/:id`
- **GET:** returns `ServiceArea[]`, each with a **derived, read-only `linkedRounds`** summary (`{ count, names }`) of Rounds referencing the area.
- **POST:** creates one → `201`. `name` required; `postcodeSector` optional; `isDefault` defaults `false`.
- **PATCH /:id:** partial update.
- **DELETE /:id:** `204`; **`409`** if any `Round` or `Property` references the area; `404` if not found.
- **Request body (POST):**
  ```json
  { "name": "Morpeth", "postcodeSector": "NE61", "isDefault": false }
  ```
- **Response (ServiceArea — note: no `updatedAt`):**
  ```json
  { "id": "clx...", "name": "Morpeth", "postcodeSector": "NE61", "isDefault": false, "createdAt": "2026-07-08T10:00:00.000Z" }
  ```
  GET list items additionally carry `"linkedRounds": { "count": 2, "names": ["Alnwick Monday","Alnwick Wednesday"] }`.
- **Errors:** `400` (blank `name`) · `401` · `403` · `404` · `409` (DELETE in use).
- **Gotcha:** `linkedRounds` is **display-only** — you can't set it. If `count > 0`, expect a `409` on delete; consider disabling the delete button.

### 4.5 Technician Management — Screen 35 (+ M18 Remove confirm)
- **Endpoints:** `GET /settings/technicians` · `POST /settings/technicians` · `PATCH /settings/technicians/:id` · `DELETE /settings/technicians/:id`
- **GET:** returns `Technician[]`, each enriched with **`displayName`**, **`appStatus`**, and the linked **`profile`** (see §5).
- **POST:** creates one **invite-pending** technician (`profileId = null`) → `201`. All fields optional (`name`, `phone`, `role`, `active` default `true`).
- **PATCH /:id:** partial update (`name`, `phone`, `role`, `active`).
- **DELETE /:id:** `204` **only for invite-pending** technicians; **`409`** if the technician has accepted their invite (`profileId` set); `404` if not found.
- **Request body (POST):**
  ```json
  { "name": "James Fisher", "role": "Lead Technician", "phone": "+44 7700 900111", "active": true }
  ```
- **Response (Technician, create/update):**
  ```json
  { "id": "clx...", "profileId": null, "name": "James Fisher", "role": "Lead Technician", "phone": "+44 7700 900111", "active": true, "avatarUrl": null, "createdAt": "2026-07-08T10:00:00.000Z", "updatedAt": "2026-07-08T10:00:00.000Z" }
  ```
  GET list items additionally carry `"profile": null | {...}`, `"displayName": "James Fisher"`, `"appStatus": "PENDING_INVITE"`.
- **Errors:** `400` · `401` · `403` · `404` · `409` (DELETE on an accepted technician).
- **Gotchas:** see §5 (`displayName`, `appStatus`, Danger Zone = deactivation, invites).

### 4.6 Payment Setup — Screen 32
- **Endpoints:** `GET /settings/payment` · `PATCH /settings/payment` · `POST /settings/payment/:provider/connect`
- **GET:** returns the `BusinessSettings` singleton — read `paymentRule`, `vatInInvoices`, `debtHoldEnabled`, `gocardlessConnected`, `stripeConnected`.
- **PATCH:** updates **rules only** (`paymentRule`, `vatInInvoices`, `debtHoldEnabled`) — **never the connect flags**.
- **POST /:provider/connect:** Phase-1 **stub** — flips `gocardlessConnected` / `stripeConnected` to `true`; returns `{ "status": "connected" }`. `:provider` ∈ `gocardless` | `stripe`.
- **Request body (PATCH):**
  ```json
  { "paymentRule": "COLLECT_AFTER_VISIT", "vatInInvoices": true, "debtHoldEnabled": true }
  ```
  `paymentRule` ∈ `COLLECT_AFTER_VISIT · COLLECT_BEFORE_VISIT · COLLECT_ON_DATE`.
- **Response (PATCH):** the full `BusinessSettings` row. **(POST connect):** `{ "status": "connected" }`.
- **Errors:** `400` (invalid `paymentRule` / unknown provider) · `401` · `403`.
- **Gotcha:** see §6 — keep the **connect** call separate from the **rules** PATCH.

### 4.7 SMS Templates — Screen 34
- **Endpoints:** `GET /settings/message-templates` · `PATCH /settings/message-templates`
- **Both** return `{ "status": "deferred", "source": "ghl" }`. **No data is stored.**
- **Errors:** `401` (GET) · `401` / `403` (PATCH).
- **Gotcha:** render a **"Coming soon" / "Managed via GHL"** message — **do not**
  show an editable form (see §7).

---

## 5. Technician-specific rules

- **`displayName` derivation:** the backend computes
  `profile?.name ?? technician.name ?? null`. **Use `displayName` for display —
  never raw `technician.name` alone.** (Once an invite is accepted, the linked
  `Profile.name` becomes the source of truth and overrides the admin's label.)
- **`appStatus`:**
  - `PENDING_INVITE` — `profileId` is `null` (invited, not yet accepted).
  - `ACTIVE` — `profileId` set and `active = true`.
  - `INACTIVE` — `profileId` set and `active = false`.
- **Danger Zone → Remove Technician = deactivation, NOT deletion.** Map the
  Danger-Zone "Remove Technician" action (Screen 29 / modal **M18**) to
  **`PATCH /settings/technicians/:id` with `{ "active": false }`**. The backend
  **`409`s a `DELETE`** on an accepted technician (one with a `profileId`), because
  hard-deleting would orphan their visit history (breaks Reports & History,
  Screen 18). **Never call `DELETE` for the Danger-Zone action.**
- **`POST /settings/technicians` creates invite-pending** (`profileId = null`).
  **Sending the actual app invite is handled separately** (the "Send App Invite
  via SMS" toggle → M5 flow, **not yet built**). For now, creating a technician
  just records the roster entry; it doesn't send anything.
- **`DELETE`** is therefore only valid for **invite-pending** rows (e.g. removing
  a mistaken entry before anyone accepts).

---

## 6. Payment Setup specifics

- **`PATCH /settings/payment` updates rules only** — `paymentRule`,
  `vatInInvoices`, `debtHoldEnabled`. It **never** touches `gocardlessConnected` /
  `stripeConnected`.
- **`POST /settings/payment/:provider/connect`** flips the connect boolean.
  **Phase-1 stub:** returns `{ "status": "connected" }` with **no OAuth URL**.
  Provider values: **`"gocardless"`** or **`"stripe"`** (anything else → `400`).
- **Keep the two operations separate** — the connect action and the rules PATCH
  are intentionally different endpoints. Don't try to set the connect flags via
  the rules PATCH (it ignores them); don't send rules to the connect endpoint.
- Phase 2 (GHL) will return a real `connectUrl` from the connect endpoint — the
  response shape (`{ status, connectUrl? }`) is already forward-compatible, so
  handle an optional `connectUrl` gracefully even though Phase 1 never sends one.

---

## 7. SMS Templates

Both `GET` and `PATCH /settings/message-templates` return:
```json
{ "status": "deferred", "source": "ghl" }
```
No data is stored and nothing is written. In the UI, render a **read-only
"Coming soon — managed via GHL"** state for Screen 34 — **do not** build an
editable template form. Messaging is owned by GHL in Phase 2.

---

## 8. Shared `BusinessSettings` fields — avoid clobbering

Business Profile (§4.1), Round Settings (§4.2), and Payment Setup (§4.6) all read
and write the **same single `BusinessSettings` row**. Each endpoint only writes
its own fields, so they don't clobber each other — **as long as you send each
endpoint only its own fields.**

| Endpoint | Owns (writes) these fields |
|---|---|
| `PATCH /settings/business-profile` | `businessName`, `phone`, `email`, `companyNumber`, `vatRegistered`, `vatRegistration`, `timezone`, `currency`, `defaultWorkingDays` |
| `PATCH /settings/round-settings` | `defaultCycleLength`, `defaultWorkingDays` |
| `PATCH /settings/payment` | `paymentRule`, `vatInInvoices`, `debtHoldEnabled` |
| `POST /settings/payment/:provider/connect` | `gocardlessConnected` **or** `stripeConnected` |

- **`defaultWorkingDays` is shared** by Business Profile *and* Round Settings —
  whichever endpoint you `PATCH` last wins for that field. Pick one screen to own
  the working-days control to avoid surprises.
- **Never send round-settings fields to `PATCH /settings/business-profile`** (or
  vice versa) — they'd be ignored by validation anyway, but keep the payloads
  clean and scoped to the fields in the table above.

The full `BusinessSettings` response shape (returned by the GETs and the PATCHes
of Business Profile / Round Settings / Payment):
```json
{
  "id": "clx...",
  "uniqueId": "singleton",
  "businessName": "Northumberland Window Cleaning",
  "phone": "+44 1665 111111",
  "email": "hello@northumberlandwindows.co.uk",
  "companyNumber": "12345678",
  "vatRegistration": "GB123456789",
  "vatRegistered": true,
  "defaultWorkingDays": ["MON","TUE","WED","THU","FRI"],
  "timezone": "Europe/London",
  "currency": "GBP",
  "defaultCycleLength": 28,
  "bankDetails": null,
  "paymentRule": "COLLECT_AFTER_VISIT",
  "debtHoldEnabled": true,
  "vatInInvoices": true,
  "gocardlessConnected": false,
  "stripeConnected": false,
  "setupCompleted": true,
  "updatedAt": "2026-07-08T10:00:00.000Z"
}
```

---

## 9. Per-item CRUD pattern (Services, Service Areas, Technicians)

The three collection sections all follow the same shape:

- **`POST /settings/<collection>`** — creates **one** item, returns **`201`** with the created row.
- **`PATCH /settings/<collection>/:id`** — **partial** update; **omitted fields are untouched**, so send only what changed.
- **`DELETE /settings/<collection>/:id`** —
  - **`204`** on success (empty body),
  - **`409`** if the item is **referenced** by other data → **show a UI error, do not retry**,
  - **`404`** if it's already gone (treat as success / refresh the list).

Pattern: **GET the list → edit in the UI → POST/PATCH/DELETE the single item →
optimistically update or refetch.** (This differs from the wizard's Services /
Areas steps, which are full-list *replaces*; Settings is per-item.)

---

## 10. ⚠️ Critical rules — read before wiring up Settings

> - **`403` on a mutation = setup not complete.** Redirect to the Setup Wizard —
>   **do not** show an error toast. Gate Settings on `GET /setup/status` up front.
>
> - **`409` on delete = item is in use.** Show a user-friendly message, e.g.
>   *"This service is being used by existing plans and cannot be deleted."*
>   Do **not** retry the DELETE.
>
> - **Money fields come back as strings.** `defaultPrice` returns as `"60"`
>   (Postgres money type). **Parse on read; send as a number on write.**
>
> - **SMS Templates (Screen 34) are deferred** — render read-only / "managed via
>   GHL", never an editable form.
>
> - **Technician Danger Zone = `PATCH { "active": false }`, never `DELETE`.**
>   `DELETE` on an accepted technician returns `409`.
>
> - **After `PATCH /settings/technicians/:id { "active": false }`**, the
>   technician's `appStatus` becomes **`INACTIVE`** — update the row's status pill
>   locally without a full refetch if you can (the PATCH response is the updated
>   `Technician`; derive `appStatus` = `profileId` set + `active:false` → `INACTIVE`).
>
> - **Use `displayName`, not raw `technician.name`**, everywhere you show a
>   technician's name.
>
> - **Keep payloads scoped** — send each `BusinessSettings` endpoint only the
>   fields it owns (§8).

---

## 11. Quick-reference table

| Section | Screen | GET | PATCH | POST | DELETE | Notes |
|---------|--------|-----|-------|------|--------|-------|
| Business Profile | 23 | `/settings/business-profile` | ✅ partial | — | — | step-1 fields only |
| Round Settings | 33 | `/settings/round-settings` | ✅ partial | — | — | `defaultCycleLength` (days) |
| Service Catalogue | 24 | `/settings/services` | `:id` partial | ✅ 201 | `:id` (409 if in use) | `defaultPrice` is a string |
| Service Areas | 36 | `/settings/service-areas` | `:id` partial | ✅ 201 | `:id` (409 if in use) | GET adds `linkedRounds` |
| Technician Mgmt | 35 | `/settings/technicians` | `:id` partial | ✅ 201 (invite-pending) | `:id` (409 if accepted) | Danger Zone = `PATCH {active:false}` |
| Payment Setup | 32 | `/settings/payment` | ✅ rules only | `:provider/connect` (stub) | — | connect ≠ rules |
| SMS Templates | 34 | `/settings/message-templates` | ✅ (no-op) | — | — | deferred `{status,source}` |

All mutations also return **`403`** until `setupCompleted = true`. GETs never return `403`.

---

## 12. Happy-path examples

```bash
TOKEN="<access_token>"
BASE=http://localhost:3000
AUTH=(-H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json")

# Read business profile (null if nothing saved)
curl "${AUTH[@]}" "$BASE/settings/business-profile"

# Partial update — just the name (other fields untouched)
curl "${AUTH[@]}" -X PATCH "$BASE/settings/business-profile" \
  -d '{"businessName":"Northumberland Window Cleaning"}'

# Create one service (returns 201)
curl "${AUTH[@]}" -X POST "$BASE/settings/services" \
  -d '{"name":"Gutter clear","category":"GUTTER_FASCIA","defaultPrice":60}'

# Delete a service — 204 if unused; 409 if referenced by plans/visits:
#   → { "error": "Service is in use and cannot be deleted" }  (show a UI message, do NOT retry)
curl "${AUTH[@]}" -X DELETE "$BASE/settings/services/<id>"

# Create an invite-pending technician (profileId = null)
curl "${AUTH[@]}" -X POST "$BASE/settings/technicians" \
  -d '{"name":"James Fisher","role":"Lead Technician","phone":"+44 7700 900111"}'

# Danger Zone → "Remove Technician" = DEACTIVATE (never DELETE an accepted tech)
curl "${AUTH[@]}" -X PATCH "$BASE/settings/technicians/<id>" \
  -d '{"active":false}'

# Connect a payment provider (Phase-1 stub → { "status": "connected" })
curl "${AUTH[@]}" -X POST "$BASE/settings/payment/gocardless/connect"
```

> Any mutation above returns `403 { "error": "Setup must be completed before editing settings. Complete the Setup Wizard first." }` if `setupCompleted = false` — gate on `GET /setup/status` first.

---

*Cross-reference: `docs/SETTINGS_API_DESIGN.md` (design decisions + Phase-2 coupling
rules), `docs/designFindings.md` Screens 23/24/32–36 + modals M16/M17/M18 (visual/
field detail), and `/docs` (Swagger UI, **Settings** tag) for the always-current
contract if anything here appears stale.*
