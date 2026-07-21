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
| v3 | 2026-07-21 | Steps 9–12 implemented: Add Property (step 9), Assign Technicians to Rounds (step 10), Generate Visits & Activate (step 11), Review & Launch checklist (step 12). New enums: `PropertyType`, `PaymentMethod`. `RoundTechnician` join table (multi-technician rounds). Required steps for completion updated to 1–4, 6–11. `allRequiredComplete` now excludes step 12 (the launch step itself). |
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
| 201 | Created (step 9 POST — new property) |
| 400 | Bad body / missing-or-invalid field / invalid enum / unknown FK / `complete` called with required steps missing |
| 401 | No / invalid / expired token |
| 403 | Calling a mutating step **after** setup is already complete |
| 404 | Specified roundIds not found (step 11 when `generateAll: false`) |
| 409 | `POST /setup/complete` or step 11 when setup is **already** complete |
| 500 | Unexpected server error → `{ "error": "Internal Server Error" }` |

All errors (400/401/403/404/409) → `{ "error": "<message>" }`.

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
- **`CleaningFrequency`** (step 8 `frequency`, step 9 `cleaningFrequency`):
  `FORTNIGHTLY` · `FOUR_WEEKLY` · `SIX_WEEKLY` · `EIGHT_WEEKLY` · `MONTHLY`
- **`PaymentTiming`** (step 2 `paymentRule`):
  `COLLECT_AFTER_VISIT` · `COLLECT_BEFORE_VISIT` · `COLLECT_ON_DATE`
- **`PropertyType`** (step 9 `propertyType`, optional):
  `HOUSE` · `FLAT_APARTMENT` · `COMMERCIAL` · `OFFICE` · `CONSERVATORY`
