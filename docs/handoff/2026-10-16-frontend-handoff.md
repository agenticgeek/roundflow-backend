# Backend Performance Work — Frontend Handoff

**Date:** 2026-10-16
**Audience:** frontend developer / frontend repo owner (the backend repo isn't where the client lives, so this doc is self-contained — copy or forward it as needed)

This covers a batch of backend performance fixes. Most of it needs **no action from you**. One piece is an additive endpoint you should migrate to when convenient.

---

## Action required — new batch endpoint for the Round Planner / Dashboard

This is the fix for the fan-out problem (one API call per round). It's additive — your existing code keeps working, but you should migrate off the old pattern to actually get rid of the fan-out.

**New endpoint:**
```
GET /rounds/planner/occurrences?roundIds=a,b,c&from=YYYY-MM-DD&to=YYYY-MM-DD
```

- `roundIds` — comma-separated round IDs, required, max 50.
- `from` / `to` — `YYYY-MM-DD`, at least one required, same validation as the existing single-round endpoint (max 90-day range).

**Response (200):**
```ts
{ roundId: string; occurrences: OccurrenceSummary[] }[]
```
where `OccurrenceSummary` is the exact same shape the old endpoint already returns:
```ts
{
  date: string;          // "YYYY-MM-DD", UTC
  stopCount: number;
  totalValue: number;
  completedCount: number;
  completionPct: number; // 0–100, rounded
  holdCount: number;
  issueCount: number;
}
```
One entry per round you asked for, **in the order you sent them**, even if a round has zero visits in range (you get `occurrences: []` for it, not a missing entry or a 404).

**Before/after:**
```ts
// BEFORE — N calls, one per round
const results = await Promise.all(
  roundIds.map((id) =>
    fetch(`/rounds/${id}/planner/occurrences?from=${from}&to=${to}`).then((r) => r.json())
  )
); // results[i] is OccurrenceSummary[] for roundIds[i]

// AFTER — 1 call
const batch = await fetch(
  `/rounds/planner/occurrences?roundIds=${roundIds.join(",")}&from=${from}&to=${to}`
).then((r) => r.json());
const byRound = new Map(batch.map((b) => [b.roundId, b.occurrences]));
```

The old endpoint (`GET /rounds/:id/planner/occurrences`) still works, no deadline to move off it — but the fan-out only actually disappears once you swap the loop above for the single call.

---

## Action required — Debt board response shape changed (pagination)

`GET /debt/board` used to return a bare array of rows. It now supports pagination and returns:
```ts
{
  rows: BoardRow[];               // same row shape as before
  pagination: {
    page: number;
    pageSize: number;             // default 50, max 100
    total: number;
    totalPages: number;
  };
}
```
New optional query params: `page`, `pageSize`. If you were doing `const rows = await fetch('/debt/board?...').then(r => r.json())` and using `rows` as an array directly, you need to change that to `const { rows, pagination } = await ...`. If you want to add pagination controls to the debt board UI, `pagination.totalPages`/`pagination.total` are there for that — otherwise just destructure `rows` and ignore `pagination` for now (you'll currently only see the first 50 overdue invoices per bucket by default, where before you saw all of them — worth checking if any bucket in your test data has more than 50 rows and deciding if you want pagination UI now or later).

---

## No action required — everything else got faster internally

These changed only on the backend (query execution, not the response contract). Nothing to change in your code, but useful to know what sped up in case you're asked about it or notice a latency change:

- **Customers list** (`GET /customers`), including the "On Hold" filter — no longer fetches the whole customer table and filters/paginates in memory.
- **Customer detail** (`GET /customers/:id`) — visit history is now capped and ordered at the database level instead of being fetched in full and sliced.
- **Dashboard KPIs/charts/technician stats** — now computed with database aggregation instead of loading every row into the Node process and summing in JavaScript.
- **Database indexes** — several new indexes on `Customer`, `Visit`, `Invoice`, `Payment`, `Complaint` that speed up filtering/sorting across most list and dashboard views.
- **Business settings caching** — a per-tenant setting that's read on nearly every customer/invoice/today's-work request is now cached briefly (~30s) instead of hit on every single request.

---

## What to verify after this deploys

Nothing here should *look* different — if it does, that's a regression, report it, don't assume it's intentional:

- [ ] Customers list, all status filters including **On Hold**, multiple pages
- [ ] Customer detail page — Visit History tab and Payments tab (for a customer with many past visits, confirm the most recent ~50 show up correctly, newest first)
- [ ] Round Planner / Dashboard (once you've migrated to the new batch endpoint)
- [ ] Debt board — **after updating your code for the new `{ rows, pagination }` response shape**
- [ ] Main Dashboard — KPI tiles, the revenue/issues chart, technician performance stats

---

## Rollout order / timing

- The database index migration should land in staging/prod **before or alongside** everything else — it's what the other fixes' performance improvement actually depends on.
- The debt board response-shape change is a **breaking change for your client code** — coordinate the deploy so your frontend update ships at the same time as (or after) the backend change, not before.
- The new planner batch endpoint has no deadline — migrate whenever convenient, the old one keeps working.
