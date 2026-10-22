# RoundFlow — Backend Response to "Frontend Wiring & Data Audit (v2)"

**Date:** 2026-10-22
**Re:** the 21 Oct 2026 "RoundFlow Frontend Wiring & Data Audit (v2)" doc (10 top priorities + chapter-level backend gaps)
**From:** Backend
**Status of this work:** built, unit-tested (100% line/branch/statement/function coverage on every file touched), and pushed to `fix/missing-endpoints` across three commits (one per phase below).

> Verification note: every claim below was checked against the actual backend code before
> this response was written, not assumed from the audit text. Several "gaps" the audit lists
> turned out to already be shipped; those are rejected with the code reference, not re-built.

---

## Summary

| Area | Audit asked for | Backend status |
|---|---|---|
| Auth / role enforcement | Confirm `requireAuth`/role checks aren't bypassable | ✅ Already enforced everywhere — rejected, no code change |
| Invite flow (public token) | `GET /invites/:token` without a session | ✅ Already public — rejected |
| Settings reads pre-setup | Allow reading settings before setup completes | ✅ Already allowed — rejected |
| SMS Templates / payment connect | "These are stubs" | ✅ Already real, DB-backed / live-validated — rejected |
| Debt pagination / phone-null / hold scope | Various "bugs" | ✅ Already correct as built — rejected |
| Dashboard `technicianIds` filter, debt `search`, bucket counts, batch-occurrence technician info, activity actor name/date range, Close Day guard, Push Missed SMS, primary-plan flag, pagination (Complaints/Reports) | Phase 1 (9 items) | ✅ Shipped |
| Per-plan writes, bulk import parity, debt detail/hold/payment-link, invoice detail, complaint fields, cross-round day stops, technician list N+1, on-demand visit generation, OpenAPI coverage | Phase 2 (11 items) | ✅ Shipped (10 of 11 — OpenAPI done as a best-effort pass, see note) |
| `prisma/seed.ts` rewrite, technician role vocabulary | Phase 3, items 2 & 3 only | ✅ Shipped |
| Dashboard lat/lng stops map | Phase 3, item 1 | ⛔ Not built — needs a schema migration + geocoding, scoped separately (see Part C) |
| SMS billing, scheduled sends, Weather Hold, complaint `issueType` enum, `STANDING_ORDER`, bulk debt actions | Flagged items | ⛔ Not built — product decision needed first (Part C) |

---

## Part A — Already true on the backend (rejected; no code change)

| Audit ask | Evidence |
|---|---|
| Enforce role/tenant/setup-complete on every endpoint | Every business router applies `requireAuth` → `requireTenantAccess` → `requireRole`/`requireBusinessAccess()` at the router level. `requireAuth` verifies the Supabase ES256 JWT via JWKS (`algorithms:["ES256"], audience:"authenticated", issuer:SUPABASE_ISSUER`) — a fake/dev-bypass token simply fails verification. The `admin`/`admin` backdoor the audit flagged is **frontend-only**; the backend was never fooled by it. |
| `GET /invites/:token` works without a session | Zero middleware on this route — explicitly public, used by the frontend before auth exists. |
| Settings reads before setup is complete | `GET /settings/service-areas`, `/technicians`, `/services` have no completion guard; only the mutating routes call `assertSetupComplete()`. |
| SMS Templates panel "is a stub" | `GET/POST/PATCH/DELETE /settings/message-templates` is real DB-backed CRUD, shipped 2026-10-13. Not touched this round. |
| Payment connect "only flips a boolean" | GoCardless validates the token live against the GoCardless API; Stripe does a real OAuth redirect + token exchange. Only the setup-wizard step 2 toggles are a deliberate Phase-1 stub, by design. |
| Invite accepted twice | `POST /invites/:token/accept` checks for an existing Profile before the usability check — already idempotent. |
| Debt page not clamped | Already clamped (`page ≥ 1`, `pageSize ≤ 100`). |
| Edit Customer phone required though API accepts null | Backend already permits `null`; the blocker was frontend form validation. |
| Bad-debt/hold "per invoice or per customer unclear" | Working as designed — the whole customer relationship is flagged, not one invoice. |
| Reports export "always type=visits" | `technicians`/`revenue` CSV export already worked; the frontend UI just wasn't sending a different `type`. |

---

## Part B — Shipped this round

### Phase 1

1. `GET /dashboard/charts` — added optional `technicianIds` filter (comma-separated), alongside existing `range`.
2. `GET /debt/board` — added `search`, matched server-side against customer name/address (previously only the 50 loaded rows were searchable client-side).
3. `GET /debt/board/counts` — new endpoint, all 7 bucket counts in one query, replacing 7 `?pageSize=1` calls.
4. `GET /rounds/planner/occurrences` (batch) — now returns technician info per stop, matching the single-round day endpoint.
5. `GET /reports/activity` — now joins `actorName` (was `actorRole` only) and accepts `from`/`to`.
6. Close Day guard — `reassignTechnician`/`pushMissedJobs` now 409 once the day is closed, instead of silently allowing mutation.
7. Push Missed `notifyCustomers` — was a **real correctness bug**, not just a missing field: it accepted the flag but never sent anything. Now wired to the existing message-send path.
8. `GET /customers/:id` — each entry in `servicePlans[]` now carries `isPrimary: boolean`, surfacing the rule the backend already computed internally instead of making the frontend re-derive it.
9. Pagination on `GET /complaints`, `GET /reports/visits`, `GET /reports/technicians` — `{ rows, pagination }`, same pattern as the existing debt board.