- **`PaymentMethod`** (step 9 `paymentMethod`, optional):
  `GOCARDLESS` · `CASH` · `CHEQUE` · `BACS` · `STRIPE`
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
    { "step": 1,  "complete": true,  "deferred": false },
    { "step": 2,  "complete": false, "deferred": false },
    { "step": 3,  "complete": true,  "deferred": false },
    { "step": 4,  "complete": true,  "deferred": false },
    { "step": 5,  "complete": false, "deferred": true  },
    { "step": 6,  "complete": false, "deferred": false },
    { "step": 7,  "complete": false, "deferred": false },
    { "step": 8,  "complete": false, "deferred": false },
    { "step": 9,  "complete": false, "deferred": false },
    { "step": 10, "complete": false, "deferred": false },
    { "step": 11, "complete": false, "deferred": false },
    { "step": 12, "complete": false, "deferred": false }
  ]
}
```
→ First incomplete required step here is **2** — resume there.

**How to use this response:**
1. Ignore step 5 (always `deferred`, never blocks anything).
2. Find the **first required step** (1, 2, 3, 4, 6, 7, 8, 9, 10, 11) with
   `complete: false` → open the wizard there.
3. Use `setupCompleted` to decide whether to show the wizard at all — if
   `true`, route the user to the app / Settings instead.
4. Use `allRequiredComplete` to gate the **Complete** button (see §6).
   `allRequiredComplete` is true when steps 1–11 (excluding deferred step 5)
   are all complete. Step 12 is the launch step itself and is not counted.

**Completion rules** (server-computed, not client-computed):
| Step | Complete when |
|------|--------------|
| 1 | `businessName` is saved |
| 2 | `paymentRule` is saved |
| 3 | ≥1 Service exists |
| 4 | `defaultCycleLength` is saved |
| 5 | Deferred — never complete, never blocks |
| 6 | ≥1 Technician exists |
| 7 | ≥1 ServiceArea exists |
| 8 | ≥1 ACTIVE Round exists |
| 9 | ≥1 Property assigned to a round exists |
| 10 | Every ACTIVE round has ≥1 technician assigned (and ≥1 ACTIVE round exists) |
| 11 | ≥1 SCHEDULED Visit exists |
| 12 | `setupCompleted = true` (reflects state after `POST /setup/complete`) |

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

### Step 9 — Add Property
- **Path:** `GET /setup/step/9` · `POST /setup/step/9`
- **GET:** returns all properties added so far (`[]` if none), each as `{ customer, property, servicePlan }`.
- **POST semantics:** **Additive** — each POST creates one new Customer + Property + ServicePlan atomically. Call repeatedly to add multiple properties.
- **Re-edit safe:** N/A — step 9 is append-only during setup. To correct a mistake, remove via the main app after setup completes.
- **Does NOT reuse `/customers` or `/properties`** — this is a one-time setup endpoint; those general routes exist for post-setup operational use only.

**POST Request body** (`customerName`, `fullAddress`, `postcode`, `price`, `roundId` required):
```json
{
  "customerName": "Jane Smith",
  "propertyName": "The Old Mill",
  "phone": "+44 7700 900333",
  "email": "jane@example.com",
  "fullAddress": "12 Church Lane, Alnwick",
  "postcode": "NE66 1AA",
  "serviceAreaId": "clx...",
  "propertyType": "HOUSE",
  "price": 35,
  "cleaningFrequency": "FOUR_WEEKLY",
  "paymentMethod": "GOCARDLESS",
  "serviceId": "clx...",
  "accessNotes": "Side gate code: 1234",
  "riskNotes": "Steep roof pitch",
  "roundId": "clx..."
}
```

**Response 201:**
```json
{
  "customer": {
    "id": "clx...",
    "name": "Jane Smith",
    "phone": "+44 7700 900333",
    "email": "jane@example.com",
    "status": "ACTIVE",
    "paymentMethod": "GOCARDLESS",
    "badDebt": false,
    "createdAt": "2026-07-21T10:00:00.000Z",
    "updatedAt": "2026-07-21T10:00:00.000Z"
  },
  "property": {
    "id": "clx...",
    "customerId": "clx...",
    "propertyName": "The Old Mill",
    "addressLine": "12 Church Lane, Alnwick",
    "postcode": "NE66 1AA",
    "serviceAreaId": "clx...",
    "propertyType": "HOUSE",
    "accessNotes": "Side gate code: 1234",
    "riskNotes": "Steep roof pitch",
    "status": "ACTIVE",
    "roundId": "clx...",
    "createdAt": "2026-07-21T10:00:00.000Z",
    "updatedAt": "2026-07-21T10:00:00.000Z"
  },
  "servicePlan": {
    "id": "clx...",
    "propertyId": "clx...",
    "serviceId": "clx...",
    "price": "35",
    "cleaningFrequency": "FOUR_WEEKLY",
    "paymentMethod": "GOCARDLESS",
    "status": "ACTIVE",
    "createdAt": "2026-07-21T10:00:00.000Z",
    "updatedAt": "2026-07-21T10:00:00.000Z"
  }
}
```

**Errors:**
- `400` if any required field missing, enum invalid, `serviceAreaId` not found, or `roundId` references a non-ACTIVE round
- `403` if setup already complete

**Gotchas:**
- **`roundId` is required.** A property with no round cannot be scheduled and would leave step 9 incomplete. Round must be `ACTIVE` (from step 8).
- **`price` comes back as a string** on `servicePlan.price` (Decimal column).
- The `serviceId` links to a `Service` created in step 3 — optional but recommended so visits know what service was performed.
- `GET /setup/step/9` only returns properties that have an active service plan — properties created outside this endpoint (without a service plan) are not shown.

---

### Step 10 — Assign Technicians to Rounds
- **Path:** `GET /setup/step/10` · `POST /setup/step/10`
- **GET:** returns current assignment state across all ACTIVE rounds.
- **POST semantics:** **Replace** per round. For each round in the posted `assignments` array, the current technician set is replaced with the new one. Rounds not mentioned are not touched.
- **Re-edit safe:** Yes — re-posting the same round replaces its technician list. Sending `technicianIds: []` clears all assignments for that round.
- **Multi-technician:** a single round can have multiple technicians assigned.

**POST Request body** (`assignments` array required):
```json
{
  "assignments": [
    {
      "roundId": "clx...",
      "technicianIds": ["clx...", "clx..."]
    }
  ]
}
```

**GET and POST Response 200:**
```json
{
  "totalRounds": 1,
  "technicianCount": 2,
  "unassignedCount": 0,
  "assignments": [
    {
      "roundId": "clx...",
      "roundName": "Alnwick Monday",
      "defaultDay": "MON",
      "serviceAreaName": "Alnwick",
      "propertyCount": 3,
      "technicianIds": ["clx...", "clx..."],
      "technicians": [
        { "id": "clx...", "name": "James Fisher" },
        { "id": "clx...", "name": "Ade Cole" }
      ]
    }
  ],
  "workload": [
    { "technicianId": "clx...", "name": "James Fisher", "roundCount": 1 },
    { "technicianId": "clx...", "name": "Ade Cole",    "roundCount": 1 }
  ]
}
```

**Errors:**
- `400` if duplicate `roundId` in `assignments`, or any `roundId` not found / not ACTIVE, or any `technicianId` not found / inactive
- `403` if setup already complete

**Gotchas:**
- **Do not send the same `roundId` twice** in one request — the server rejects it with 400 to prevent silent data loss.
- Only **active** technicians (`active: true`) can be assigned — inactive/deleted technicians are rejected with 400.
- Technician IDs come from the `GET /setup/step/6` response (step 6's returned array).
- Round IDs come from the `GET /setup/step/8` response (step 8's returned array).

---

### Step 11 — Generate Visits & Activate
- **Path:** `GET /setup/step/11` · `POST /setup/step/11`
- **GET:** returns activation status: `{ activated: boolean, visitsGenerated: number }` where `activated` is `true` if any SCHEDULED visits exist.
- **POST semantics:** Generates SCHEDULED visits for all (or specified) ACTIVE rounds, for the first cycle window. **Does not lock the wizard** — that's `POST /setup/complete`.
- **Re-edit safe:** Technically re-callable (will append more visits), but designed to be called once. Do not call it more than once unless you've cleared generated visits.

**POST Request body** (`startDate` and `cycleWeeks` required):
```json
{
  "generateAll": true,
  "startDate": "2026-08-04",
  "cycleWeeks": 8
}
```
To generate for specific rounds only (`generateAll: false`):
```json
{
  "generateAll": false,
  "startDate": "2026-08-04",
  "cycleWeeks": 8,
  "roundIds": ["clx...", "clx..."]
}
```

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `generateAll` | boolean | No (default `true`) | If `true`, generates for all ACTIVE rounds |
| `startDate` | string (ISO date) | Yes | Must be today or in the future |
| `cycleWeeks` | integer 1–52 | Yes | Length of the first cycle in weeks |
| `roundIds` | string[] | Only when `generateAll: false` | ACTIVE round IDs to include |

**Response 200:**
```json
{ "visitsGenerated": 24 }
```

**Visit generation logic:**
For each property in each included round:
1. First visit date = next occurrence of the round's `defaultDay` on or after `startDate`.
   If the round has no `defaultDay`, uses `startDate` directly.
2. Subsequent visits spaced by the property's `cleaningFrequency` (from its `ServicePlan`).
3. Loop stops when the next visit date exceeds `startDate + cycleWeeks * 7 days`.
4. Properties with no active service plan are silently skipped.

**`MONTHLY` note:** Approximated as 4 weeks (28 days). Generates 13 visits/year
instead of 12. Calendar-month accuracy is a future milestone.

**Errors:**
- `400` if `startDate` missing/invalid, `startDate` is in the past, `cycleWeeks` out of range, `generateAll: false` with missing/empty `roundIds`
- `404` if `generateAll: false` and none of the specified `roundIds` were found
- `409` if setup is already complete (system already activated)
- `403` if setup already complete (same as 409 in this context — the 409 fires first)

**Gotcha — do not call this twice.** There is no built-in idempotency guard for
the visit-generation logic itself: calling it a second time before clearing
visits will append a second set of visits. Call it **once**, after all rounds
and technicians are configured. If you need to regenerate, clear existing
visits first via the operational visit-management endpoints (post-setup).

---

### Step 12 — Review & Launch (checklist, GET only)
- **Path:** `GET /setup/step/12`
- **No POST.** Step 12 is a read-only review screen. The launch action is `POST /setup/complete` (§6).

**GET Response 200:**
```json
{
  "checklist": [
    { "label": "Business profile completed",      "complete": true  },
    { "label": "Payment setup configured",         "complete": true  },
    { "label": "Service catalogue created",        "complete": true  },
    { "label": "Round settings saved",             "complete": true  },
    { "label": "Technicians added",                "complete": true  },
    { "label": "Service areas created",            "complete": true  },
    { "label": "Rounds configured",                "complete": true  },
    { "label": "Properties added",                 "complete": true  },
    { "label": "Technicians assigned to rounds",   "complete": true  },
    { "label": "Visits generated",                 "complete": true  }
  ],
  "allComplete": true
}
```
10 items (SMS templates step 5 is omitted — it's deferred).

**When `allComplete: true`** — enable the "Launch" / "Complete Setup" button and call `POST /setup/complete`.

---

## 6. Completion flow

**`POST /setup/complete`** (no request body) finalizes setup.

- **Checks:** every **required** step — **1, 2, 3, 4, 6, 7, 8, 9, 10, 11** — is complete.
  (Step 5 is deferred and never counts. Step 12 is the launch step itself and
  is excluded from the check.)
- **200 — success:** sets `setupCompleted = true`, returns the final status
  object (same shape as `GET /setup/status`, now with `setupCompleted: true`
  and `allRequiredComplete: true`). Wizard is now locked.
- **400 — required steps missing:**
  ```json
  { "error": "Setup cannot be completed — required steps incomplete: 2, 3, 4, 6, 7, 8, 9, 10, 11" }
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
`GET /setup/status` (or `allComplete` from `GET /setup/step/12`) so the user
only calls `/setup/complete` when it will succeed — but still handle
`400`/`409` defensively in code.

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
> - **Step 9 is ADDITIVE — each POST creates one property.** There is no
>   replace/delete on step 9 during setup; it is append-only.
>
> - **Step 10 replaces per-round, not globally.** Only rounds explicitly listed
>   in the `assignments` array are touched. Rounds omitted from the array keep
>   their existing technician assignments.
>
> - **Step 11 should be called only once.** It does not clear existing visits
>   before generating — re-calling it appends a duplicate set.
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
> - **Step 12 has no POST.** The launch action is `POST /setup/complete`, not
>   a step POST. Show the checklist from `GET /setup/step/12`; when
>   `allComplete: true`, enable the launch button.
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
# → capture service id from response for use in step 9

