# RoundFlow — Round Planner: Frontend Handoff

> **Purpose:** everything needed to build the Round Planner screen — Calendar,
> Map and List views, the filter bar, the KPI strip, and the Quick Actions.
> Exact API contracts, response shapes, status codes, derivation rules for
> fields the backend does *not* return, and an explicit list of what is not
> supported yet.
>
> **Supersedes** §5 of `CUSTOMERS_PROPERTIES_ROUNDS_HANDOFF.md`, which covered
> only the two planner endpoints in isolation. That document remains correct
> for Customers (Screen 14) and Properties (Screen 15).

**Base URL (dev):** `http://localhost:3000`
**Content-Type:** `application/json` on all requests.
**Auth:** `Authorization: Bearer <supabase_access_token>` on every request.
**Role enforcement:** all `GET`s work for `ADMIN`, `MANAGER`, `TECHNICIAN`.
Mutations (`POST`, `PATCH`, `PUT`, `DELETE`) require `ADMIN` or `MANAGER` —
`TECHNICIAN` gets `403`.

**Last verified against:** commit `92d0220`.

---

## 1. Page anatomy → API map

| # | UI element | API | Notes |
|---|---|---|---|
| 1 | Round selector (`Alnwick ▾`) | `GET /rounds` | Returns all rounds. See §4.1 for "All rounds". |
| 2 | Period selector (`Week ▾`) | — | Client-side. Drives `from`/`to` on the calendar call. |
| 3 | `Cycle: 6 May – 2 June` | `GET /settings/round-settings` → `defaultCycleLength` (weeks) | Client computes the window. See §4.2. |
| 4 | Search box | `GET /customers?search=` | **Not** a planner filter. See §4.5. |
| 5 | Technician filter | — | Client-side, and only on List/Map. See §4.3. |
| 6 | Status filter | — | Client-side derivation. See §4.4. |
| 7 | KPI strip (6 tiles) | `GET /rounds/:id/planner/occurrences` | 5 of 6 map directly. See §5. |
| 8 | Calendar grid | `GET /rounds/:id/planner/occurrences?from=&to=` | §6 |
| 9 | List view | `GET /rounds/:id/planner/occurrences/:date` | §7 |
| 10 | Map view | same as List + client geocoding | §8 |
| 11 | Round card (`Alnwick Monday`, `5 stops · £940`) | occurrences + `GET /rounds/:id` | Technician name needs a second call — §6.3 |
| 12 | `+ Add Round` | `POST /rounds` | §9.1 |
| 13 | Quick Action — Add Property | `POST /properties` | §9.2 |
| 14 | Quick Action — Add One-off Job | `POST /visits` | §9.3 |
| 15 | Quick Action — Bulk Message | ❌ **no endpoint** | §10 |

---

## 2. Data model

```
Round (1) ──── (N) Property (1) ──── (N) Visit
  │                                     ├── status: SCHEDULED | IN_PROGRESS | COMPLETED | SKIPPED
  ├── frequency: CleaningFrequency      ├── paymentHold (bool)
  ├── defaultDay: DayOfWeek?            ├── price (Decimal)
  ├── status: ACTIVE|DRAFT|ARCHIVED     ├── isOneOff (bool)
  ├── serviceAreaId → ServiceArea       ├── technicianId → Technician
  └── (N) RoundTechnician → Technician  └── (N) Issue
```

**The planner reads `Visit` rows, not the round's schedule definition.** A round
with `defaultDay: MON` and `frequency: FOUR_WEEKLY` shows nothing in the planner
until Visit rows exist for it. Visits are created by:

- `POST /setup/step/11` — bulk generation during onboarding (one-time)
- `POST /visits` — a single one-off job (§9.3)

`POST /properties` does **not** create visits. A property added after onboarding
has no visits until one is created explicitly. This is the single most common
"why is the planner empty" cause.

**All dates are UTC midnight.** Visit dates are stored as `YYYY-MM-DDT00:00:00.000Z`
and returned as `YYYY-MM-DD`. Do not apply a local timezone offset when building
`from`/`to` — you will shift the bucket by a day.

---

## 3. Load sequence

On mount, in parallel:

```
GET /rounds                       → round selector, and the round list for "All rounds"
GET /settings/round-settings      → defaultCycleLength, currency
GET /technicians                  → technician filter dropdown
```

Then, once a round and a date window are known:

```
GET /rounds/:id/planner/occurrences?from=<start>&to=<end>
```

Calendar renders from that one response. List and Map views each need a second
call for the selected day (§7).

---

## 4. Filters and controls

### 4.1 Round selector — and the "All rounds" problem

