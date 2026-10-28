# Property Geocoding (Latitude/Longitude) — Frontend Handoff

**Date:** 2026-10-29
**Audience:** frontend developer building the Round Planner Map view, the Dashboard "today's stops" map, or any screen with a "navigate to this property" action.

**Short version:** every endpoint that already returns a property's
`addressLine`/`postcode` now also returns `latitude`/`longitude`
(`number | null`). No request shape changed, no new field to send, no maps
API key needed on your side — coordinates are computed backend-side from the
postcode.

---

## What's new

Every one of these endpoints now includes `latitude: number | null` and
`longitude: number | null` on the relevant object:

| Endpoint | Where to find the new fields |
|---|---|
| `PATCH /properties/:id` | Top level of the response |
| `GET /customers` | Each `CustomerListRow` |
| `GET /customers/:id` | `property` and `tabs.overview` |
| `GET /rounds/:id/planner/occurrences/:date` (+ batched multi-round variant) | Each `PlannerStop` in `stops[]` — **this is the Round Planner's Map view data** (per `ROUND_PLANNER_HANDOFF.md` §8, you no longer need to geocode client-side) |
| `GET /rounds/:id/today` | Each `TodayPanelStop` in `stops[]` |
| `POST /visits` | Top level of the response |
| `GET /mobile/rounds/today`, `/mobile/visits/today`, `/mobile/completions` | Each row |
| `GET /mobile/visits/:id` | The property block — this is the technician app's job-detail screen, the natural place for a "navigate here" button |

Nowhere else changed shape. In particular: `POST /properties`,
`POST /customers/:id/properties`, and `PATCH /customers/:id` still don't echo
address fields in their response at all (same as before) — if you need a
freshly-created/edited property's coordinates, re-fetch it via
`GET /customers/:id` or `GET /customers`.

## The one thing to design around: `null` is normal, not an error

Coordinates are geocoded **after** the write, not during it:

- On a brand-new property or a postcode change, `latitude`/`longitude` are
  `null` in the very next response, and stay `null` until the backend's
  backfill job picks them up — **currently every 15 minutes**, so worst case
  is about a 15-minute gap, not instant.
- A small number of postcodes may never resolve (typo, a postcode not in the
  Royal Mail dataset the geocoding provider uses) and will stay `null`
  indefinitely after a few retries.

So: **treat `null` as "no pin yet," not as a bug**, and build the map/list
view to skip or placeholder those rows rather than erroring. Don't poll
aggressively waiting for it to populate — a normal page refresh a few
minutes later is enough.

## What this unblocks

- **Round Planner Map view** (`ROUND_PLANNER_HANDOFF.md` §8, §10) — the "No
  coordinates — geocode client-side" note there is now out of date for this
  endpoint; the same `GET /rounds/:id/planner/occurrences/:date` call you're
  already making for the List view now carries map-ready coordinates too.
- **A "navigate to this job" action** on the mobile technician app's job
  detail screen (`GET /mobile/visits/:id`) — hand `latitude`/`longitude`
  straight to a native maps deep link (e.g. `https://maps.google.com/?q=lat,lng`
  or the platform's map-app URI scheme) when both are non-null; fall back to
  an address-text link when either is `null`.
- **Dashboard "today's stops" map** (`FRONTEND_WIRING_AUDIT_RESPONSE_2026-10-22.md`
  Part C item 1) — the data gap that ticket was blocked on is closed. Note
  there's still no backend endpoint backing the Dashboard's GPS map
  component itself (it's a frontend-only placeholder today) — building that
  screen is a separate task, but it can now be built using
  `GET /rounds/:id/today`'s `TodayPanelStop.latitude`/`longitude` rather than
  being blocked on a schema gap.

## What did not change

- No new request fields, no new form inputs, no maps API key configuration
  needed anywhere on the frontend.
- No existing field was removed or renamed on any of the endpoints above —
  this is a strictly additive change.
- Everything not listed in the table above (reports/CSV export, the debt
  board, invoices, complaint detail) is unchanged — those only ever
  displayed the address as text and still do.