# 5. Round settings
curl "${AUTH[@]}" -X POST "$BASE/setup/step/4" -d '{"defaultCycleLength":28}'

# 6. Step 5 is deferred — show info screen, no data

# 7. Technicians (invite-pending — name is the admin's label until invite acceptance)
curl "${AUTH[@]}" -X POST "$BASE/setup/step/6" -d '[{"name":"James Fisher","role":"Senior","phone":"+44 7700 900111"}]'
# → capture technician id from response for use in step 10

# 8. Service areas — READ THE RESPONSE AND KEEP THE id(s)
curl "${AUTH[@]}" -X POST "$BASE/setup/step/7" -d '[{"name":"Alnwick","postcodeSector":"NE66","isDefault":true}]'
# → capture serviceArea id

# 9. First round — use a serviceAreaId captured from step 7's response
curl "${AUTH[@]}" -X POST "$BASE/setup/step/8" -d '{"name":"Alnwick Monday","defaultDay":"MON","frequency":"FOUR_WEEKLY","serviceAreaId":"<id from step 7>"}'
# → capture round id from response for steps 9 and 10

# 10. Add property (call once per property; append-only)
curl "${AUTH[@]}" -X POST "$BASE/setup/step/9" \
  -d '{"customerName":"Jane Smith","fullAddress":"12 Church Lane, Alnwick","postcode":"NE66 1AA","price":35,"cleaningFrequency":"FOUR_WEEKLY","propertyType":"HOUSE","roundId":"<id from step 8>","serviceId":"<id from step 3>"}'