`GET /rounds` returns every round:

```json
[
  {
    "id": "clf...",
    "name": "Alnwick Monday",
    "frequency": "FOUR_WEEKLY",
    "defaultDay": "MON",
    "status": "ACTIVE",
    "serviceAreaId": "csa...",
    "serviceAreaName": "Alnwick",
    "technicianCount": 1,
    "propertyCount": 5
  }
]
```

Optional `?status=ACTIVE|DRAFT|ARCHIVED` filters by round **lifecycle** status.

> ⚠️ **The planner endpoints are per-round.** There is no cross-round planner
> endpoint. To render "All rounds" (multiple round cards in one calendar, as in
> the earlier mockup), fan out one `occurrences` call per round and merge by
> date client-side. With a typical 3–10 rounds this is acceptable; if it grows,
> raise it as a backend ask rather than paginating around it.

### 4.2 Period selector and the cycle header

`GET /settings/round-settings` returns the full `BusinessSettings` record;
`defaultCycleLength` is the cycle length **in weeks** (nullable).

Compute the window client-side and pass it as `from`/`to`:

| Period | Window |
|---|---|
| Week | Mon–Sun of the selected week |
| Cycle | `cycleStart` → `cycleStart + defaultCycleLength weeks - 1 day` |

`Cycle: 6 May – 2 June` in the header is a client-side label, not an API field.
There is no stored "current cycle start" — derive it from the earliest
occurrence date or let the user pick.

> **Max range is 90 days.** A range longer than that returns `400`. A 12-week
> cycle (84 days) fits; a 13-week one does not.

### 4.3 Technician filter

There is no `technicianId` query param on any planner endpoint.

- **List / Map view:** filter client-side — each stop carries `technicianId` and `technicianName`.
- **Calendar view:** ⚠️ **not possible.** The occurrence summary carries no technician data at all (§6.1). Either disable the technician filter while Calendar is active, or fetch the day view for every occurrence date to enrich — which is N extra calls and not recommended.

Populate the dropdown from `GET /technicians`, which returns `appStatus` per
technician (`ACTIVE` | `INACTIVE` | `PENDING_INVITE`).

### 4.4 Status filter

Two different things are called "status" — do not conflate them:

| Meaning | Source | Values |
|---|---|---|
| Round lifecycle | `GET /rounds` → `status` | `ACTIVE` `DRAFT` `ARCHIVED` |
| Day progress (the `In-progress` / `Completed` label on a card) | **derived** | see below |

The card label is not returned by any endpoint. Derive it from the occurrence
summary, mirroring the backend's own rule in `today.service.ts`:

```
stopCount === 0                       → "not_started"
completedCount === stopCount          → "completed"
completedCount > 0                    → "in_progress"
otherwise                             → "not_started"
```

The occurrence summary has no `skipped` or `inProgress` count, so a day whose
stops are all `SKIPPED` reads as `not_started`. Accept that, or use the day view
(§7), whose `stops[].status` carries the real per-visit status.

### 4.5 Search

No planner endpoint accepts a search term. Two options:

1. **Client-side (recommended for List/Map):** filter the loaded `stops[]` on `addressLine`, `postcode`, `customerName`, `propertyName`.
2. **Server-side (for a global jump-to):** `GET /customers?search=<term>` does a case-insensitive contains on `customerName` / `addressLine` / `postcode` and returns `propertyId` + `roundId` + `nextDueDate` — enough to navigate the planner to the right round and date.

Calendar view cannot be searched — occurrence buckets carry no property data.

---

## 5. KPI strip

Five of the six tiles come straight from the occurrence data. Sum across every
occurrence in the visible window:

| Tile | Source |
|---|---|
| `TOTAL STOPS` | `Σ stopCount` |
| `ROUND VALUE` | `Σ totalValue` — format with `currency` from round-settings |
| `COMPLETION` | `Σ completedCount / Σ stopCount × 100`, rounded |
| `PAYMENT HOLDS` | `Σ holdCount` |
| `ISSUES` | `Σ issueCount` |
| `ESTIMATED DURATION` | ❌ **not available** — see below |

> ⚠️ **`ESTIMATED DURATION` has no backing data.** There is no duration field
> anywhere in the tenant schema — not on `Visit`, `Service`, or `Property`.
>
> The only precedent is `etaMinutes` on `GET /today`, which is the hardcoded
> heuristic `remaining stops × 20 minutes`. To ship the tile, apply the same
> rule client-side (`Σ stopCount × 20 min`) and label it clearly as an estimate.
> A real per-service duration needs a schema change — raise it as a backend ask.

