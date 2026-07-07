# RoundFlow — Setup Wizard: Complete Frontend Handoff

> **Purpose of this document:** everything needed to build the Setup Wizard
> end-to-end — contract (paths, bodies, status codes) **and** behavior
> (semantics, gotchas, resumability) — in one place. No other doc should be
> needed, though the Swagger UI at `/docs` is available to cross-check live.

**Base URL (dev):** `http://localhost:3000`
**Content-Type:** `application/json` on every request.
**Auth:** every `/setup/*` route requires `Authorization: Bearer <access_token>`.

---

## Changelog

| Version | Date | Changes |
|---------|------|---------|
| v2 | 2026-07-08 | Step 2 promoted from deferred stub to real endpoint (`paymentRule`, `debtHoldEnabled`, `vatInInvoices`, `gocardlessConnected`, `stripeConnected`). Technician `name` added to step 6. Required steps for completion updated to 1,2,3,4,6,7,8. |
| v1 | 2026-07-07 | Initial handoff. |

---

## 1. Overview — how the wizard behaves

The Setup Wizard is **stateful and resumable**:

- Each step **saves independently** the moment you POST it. There is no
  "save the whole wizard at the end" step.
- Progress **persists across sessions** — an admin can fill steps 1–4, close
  the browser, log back in days later, and pick up where they left off.
- **Every step is re-editable** — go back and re-POST a step to change it,
  as many times as you like, right up until `POST /setup/complete`.
- `POST /setup/complete` **locks the wizard**. After it succeeds, all step
  `POST` endpoints return `403`, and further edits happen through the normal
  **Settings** screens instead (same underlying data). `GET` endpoints stay
  open forever so Settings can read saved values.
- **Phase 1 note:** setup data is a **single shared business config** — one
  tenant, one record. Any admin token operates on the same setup state; there
  is no per-user/per-admin setup instance.

---

## 2. Auth — getting a token

All `/setup/*` routes are protected by a Supabase-issued **ES256 JWT**.

**Manual/testing flow (curl):**
```bash
curl -X POST 'https://cixtfdnuwbmxvilkvihv.supabase.co/auth/v1/token?grant_type=password' \
  -H 'apikey: <SUPABASE_ANON_KEY>' \
  -H 'Content-Type: application/json' \
  -d '{"email":"<email>","password":"<password>"}'
# → { "access_token": "eyJ...", "expires_in": 3600, "refresh_token": "...", ... }
```

- Token **expires in 3600s (1h)**. Refresh with `grant_type=refresh_token`
  before it expires.
- **In the app**, get the token from the **Supabase JS client**
  (`supabase.auth.getSession()`), or via **Auth › login** in `/docs` — not a
  raw curl call.
- **Verified working:** `access_token` → `GET /auth/me` returns the caller's
  Profile:
  ```json
  { "id": "...", "supabaseUserId": "...", "role": "ADMIN", "name": "...", "createdAt": "...", "updatedAt": "..." }
  ```
- Missing/invalid/expired token on any `/setup/*` route → `401 { "error": "Unauthorized" }`.

---

## 3. Conventions

### Status codes
| Code | When |
|------|------|
| 200 | Success |
| 400 | Bad body / missing-or-invalid field / invalid enum / unknown `serviceAreaId` / `complete` called with required steps missing |
| 401 | No / invalid / expired token |
| 403 | Calling a mutating step **after** setup is already complete |
| 409 | `POST /setup/complete` when setup is **already** complete |
| 500 | Unexpected server error → `{ "error": "Internal Server Error" }` |

All errors (400/401/403/409) → `{ "error": "<message>" }`.

### Money fields
`defaultPrice`, `price`, `amount` are Postgres `money` / Prisma `Decimal`
columns. **They come back as strings** (e.g. `"35"`) because of this.
**Parse on read; send as a plain number on write.**

### Array endpoints (steps 3, 6, 7)
Each accepts **either**:
- a raw JSON array, **or**
- a wrapped object: `{ "services": [...] }` / `{ "technicians": [...] }` / `{ "serviceAreas": [...] }`

Examples throughout use the raw-array form.