# 11. Assign technicians to round(s)
curl "${AUTH[@]}" -X POST "$BASE/setup/step/10" \
  -d '{"assignments":[{"roundId":"<id from step 8>","technicianIds":["<id from step 6>"]}]}'

# 12. Generate visits for the first cycle (call only once)
curl "${AUTH[@]}" -X POST "$BASE/setup/step/11" \
  -d '{"generateAll":true,"startDate":"2026-08-04","cycleWeeks":8}'

# 13. Review checklist (optional — check allComplete before calling /complete)
curl "${AUTH[@]}" "$BASE/setup/step/12"

# 14. Complete — locks the wizard
curl "${AUTH[@]}" -X POST "$BASE/setup/complete"
```

At any point before step 14, the user can go **back** and re-POST most steps
to edit them — remembering the replace rules for 3/6/7 (send the full list
each time), that step 8 updates the existing round, and that steps 9 and 11
are append/one-shot respectively.

---

## 9. Quick-reference table

| Step | Path | Required? | POST semantics | Empty-array/omit risk |
|------|------|-----------|-----------------|------------------------|
| 1 | `/setup/step/1` | Yes | Upsert (partial ok, `businessName` always required) | N/A |
| 2 | `/setup/step/2` | Yes | Upsert (partial ok) | N/A |
| 3 | `/setup/step/3` | Yes | Full replace | Empty array wipes catalogue |
| 4 | `/setup/step/4` | Yes | Upsert (same record as step 1) | N/A |
| 5 | `/setup/step/5` | No — deferred | No-op | — |
| 6 | `/setup/step/6` | Yes | Replace invite-pending only | Omitted invite-pending techs deleted; accepted ones safe |
| 7 | `/setup/step/7` | Yes | Full replace | Empty array wipes all areas |
| 8 | `/setup/step/8` | Yes | Create-or-update | N/A — always safe to re-POST |
| 9 | `/setup/step/9` | Yes | Additive (one property per call) | N/A — append-only |
| 10 | `/setup/step/10` | Yes | Replace per-round (rounds not mentioned are untouched) | `technicianIds: []` clears a round's assignments |
| 11 | `/setup/step/11` | Yes | Generate visits (not idempotent — do not call twice) | Re-calling appends duplicate visits |
| 12 | `/setup/step/12` | GET only — no POST | — | — |

Required steps for completion: **1, 2, 3, 4, 6, 7, 8, 9, 10, 11**. Steps **5** (deferred)
and **12** (the launch step itself) never block completion.

---

*Cross-reference: `/docs` (Swagger UI) has the interactive, always-current
contract if anything here appears stale.*