Do **not** recompute `completionPct` by averaging the per-day `completionPct`
values — that weights a 1-stop day the same as a 20-stop day. Sum the raw counts.

---

## 6. Calendar view

### 6.1 `GET /rounds/:id/planner/occurrences`

Returns one entry per **visit-date bucket**, not per visit.

```
GET /rounds/clf.../planner/occurrences?from=2026-05-06&to=2026-06-02
```

```json
[
  {
    "date": "2026-05-06",
    "stopCount": 5,
    "totalValue": 940,
    "completedCount": 3,
    "completionPct": 60,
    "holdCount": 1,
    "issueCount": 0
  },
  {
    "date": "2026-05-07",
    "stopCount": 5,
    "totalValue": 940,
    "completedCount": 5,
    "completionPct": 100,
    "holdCount": 0,
    "issueCount": 0
  }
]
```

**Rules:**
- `from` / `to` must be `YYYY-MM-DD`. A malformed value returns `400`.
- **At least one of `from` / `to` is required** — omitting both returns `400`.
- `from > to` returns `400`.
- Range > **90 days** returns `400`.
- Returns `[]` (not `404`) when the round has no visits in the range.
- `404` if the round does not exist.
- `to` is **inclusive** of that day.
- Dates with no visits are simply absent from the array — render those cells as `No rounds`.

### 6.2 Rendering the grid

The response is a sparse list of dates. Build the calendar skeleton client-side
from the `from`/`to` window and look up each cell by date string. Dates with no
matching entry render the empty state.

### 6.3 The round card — what's missing

The card shows `Alnwick Monday · 5 stops · £940 · James · In-progress`:

| Card field | Available? |
|---|---|
| Round name | ✅ from `GET /rounds` (you already have it — the occurrence response has no round name) |
| `5 stops` | ✅ `stopCount` |
| `£940` | ✅ `totalValue` |
| `In-progress` | ⚠️ derive per §4.4 |
| `James` | ❌ **not in the occurrence response** |

For the technician name, either:

- **Round-level (1 extra call, recommended):** `GET /rounds/:id` returns `technicians[]` with `{ id, name, active }`. Show the round's assigned technician. Correct in the common case of one technician per round.
- **Day-accurate (N extra calls):** `GET /rounds/:id/planner/occurrences/:date` → `stops[].technicianName`. Only worth it if technicians genuinely vary per day.

The status **dot** colour on the card maps to the same derived status as the label.

---

## 7. List view

### 7.1 `GET /rounds/:id/planner/occurrences/:date`

All stops for one date. Backs both List and Map.

```
GET /rounds/clf.../planner/occurrences/2026-05-06
```

```json
{
  "roundId": "clf...",
  "roundName": "Alnwick Monday",
  "date": "2026-05-06",
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
      "completedAt": "2026-05-06T09:45:00.000Z"
    }
  ],
  "summary": {
    "stopCount": 5,
    "totalValue": 940,
    "completedCount": 3,
    "completionPct": 60,
    "holdCount": 1,
    "issueCount": 0
  }
}
```

**Rules:**
- `:date` must be `YYYY-MM-DD` — otherwise `400`.
- `404` if the round does not exist.
- No visits that day → `{ stops: [], summary: { stopCount: 0, ... } }`, **not** `404`.
- `stops` are ordered by `addressLine` ascending — this is the intended route order.
- `completedAt` is a full ISO timestamp, or `null`.
- `issues` is an array (possibly empty), not a count. `summary.issueCount` is the total number of issue records across all stops, not the number of stops that have issues. (`GET /today` uses the opposite convention — do not copy KPI logic between the two screens.)

### 7.2 Badges

| Badge | Condition |
|---|---|
| Payment hold | `paymentHold === true` |
| Issue | `issues.length > 0` — use `issues[0].note` for the tooltip |
| One-off | ❌ `isOneOff` is **not** returned on planner stops (§10) |

---

## 8. Map view

Same endpoint as List (§7.1) — the stop list *is* the map data.

> ⚠️ **No coordinates.** `Property` has no `latitude` / `longitude` column, and
> no stop field carries one. `addressLine` + `postcode` are all you get.
>
> Geocode client-side (UK postcodes are precise enough for pin placement) and
> cache aggressively — the same properties recur on every occurrence. Route
> ordering is already handled: `stops` come back sorted by `addressLine`, and
> there is no route-optimisation endpoint.

---

## 9. Actions

### 9.1 `+ Add Round`

```
POST /rounds
{
  "name": "Alnwick Monday",
  "frequency": "FOUR_WEEKLY",
  "serviceAreaId": "csa...",
  "defaultDay": "MON",
  "description": null
}
→ 201 RoundDetail
```