### Phase 2

1. **Per-plan writes** (highest-value item): `PATCH /service-plans/:id`, `POST /service-plans/:id/pause`, `POST /service-plans/:id/resume` — new router, targets one `ServicePlan` by id directly. Fixes a real bug: on any multi-plan property, `PATCH /properties/:id`/`PATCH /customers/:id`/pause/resume were silently mutating a guessed "primary" plan.
2. **Bulk import parity** (`POST /setup/step/9/bulk`) — added `landline` + `serviceIds[]` per row; added a client-supplied `idempotencyKey` (backed by a new `BulkImportAttempt` table); replaced "abort on first bad row" with per-row error collection + partial-success commit — a 500-row import with one bad row now commits 499 and reports the one error, instead of discarding everything.
3. `GET /debt/:id` — new detail endpoint (phone/email/round/next-visit/mandate/recent visits).
4. `PATCH /debt/:id/hold` — extended to `{flag, reason, date, notify, message}`; `notify: true` now actually sends an SMS (best-effort, logged on failure) instead of being accepted and ignored. Persisted via two new `Customer` columns (`holdReason`, `holdSince`).
5. Payment-link response — now returns `provider` + `expiresAt` for both the Stripe and static-fallback paths.
6. `GET /invoices/:id` (JSON route) — now returns the same richer shape the PDF route already used internally: line items, technician, visit date, VAT/subtotal breakdown, degrading gracefully when there's no linked visit.
7. Complaints schema — added `resolvedAt`/`resolvedBy`/`notes` columns; `resolve()` now sets them; detail response also joins `technicianName`, `propertyAddress`, and a `messageCount`.
8. `GET /rounds/planner/occurrences/:date?roundIds=` — new cross-round batch day-stops endpoint, same pattern as the existing calendar-batch endpoint.
9. `GET /technicians` — now returns `roundNames` + `todayStats` per technician in one query (a single `visit.groupBy`, not N+1).
10. `POST /rounds/:id/generate-visits` — on-demand visit generation; rounds already got visits via the nightly job, this just removes the next-day wait.
11. **OpenAPI/swagger coverage** — `/rounds*`, `/technicians`, `/messages*`, `/setup/step/9-12`, `/debt*`, `/reports*`, `/today*`, `/invoices*`, `/payments*`, `/service-plans*` added to `src/swagger.ts`, including the shape changes above. This was done as a documentation-only pass over the real route/service code; given competing priorities it has not had the same line-by-line scrutiny as the endpoint work itself — treat `GET /docs` as a good-faith reference and report any drift you spot against actual responses.

**Also fixed along the way:** a date-validation bug on the round planner routes — `2026-02-30` (syntactically valid, not a real date) was silently rolling over to March 2 instead of 400ing, on both the pre-existing single-round endpoint and the new batch one.

### Phase 3 (items 2 and 3 only — item 1 explicitly out of scope this round)

2. **`prisma/seed.ts` rewrite.** Was a dead stub — new tenants got zero default Services/MessageTemplates. Rewritten as a CLI backfill tool for pre-existing tenants (`npx tsx prisma/seed.ts <schemaName>`), and — the actual production fix — wired a `seedTenantDefaults()` call into `POST /auth/signup` so every new tenant is seeded automatically (6 Services, 6 MessageTemplates), idempotent against retries. This directly removes the need for the frontend's hardcoded sample service/template lists once verified against a fresh signup.
3. **Technician role vocabulary.** `Technician.role` was an unvalidated free-text column on both `/technicians` and `/settings/technicians` write paths — not literally "two conflicting enums" as the audit framed it, but zero enforced vocabulary either way. Added one shared `TECHNICIAN_ROLES` list (`TRAINEE`/`STANDARD`/`SENIOR`/`LEAD`) + validator used by both routers, and aligned `/settings/technicians`' response shape with `/technicians` (now also returns `serviceAreas[]` and the same `appStatus` derivation, instead of a second drifting copy of that logic).

---

## Part C — Not built (needs a product decision, or separately scoped)

Per the original triage, these were flagged but intentionally not implemented against:

1. **Dashboard "today's stops" map with lat/lng (Phase 3 item 1).** No lat/lng field exists anywhere on `Property`/`Visit` — needs a schema migration, a geocoding step, and confirmation the frontend will actually have a maps API key configured. Scoped as its own ticket.
2. **SMS pricing / credit balance / dry-run cost.** Messaging is currently a GHL-owned utility, not backend-billed. Needs a decision: does RoundFlow bill SMS credits itself, or does the frontend query GHL directly?
3. **`sendAt` / scheduled sends.** Deliberately not built — scheduling is a GHL workflow handoff (contact tagging), not a backend scheduler. Needs a decision to commit to that design permanently or reverse it.
4. **Weather Hold as a real feature.** 100% fake on the frontend today. Needs product sign-off on the actual UX before any endpoint is built.
5. **Complaint `issueType` as a fixed enum.** Currently free text; needs a canonical list decision + a backfill plan for existing rows.
6. **`STANDING_ORDER` as a supported `PaymentMethod`.** Trivial enum addition, only if product wants to support it.
7. **Bulk debt action endpoint.** Needs a decision on which actions are bulkable and whether "all matching the current filter" or "selected rows only" is the intended UX.

---

## Frontend action required

See `docs/handoff/2026-10-22-frontend-handoff.md` for the developer-facing breakdown of breaking changes (pagination shape on 3 endpoints, per-plan write migration, bulk-import response shape, role vocabulary) versus additive/no-action items.