### Enums (validate client-side; server also validates and 400s on bad values)
- **`ServiceCategory`** (step 3 `category`, defaults to `DEFAULT` if omitted):
  `DEFAULT` · `WINDOW_CLEANING` · `GUTTER_FASCIA` · `EXTERIOR_CLEANING` · `SPECIALIST`
- **`DayOfWeek`** (steps 1/4 `defaultWorkingDays`, step 8 `defaultDay`):
  `MON` · `TUE` · `WED` · `THU` · `FRI` · `SAT` · `SUN`
- **`CleaningFrequency`** (step 8 `frequency`):
  `FORTNIGHTLY` · `FOUR_WEEKLY` · `SIX_WEEKLY` · `EIGHT_WEEKLY` · `MONTHLY`
- **`PaymentTiming`** (step 2 `paymentRule`):
  `COLLECT_AFTER_VISIT` · `COLLECT_BEFORE_VISIT` · `COLLECT_ON_DATE`
- **`UserRole`** (app-level, lives on Profile — not sent during setup):
  `ADMIN` · `MANAGER` · `TECHNICIAN`. Setup is performed by an `ADMIN`;
  technicians created in step 6 become `TECHNICIAN`-role users only once
  they accept their invite.

> Note: `defaultWorkingDays` (steps 1 & 4) is stored as a plain array of
> strings — the backend does **not** enforce `DayOfWeek` values on it — but
> use the standard codes for consistency with the rest of the app.

---

## 4. Resuming the wizard

Call **`GET /setup/status`** once when the wizard screen opens. It's
**derived live from the database** (nothing is pre-stored), so it's always
current.

**Request:** `GET /setup/status` (no body)

**Response 200** — example where steps 1, 3, 4 are already done:
```json
{
  "setupCompleted": false,
  "allRequiredComplete": false,
  "steps": [
    { "step": 1, "complete": true,  "deferred": false },
    { "step": 2, "complete": false, "deferred": false },
    { "step": 3, "complete": true,  "deferred": false },
    { "step": 4, "complete": true,  "deferred": false },
    { "step": 5, "complete": false, "deferred": true  },
    { "step": 6, "complete": false, "deferred": false },
    { "step": 7, "complete": false, "deferred": false },
    { "step": 8, "complete": false, "deferred": false }
  ]
}
```
→ First incomplete required step here is **2** — resume there.

**How to use this response:**
1. Ignore step 5 (always `deferred`, never blocks anything).
2. Find the **first required step** (1, 2, 3, 4, 6, 7, 8) with `complete: false`
   → open the wizard there.
3. Use `setupCompleted` to decide whether to show the wizard at all — if
   `true`, route the user to the app / Settings instead.
4. Use `allRequiredComplete` to gate the **Complete** button (see §6).

**Completion rules** (server-computed, not client-computed):
- Step 1 = `businessName` is saved
- Step 2 = `paymentRule` is saved
- Step 3 = ≥1 Service exists
- Step 4 = `defaultCycleLength` is saved
- Step 6 = ≥1 Technician exists
- Step 7 = ≥1 ServiceArea exists
- Step 8 = ≥1 `ACTIVE` Round exists

To **pre-fill** a step's form on navigation, call that step's `GET` endpoint —
it returns the actual saved values.

---

## 5. Step-by-step reference