- `name`, `frequency`, `serviceAreaId` required.
- Populate the service-area dropdown from `GET /settings/service-areas`.
- `frequency` uses the **new** enum — see §11. `FORTNIGHTLY` and `MONTHLY` now return `400`.
- Assign technicians afterwards with `PUT /rounds/:id/technicians` (replace-all — send the full desired list; `[]` clears everyone).

> ⚠️ **A new round shows nothing in the planner.** Creating a round creates no
> visits. Until properties are assigned to it *and* visits exist, every calendar
> cell reads `No rounds`.

> ⚠️ **Pending-invite technicians are rejected.** `PUT /rounds/:id/technicians`
> returns `400 "Cannot assign technician(s) with a pending invite: <ids>"`.
> Filter the dropdown to `appStatus !== "PENDING_INVITE"` using `GET /technicians`.

### 9.2 Quick Action — Add Property

`POST /properties` — atomic Customer + Property + ServicePlan. Full contract in
`CUSTOMERS_PROPERTIES_ROUNDS_HANDOFF.md` §3. Pass `roundId` to assign it to the
currently-selected round, or `null` for Save & Assign Later.

After a successful create, refetch `GET /rounds` (the `propertyCount` changes),
but note the planner itself will not change — no visits are created.

### 9.3 Quick Action — Add One-off Job

```
POST /visits
{
  "propertyId": "cle...",
  "date": "2026-05-13",
  "price": 45.00,
  "serviceId": "csv...",
  "technicianId": "ctn...",
  "roundId": "clf...",
  "notes": "One-off gutter clean",
  "paymentMethod": "CASH"
}
→ 201 VisitDetail
```

Full field table in `2026-08-25-backend-changes.md` §4.

> **Pass `roundId` if you want it to appear in the Round Planner.** A one-off
> created with `roundId: null` is only visible in `GET /today` on its date — the
> planner filters by `roundId`. Default to the currently-selected round.

After success, refetch the occurrences call for the visible window.

Property picker: `GET /customers?search=` → `propertyId`.
Service/price defaults: `GET /settings/services` → `defaultPrice`.
Technician dropdown: `GET /technicians`, filtered to `appStatus !== "PENDING_INVITE"` — a pending technician returns `400 "Technician has not accepted their invite"`.

### 9.4 Round card click-through

| Action | API |
|---|---|
| Open round detail | `GET /rounds/:id` |
| Edit round | `PATCH /rounds/:id` (partial: `name`, `frequency`, `serviceAreaId`, `defaultDay`, `description`, `status`) |
| Reassign technicians | `PUT /rounds/:id/technicians` |
| Today's panel for this round | `GET /rounds/:id/today` — see `TODAY_HANDOFF.md` §4 |
| Push a day's jobs to a new date | `POST /rounds/:id/push-missed` — **today's SCHEDULED visits only**, see `TODAY_HANDOFF.md` §5 |

---

## 10. Not supported — do not build against these

| UI element | Status |
|---|---|
| Cross-round ("All rounds") planner endpoint | ❌ Fan out per round client-side (§4.1) |
| `ESTIMATED DURATION` | ❌ No duration field in the schema. Use `stopCount × 20 min` as an explicit estimate (§5) |
| Server-side search on the planner | ❌ Client-side, or `GET /customers?search=` (§4.5) |
| Server-side technician filter | ❌ Client-side, List/Map only (§4.3) |
| Map coordinates / route optimisation | ❌ Geocode client-side (§8) |
| One-off badge on a planner stop | ❌ `PlannerStop` does not include `isOneOff` |
| Drag-to-reschedule a visit | ❌ No `PATCH /visits/:id`. Only `POST /rounds/:id/push-missed`, and only for today |
| Delete / cancel a single visit | ❌ No endpoint |
| Bulk Message quick action | ❌ No endpoint. `POST /debt/:id/remind` is invoice-keyed, single-recipient, and only writes a `Message` row — it does not send |
| Live updates | ❌ No websockets or SSE. Poll |

---

## 11. Enum reference

| Enum | Values |
|---|---|
| `CleaningFrequency` | `FOUR_WEEKLY` `SIX_WEEKLY` `EIGHT_WEEKLY` `TWELVE_WEEKLY` |
| `RoundStatus` | `ACTIVE` `DRAFT` `ARCHIVED` |
| `DayOfWeek` | `MON` `TUE` `WED` `THU` `FRI` `SAT` `SUN` |
| `VisitStatus` | `SCHEDULED` `IN_PROGRESS` `COMPLETED` `SKIPPED` |
| `PaymentMethod` | `GOCARDLESS` `STRIPE` `CASH` `BACS` `CHEQUE` |
| `AppStatus` (technicians) | `ACTIVE` `INACTIVE` `PENDING_INVITE` |
| `IssueType` | `ACCESS` `DAMAGE` `COMPLAINT` … (see Swagger) |

> ⚠️ `FORTNIGHTLY` and `MONTHLY` were **removed**. Sending either returns `400`.
> Display labels: `4 Weekly`, `6 Weekly`, `8 Weekly`, `12 Weekly`.

---

## 12. Critical rules

> **Money fields are numbers.** `price`, `totalValue` on planner responses are
> already numbers — do not parse. (The Settings service returns `defaultPrice`
> as a *string*; it is the exception.)
>
> **The planner requires at least one date bound.** No `from` and no `to` → `400`.
> Max range 90 days.
>
> **Dates are UTC.** Build `from`/`to` from UTC dates. Applying a local offset
> shifts every bucket.
>
> **`summary.issueCount` counts issue records, not stops with issues.**
> `GET /today`'s `kpi.issues` counts stops. Different conventions; do not share
> KPI code between the two screens.
>
> **Empty is `[]` / `stops: []`, never `404`.** A `404` from a planner endpoint
> always means the *round id* is wrong.
>
> **Creating a round or a property does not create visits.** Only
> `POST /setup/step/11` and `POST /visits` do.
>
> **`PUT /rounds/:id/technicians` is replace-all** and rejects pending-invite
> technicians with `400`.

---

## 13. Quick reference

| Operation | Method | Path | Auth | Notes |
|---|---|---|---|---|
| List rounds | GET | `/rounds` | Any | `?status=` optional |
| Create round | POST | `/rounds` | ADMIN/MANAGER | `name`, `frequency`, `serviceAreaId` |
| Round detail | GET | `/rounds/:id` | Any | Includes `technicians[]` |
| Update round | PATCH | `/rounds/:id` | ADMIN/MANAGER | Partial |
| Set technicians | PUT | `/rounds/:id/technicians` | ADMIN/MANAGER | Replace-all; 400 on pending invite |
| Planner — calendar | GET | `/rounds/:id/planner/occurrences` | Any | `from`/`to` req'd; max 90 days |
| Planner — day (List/Map) | GET | `/rounds/:id/planner/occurrences/:date` | Any | `YYYY-MM-DD` |
| Round today panel | GET | `/rounds/:id/today` | Any | |
| Push missed | POST | `/rounds/:id/push-missed` | ADMIN/MANAGER | Today's SCHEDULED only |
| Reassign technician | POST | `/rounds/:id/reassign` | ADMIN/MANAGER | Today only |
| One-off job | POST | `/visits` | ADMIN/MANAGER | Pass `roundId` for planner visibility |
| Add property | POST | `/properties` | ADMIN/MANAGER | |
| Service areas | GET | `/settings/service-areas` | Any | Add Round dropdown |
| Services | GET | `/settings/services` | Any | One-off price defaults |
| Round settings | GET | `/settings/round-settings` | Any | `defaultCycleLength`, `currency` |
| Technicians | GET | `/technicians` | ADMIN/MANAGER | `appStatus` for filtering |

---

## 14. curl recipes

```bash
BASE=http://localhost:3000
AUTH=(-H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json")

# Round selector
curl "${AUTH[@]}" "$BASE/rounds"

# Calendar — 6 May to 2 June cycle
curl "${AUTH[@]}" "$BASE/rounds/$ROUND_ID/planner/occurrences?from=2026-05-06&to=2026-06-02"

# List / Map — stops for one day
curl "${AUTH[@]}" "$BASE/rounds/$ROUND_ID/planner/occurrences/2026-05-06"

# Add Round
curl "${AUTH[@]}" -X POST "$BASE/rounds" \
  -d '{"name":"Alnwick Monday","frequency":"FOUR_WEEKLY","serviceAreaId":"'"$AREA_ID"'","defaultDay":"MON"}'

# Add One-off Job, visible in this round's planner
curl "${AUTH[@]}" -X POST "$BASE/visits" \
  -d '{"propertyId":"'"$PROP_ID"'","date":"2026-05-13","price":45,"roundId":"'"$ROUND_ID"'"}'
```

---

*Cross-reference: `docs/designFindings.md` for visual/field specs;
`CUSTOMERS_PROPERTIES_ROUNDS_HANDOFF.md` for Customers/Properties;
`TODAY_HANDOFF.md` for Today's Work and day-management actions;
`2026-08-25-backend-changes.md` for the latest breaking changes.
Live Swagger: `/docs`.*