### Step 1 — Business Profile
- **Path:** `GET /setup/step/1` · `POST /setup/step/1`
- **GET:** returns the saved `BusinessSettings` object (or `null` if nothing saved yet). Use to pre-fill.
- **POST semantics:** **Upsert** of the single `BusinessSettings` row — there is only ever one.
- **Re-edit safe:** Yes. Fields you **omit** are left unchanged; a field sent as `null` is cleared. **Exception:** `businessName` must be present on every POST (can't be blanked via this endpoint).

**Request body** (`businessName` required, rest optional):
```json
{
  "businessName": "Acme Window Co",
  "phone": "+44 1665 111111",
  "email": "hello@acme.co.uk",
  "companyNumber": "12345678",
  "vatRegistered": true,
  "vatRegistration": "GB123456789",
  "defaultWorkingDays": ["MON","TUE","WED","THU","FRI"],
  "timezone": "Europe/London",
  "currency": "GBP"
}
```

**Response 200** (`BusinessSettings` row):
```json
{
  "id": "clx...",
  "uniqueId": "singleton",
  "businessName": "Acme Window Co",
  "phone": "+44 1665 111111",
  "email": "hello@acme.co.uk",
  "companyNumber": "12345678",
  "vatRegistration": "GB123456789",
  "vatRegistered": true,
  "defaultWorkingDays": ["MON","TUE","WED","THU","FRI"],
  "timezone": "Europe/London",
  "currency": "GBP",
  "defaultCycleLength": null,
  "bankDetails": null,
  "setupCompleted": false,
  "updatedAt": "2026-07-07T10:00:00.000Z"
}
```

**Errors:** `400` if `businessName` missing/blank · `403` if setup already complete.

**Gotcha:** `defaultWorkingDays` can also be set here — but it's the **same
field** step 4 can write. See critical rule in §7.

---

### Step 2 — Payment Setup
- **Path:** `GET /setup/step/2` · `POST /setup/step/2`
- **GET:** returns the saved `BusinessSettings` object (the **same singleton as steps 1 and 4**) — read the payment fields from it: `paymentRule`, `debtHoldEnabled`, `vatInInvoices`, `gocardlessConnected`, `stripeConnected`. `null` if nothing saved yet.
- **POST semantics:** **Upsert** of that same single `BusinessSettings` record. **All fields optional**; fields you omit are left unchanged.
- **Re-edit safe:** Yes. Step 2 counts as **complete once `paymentRule` is set**. The GoCardless/Stripe connect toggles are **Phase-1 stubs** — flip the booleans; there is no real OAuth yet.

**Request body** (all optional; `paymentRule` validated against `PaymentTiming`):
```json
{
  "paymentRule": "COLLECT_AFTER_VISIT",
  "debtHoldEnabled": true,
  "vatInInvoices": true,
  "gocardlessConnected": false,
  "stripeConnected": false
}
```
`paymentRule` ∈ `COLLECT_AFTER_VISIT` · `COLLECT_BEFORE_VISIT` · `COLLECT_ON_DATE`.

**Response 200** (`BusinessSettings` row — payment fields shown in context):
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
  "setupCompleted": false,
  "updatedAt": "2026-07-08T10:00:00.000Z"
}
```

**Errors:** `400` if `paymentRule` is not a valid `PaymentTiming` value · `403` if setup already complete.

**Gotcha:** The GoCardless and Stripe **"Connect" buttons should flip
`gocardlessConnected` / `stripeConnected` to `true`** — **no OAuth redirect is
needed in Phase 1.** They're plain booleans persisted on the singleton. Real
connect flows (provider OAuth) come in **Phase 2**.

---

### Step 3 — Service Catalogue
- **Path:** `GET /setup/step/3` · `POST /setup/step/3`
- **GET:** returns array of saved services (`[]` if none). Use to pre-fill the editor.
- **POST semantics:** **Full replace** — the posted array becomes the entire catalogue; existing services are deleted first.
- **Re-edit safe:** Yes, **but only if you send the complete desired list every time**. Pattern: `GET` → edit in UI → `POST` the whole list.

**GET Response 200:**
```json
[
  {
    "id": "clx...",
    "name": "Full exterior window clean",
    "category": "WINDOW_CLEANING",
    "description": "Frames + glass",
    "defaultPrice": "35",
    "active": true,
    "createdAt": "2026-07-07T10:00:00.000Z",
    "updatedAt": "2026-07-07T10:00:00.000Z"
  }
]
```

**POST Request body** (raw array or `{ "services": [...] }`; `name` + `defaultPrice` required per item):
```json
[
  { "name": "Full exterior window clean", "category": "WINDOW_CLEANING", "description": "Frames + glass", "defaultPrice": 35, "active": true },
  { "name": "Gutter clear", "category": "GUTTER_FASCIA", "defaultPrice": 60 }
]
```
`category` defaults to `DEFAULT`; `active` defaults to `true`.

**Returns:** the new `Service[]` catalogue. **`defaultPrice` comes back as a string.**

**Errors:** `400` if any `name` blank, any `defaultPrice` not a number, or invalid `category` · `403` if complete.

**Gotcha:** Sending an **empty array wipes the whole catalogue.**

---

### Step 4 — Round Settings
- **Path:** `GET /setup/step/4` · `POST /setup/step/4`
- **GET:** returns the **same `BusinessSettings` object as step 1** — read `defaultCycleLength` and `defaultWorkingDays` from it.
- **POST semantics:** **Upsert** of the same single `BusinessSettings` record as step 1.
- **Re-edit safe:** Yes. Only writes `defaultCycleLength` and `defaultWorkingDays`; leaves step 1's fields untouched.

**Request body** (`defaultCycleLength` required, in days):
```json
{ "defaultCycleLength": 28, "defaultWorkingDays": ["MON","TUE","WED","THU","FRI"] }
```

**Response 200:** the full `BusinessSettings` row (same shape as step 1, now with `defaultCycleLength: 28`).

**Errors:** `400` if `defaultCycleLength` not a number · `403` if complete.

**Gotcha:** Steps 1 and 4 write to the **same record** (§7). `defaultWorkingDays` can be written by either — whichever is sent last wins.

---

### Step 5 — SMS Templates (DEFERRED)
- **Path:** `GET /setup/step/5` · `POST /setup/step/5`
- **POST does no DB write.**

**Response (both):**
```json
{ "status": "deferred", "reason": "SMS templates are managed via GHL" }
```

**Gotcha:** Placeholder in Phase 1 — informational screen only.

---

### Step 6 — Technicians
- **Path:** `GET /setup/step/6` · `POST /setup/step/6`
- **GET:** returns array of technicians. Use to pre-fill.
- **POST semantics:** **Replace of invite-pending technicians only.** All technicians who haven't yet accepted an invite are deleted, then the posted list is created. Technicians who have **already accepted an invite are never touched.**
- **Re-edit safe:** Yes — re-posting replaces (doesn't duplicate). Send the complete list of invite-pending technicians you want.

**Request body** (raw array or `{ "technicians": [...] }`; all fields optional, incl. `name`):
```json
[
  { "name": "James Fisher", "role": "Senior", "phone": "+44 7700 900111", "active": true },
  { "name": "Ade Cole", "role": "Trainee", "phone": "+44 7700 900222" }
]
```

**Response 200:**
```json
[
  {
    "id": "clx...",
    "profileId": null,
    "name": "James Fisher",
    "role": "Senior",
    "phone": "+44 7700 900111",
    "active": true,
    "avatarUrl": null,
    "createdAt": "2026-07-07T10:00:00.000Z",
    "updatedAt": "2026-07-07T10:00:00.000Z"
  }
]
```

**Errors:** `403` if complete.

**Gotcha — `name` is a display label, not identity.** `name` is the admin's
label for the invite ("invited as…"), stored as `Technician.name` (nullable).
A technician created here is a placeholder invite — `profileId: null`. Once the
technician **accepts their invite via the mobile app**, their `Profile.name`
becomes the **source of truth and overrides** this label — the wizard only
records the label. Still a **full replace**: send the complete invite-pending
list each time; omitting an existing invite-pending technician **deletes it**
(accepted technicians are never touched).

---

### Step 7 — Service Areas
- **Path:** `GET /setup/step/7` · `POST /setup/step/7`
- **GET:** returns array of service areas.
- **POST semantics:** **Full replace** — all service areas deleted, then posted list created.
- **Re-edit safe:** Yes — send the complete desired list.

**Request body** (raw array or `{ "serviceAreas": [...] }`; `name` required per item):
```json
[
  { "name": "Alnwick", "postcodeSector": "NE66", "isDefault": true },
  { "name": "Morpeth", "postcodeSector": "NE61" }
]
```

**Response 200:**
```json
[
  {
    "id": "clx...",
    "name": "Alnwick",
    "postcodeSector": "NE66",
    "isDefault": true,
    "createdAt": "2026-07-07T10:00:00.000Z"
  }
]
```
*(Note: `ServiceArea` has **no** `updatedAt`.)*

**Errors:** `400` if any `name` blank · `403` if complete.

**Gotcha:** Empty array wipes all areas. **The `id`s returned here are what
you pass to step 8** (`serviceAreaId`) — create areas **before** the round.

---

### Step 8 — First Round
- **Path:** `GET /setup/step/8` · `POST /setup/step/8`
- **GET:** returns array of **ACTIVE** rounds only (normally one during setup).
- **POST semantics:** **Create-or-update of the single setup round.** If an ACTIVE round already exists, this **updates** it; otherwise it **creates** one.
- **Re-edit safe:** Yes — re-posting updates the same round, never creates a second.

**Request body** (`name` required; rest optional but validated if present):
```json
{ "name": "Alnwick Monday", "defaultDay": "MON", "frequency": "FOUR_WEEKLY", "serviceAreaId": "clx..." }
```

**Response 200:**
```json
{
  "id": "clx...",
  "name": "Alnwick Monday",
  "defaultDay": "MON",
  "frequency": "FOUR_WEEKLY",
  "description": null,
  "status": "ACTIVE",
  "serviceAreaId": "clx...",
  "createdAt": "2026-07-07T10:00:00.000Z",
  "updatedAt": "2026-07-07T10:00:00.000Z"
}
```

**Errors:** `400` if `name` blank, invalid `defaultDay`/`frequency` enum, or unknown `serviceAreaId` · `403` if complete.

**Gotcha:** `serviceAreaId` must reference a real area from step 7 — if it
doesn't exist you get `400`. POST step 7 first, read a returned area `id`,
then use it here.

---

## 6. Completion flow

**`POST /setup/complete`** (no request body) finalizes setup.

- **Checks:** every **required** step — **1, 2, 3, 4, 6, 7, 8** — is complete.
  (Only step 5 is deferred and never counts.)
- **200 — success:** sets `setupCompleted = true`, returns the final status
  object (same shape as `GET /setup/status`, now with `setupCompleted: true`
  and `allRequiredComplete: true`). Wizard is now locked.
- **400 — required steps missing:**
  ```json
  { "error": "Setup cannot be completed — required steps incomplete: 2, 3, 4, 6, 7, 8" }
  ```
  The message lists exactly which required steps are still incomplete — use
  it to route the user back to the right step.
- **409 — already complete:**
  ```json
  { "error": "Setup is already complete." }
  ```

**After completion, all mutating step endpoints return:**
```json
403 { "error": "Setup is already complete; wizard endpoints are locked." }
```
`GET` endpoints (status, step lists, deferred stub) keep working forever —
Settings screens read from them.

**Best practice:** gate the **Complete** button on `allRequiredComplete` from
`GET /setup/status` so the user only calls `/setup/complete` when it will
succeed — but still handle `400`/`409` defensively in code.

---

## 7. ⚠️ Critical rules — read before wiring up POSTs

> - **Steps 3, 6, 7 are FULL REPLACEMENTS, not deltas.** Always send the
>   **entire** desired list. Omitted items are **deleted**. Pattern: `GET` →
>   edit in UI → `POST` the whole list.
>   (Step 6 replaces only *invite-pending* technicians — accepted ones are
>   safe. Steps 3 and 7 replace everything of that type.)
>
> - **Step 8 is create-or-update.** Re-posting updates the existing round;
>   it never creates a second one. Safe to POST repeatedly while the user edits.
>
> - **Steps 1, 2 and 4 write to the SAME record** (the single business-settings
>   row). Step 1 owns: `businessName`, `phone`, `email`, `companyNumber`,
>   `vatRegistered`, `vatRegistration`, `timezone`, `currency`. Step 4 owns:
>   `defaultCycleLength`, `defaultWorkingDays`. Step 2 owns: `paymentRule`,
>   `debtHoldEnabled`, `vatInInvoices`, `gocardlessConnected`, `stripeConnected`.
>   Each step only touches its own fields — they don't clobber each other.
>   (`defaultWorkingDays` can be written by step 1 or 4; last write wins.)
>
> - **Step 5 is the only deferred stub.** Its `GET` and `POST` return
>   `{ status: "deferred", reason }` and write **nothing** — render an info
>   screen; don't collect data. **Step 2 is real** — it upserts payment config
>   on the `BusinessSettings` singleton (see §5).
>
> - **After `POST /setup/complete`, all step POSTs return `403`.** `GET`
>   endpoints stay open — Settings screens use them to read/show saved values.
>
> - **Money fields come back as strings.** `defaultPrice` (and, elsewhere,
>   `price`/`amount`) return as strings like `"35"` (Postgres money type).
>   **Parse on read; send as a number on write.**

---

## 8. Recommended happy-path sequence

A fresh wizard, completed in order (`Authorization: Bearer <token>` on every
request):

```bash
TOKEN="<access_token>"
BASE=http://localhost:3000
AUTH=(-H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json")

# 1. Check status, resume at first incomplete required step (brand-new tenant → step 1)
curl "${AUTH[@]}" "$BASE/setup/status"

# 2. Business profile
curl "${AUTH[@]}" -X POST "$BASE/setup/step/1" -d '{"businessName":"Acme Window Co","timezone":"Europe/London","currency":"GBP"}'

# 3. Payment setup (real — set at least paymentRule; connect toggles are Phase-1 booleans)
curl "${AUTH[@]}" -X POST "$BASE/setup/step/2" -d '{"paymentRule":"COLLECT_AFTER_VISIT","debtHoldEnabled":true,"vatInInvoices":true}'

# 4. Service catalogue (full list)
curl "${AUTH[@]}" -X POST "$BASE/setup/step/3" -d '[{"name":"Full window clean","category":"WINDOW_CLEANING","defaultPrice":35}]'

# 5. Round settings
curl "${AUTH[@]}" -X POST "$BASE/setup/step/4" -d '{"defaultCycleLength":28}'

# 6. Step 5 is deferred — show info screen, no data

# 7. Technicians (invite-pending — name is the admin's label until invite acceptance)
curl "${AUTH[@]}" -X POST "$BASE/setup/step/6" -d '[{"name":"James Fisher","role":"Senior","phone":"+44 7700 900111"}]'

# 8. Service areas — READ THE RESPONSE AND KEEP THE id(s)
curl "${AUTH[@]}" -X POST "$BASE/setup/step/7" -d '[{"name":"Alnwick","postcodeSector":"NE66","isDefault":true}]'

# 9. First round — use a serviceAreaId captured from step 7's response
curl "${AUTH[@]}" -X POST "$BASE/setup/step/8" -d '{"name":"Alnwick Monday","defaultDay":"MON","frequency":"FOUR_WEEKLY","serviceAreaId":"<id from step 7>"}'

# 10. Complete
curl "${AUTH[@]}" -X POST "$BASE/setup/complete"
```

At any point before step 10, the user can go **back** and re-POST any step
to edit it — remembering the replace rules for 3/6/7 (send the full list
each time) and that step 8 updates the existing round rather than creating
a new one.

---

## 9. Quick-reference table

| Step | Path | Required? | POST semantics | Empty-array/omit risk |
|------|------|-----------|-----------------|------------------------|
| 1 | `/setup/step/1` | Yes | Upsert (partial ok, `businessName` always required) | N/A |
| 2 | `/setup/step/2` | Yes | Upsert (partial ok) | N/A |
| 3 | `/setup/step/3` | Yes | Full replace | Empty array wipes catalogue |
| 4 | `/setup/step/4` | Yes | Upsert (same record as step 1) | N/A |
| 5 | `/setup/step/5` | No — deferred | No-op | — |
| 6 | `/setup/step/6` | Yes | Replace invite-pending only (`name` now accepted) | Omitted invite-pending techs deleted; accepted ones safe |
| 7 | `/setup/step/7` | Yes | Full replace | Empty array wipes all areas |
| 8 | `/setup/step/8` | Yes | Create-or-update | N/A — always safe to re-POST |

Required steps for completion: **1, 2, 3, 4, 6, 7, 8**. Step **5** never
blocks completion.

---

*Cross-reference: `/docs` (Swagger UI) has the interactive, always-current
contract if anything here appears stale.*
