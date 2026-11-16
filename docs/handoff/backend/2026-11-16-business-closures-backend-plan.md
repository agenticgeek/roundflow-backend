# Business closures: backend plan (2026-11-16)

**Status: PLAN ONLY. Nothing is implemented, no migration exists, no database was touched.** Frontend counterpart: `docs/handoff/frontend/2026-11-16-business-closures-frontend-contract.md`. Both documents must stay in step; the endpoint shapes in section 4 are the contract.

Origin: Agentum AI client call action items 3, 4 and 5 (Hamza). Item 3 is "move all work during a shutdown period", item 4 "date selection when pushing outstanding jobs", item 5 "manual generate visits". This plan covers 3 and the projection fix it depends on. Items 4 and 5 are listed in section 9 as follow-ups that share pieces.

## 1. Decisions (settled with the owner, do not re-litigate)

| Topic | Decision |
|---|---|
| Closure kinds | Any closure. Free start and end date plus a free-text label. No preset list, no fixed "type" or "reason" enum. Any number of closures, overlap allowed. |
| Move or skip | Both are offered. The mode is chosen **per closure**: `MOVE` or `SKIP`. |
| Round day | After a closure each round keeps **its own** day. Visits are not spread across the first week back. |
| Anchor | The round day is the anchor. A closure move is a one-off, exactly like Mike's overspill push (Monday round pushed to Tuesday or Wednesday, next cycle is Monday again). **A move never re-anchors `servicePlan.nextDueDate`** (it only ever changes by whole cycles; see `2026-11-16-closure-rules.md` s0). "Wednesday stays Wednesday" is a separate future feature. |
| Customer messages | Notification is built now, off unless ticked per closure. Wording is one default constant per mode. Wording and per-business editing are decided later. |
| Scope of a closure | Scheduled round work only. One-off visits and emergency jobs are not touched and not blocked; a warning is shown if one is placed inside a closure. |
| Scheduler | Visits are still created lazily on their due day (one per plan). No 28-day look-ahead, no pre-creation. |

## 2. What the code does today (verified by reading, 2026-11-16)

- `src/jobs/visitGeneration.ts` `generateForRound`: for each ACTIVE plan with `nextDueDate <= today` it creates one SCHEDULED visit dated `visitDateFor(nextDueDate, round.defaultDay, workingDays)` (round day on or after the due date, else the next working day), queues the GHL `visit.scheduled` event, then sets `nextDueDate = nextDueAfter(visitDate, freq, defaultDay)` (one cycle later, snapped forward to the round day).
- It skips a plan that already has a SCHEDULED or IN_PROGRESS visit dated today or later ("idempotent" check), and skips a date inside a future-dated pause window.
- Reschedule (`visit-reschedule.ts`) and carryover (`carryover.service.ts`) change only the visit, never the plan. This is by design (section 1).
- `src/services/round-projection.ts` builds display-only forecast entries. It starts the series from the **earliest upcoming real visit date** and adds the frequency, snapping forward to the round day.
- `carryOverVisits` already takes `visitIds`, resets reminder markers, cancels queued messages, reports technician conflicts, logs `VISITS_CARRIED_OVER`. Note: it skips any visit whose date differs from `fromDate` (`NOT_ON_DATE`), so one call handles one source day only.
- `Visit.skipReason` exists (used by `POST /today/close` with `mark_as_skipped`).
- Nothing in the system knows about business closures.

### The projection defect (fix first, independent of closures)

With a 4-weekly Monday round whose visits were due Mon 16 Nov, if all remaining upcoming visits are pushed to Tue 17 Nov, the projection starts at Tue 17 Nov, adds 28 days (Tue 15 Dec) and snaps forward to **Mon 21 Dec**. Generation will really create the next visit on **Mon 14 Dec** (the plan's `nextDueDate` is unchanged). The calendar is one week late. It shows whenever every upcoming visit of a round sits on a pushed day, which is the normal state after Monday's work is done. Found by code reading, not yet reproduced; the first test written for it should reproduce it.

## 3. Data model (tenant schema, additive, idempotent migration)

New migration folder, following the existing naming, for example `prisma/tenant/migrations/20261116100000_business_closures` (check the timestamp is later than `20261110100000_flo_ai`). Must be idempotent like the existing ones (`IF NOT EXISTS`). Applied by the normal deploy (`migrateAllTenantSchemas`). New tables only, so no rollback is needed.

```
enum ClosureMode { MOVE SKIP }

model BusinessClosure {
  id              String      @id @default(cuid())
  label           String                       // free text, 1-80 chars, trimmed, plain text
  startDate       DateTime    @db.Date         // inclusive, calendar day
  endDate         DateTime    @db.Date         // inclusive, >= startDate
  mode            ClosureMode
  notifyCustomers Boolean     @default(false)
  roundIds        String[]    @default([])     // empty = all rounds
  appliedAt       DateTime?   @db.Timestamptz  // last successful "apply to existing visits"
  createdById     String?
  createdAt       DateTime    @default(now()) @db.Timestamptz
  updatedAt       DateTime    @updatedAt @db.Timestamptz

  @@index([startDate, endDate])
}
```

Use the same date convention as the rest of the scheduler (UTC-midnight calendar days via `startOfUtcDay`). Confirm whether existing date columns use `@db.Date` or `@db.Timestamptz` before writing the migration and copy that.

## 4. API contract (shared with the frontend doc)

New router `src/routes/closures.ts`, mounted at `/closures` (a new file so it can be gated at 100%; do not grow `settings.ts`). Writes: ADMIN and MANAGER. Reads: ADMIN and MANAGER (technicians do not need them; confirm against the role matrix test and do not assume). Dates are `YYYY-MM-DD`. Error shape is the existing `AppError` JSON with a `code`.

Closure object:
```json
{ "id": "clx...", "label": "Christmas", "startDate": "2026-12-24", "endDate": "2027-01-03",
  "mode": "MOVE", "notifyCustomers": false, "roundIds": [], "appliedAt": null,
  "createdAt": "...", "updatedAt": "..." }
```

| Endpoint | Body or query | Success | Errors |
|---|---|---|---|
| `GET /closures?from=&to=` | both optional; default: closures whose `endDate >= today` | `200 { closures: Closure[] }` sorted by `startDate` | 400 `VALIDATION_FAILED` bad date |
| `POST /closures` | `{ label, startDate, endDate, mode, notifyCustomers?, roundIds? }` | `201 Closure` | 400 `VALIDATION_FAILED`, 400 `INVALID_CLOSURE_RANGE` (end before start, longer than 366 days, or ends in the past), 400 `UNKNOWN_ROUND` (an id in `roundIds` does not exist) |
| `PATCH /closures/:id` | any subset of the create fields | `200 Closure` | as above, 404 `CLOSURE_NOT_FOUND` |
| `DELETE /closures/:id` | | `204` | 404 `CLOSURE_NOT_FOUND` |
| `POST /closures/:id/apply/preview` | none | `200 Preview` | 404 |
| `POST /closures/:id/apply` | `{ notifyCustomers?: boolean }` (default: the closure's value) | `200 ApplyResult` | 404, 409 `CLOSURE_ENDED` (window entirely in the past) |

Deleting or editing a closure never restores visits that were already moved or skipped. Say so in the frontend copy.

Admin writes should honour the existing `Idempotency-Key` header (BE-17); `apply` especially.

`Preview`:
```json
{ "closureId": "...", "mode": "MOVE",
  "totals": { "visits": 37, "rounds": 3, "customers": 35, "technicianConflicts": 2 },
  "rounds": [ { "roundId": "...", "roundName": "Monday North", "visitCount": 20,
                "groups": [ { "from": "2026-12-28", "to": "2027-01-04", "count": 20 } ] } ],
  "conflicts": [ { "visitId": "...", "technicianId": "...", "reason": "TECHNICIAN_UNAVAILABLE" } ],
  "customerMessage": "Hi {{firstName}}, ..." }
```
Groups, not one row per visit: a 500-property round must not produce a 500-row payload. For `SKIP` the groups carry `to: null`.

`ApplyResult`: `{ closureId, mode, moved, skipped, conflicts, notifiedTechnicians, notifiedCustomers, customerNotificationError?, appliedAt }`. Same best-effort rule as carryover: the move is done even if the customer message step fails, and the error is reported, not thrown.

Warnings (non-blocking) on existing endpoints:
- `PATCH /visits/:id/reschedule` and `POST /visits/carryover` responses gain optional `warnings: [{ code: "DATE_IN_CLOSURE", closureId, label, startDate, endDate }]`. Never an error. Absent when there is nothing to warn about.
- `GET /visits/carryover/options` (and the equivalent used by close-day) marks an option whose date is inside a closure with `closure: { closureId, label }`. Check the real route path in `routes/visits.ts` and `routes/today.ts` before writing this.

`swagger.ts` must be updated in the same change (the frontend generates `types.gen.ts` from `/openapi.json` on the deployed backend, so the endpoints must be deployed before the frontend can generate types).

## 5. Behaviour

### 5.1 Pure helpers (new `src/lib/closures.ts`, no I/O)

- `closuresFor(date, roundId, closures)`: the closures covering that day for that round (a closure with empty `roundIds` covers every round).
- `resolveClosedDate(date, roundId, defaultDay, workingDays, closures)` returns `{ action: "SKIP" } | { action: "KEEP", date } | { action: "MOVE", date }`.
  - No covering closure: `KEEP`.
  - Any covering closure with mode `SKIP`: `SKIP` (SKIP wins over MOVE when they overlap; document in the code comment).
  - Otherwise `MOVE`: the first date after the end of the covering closure(s) that is the round's day (or a working day when the round has no day) **and** not inside any other closure that applies to the round. Loop until stable, with a hard iteration cap (for example 400 days) that throws, so bad data cannot hang the nightly job.
- Everything here is a pure function of its inputs, which is what makes 100% coverage cheap.

### 5.2 Generation (`visitGeneration.ts`, gated at 100% already, keep it there)

Load the closures once per run (not per plan), filtered to those that end today or later. In the plan loop, after `visitDateFor`:
- `KEEP`: unchanged behaviour.
- `MOVE`: create the visit on the resolved date. **Advance `nextDueDate` from the original pre-move date**, not the moved one, so the anchor holds (this is the one line that is easy to get wrong).
- `SKIP`: create no visit and queue no GHL event. Advance `nextDueDate` by whole cycles (`nextDueAfter`) until the resulting visit date is no longer `SKIP`, then write it. Log one `ActivityLog` row per run per closure with the count, not one per plan.
- There is no weekly frequency (only 4, 6, 8 and 12 weeks), so a closure of up to three weeks touches at most one cycle of a plan. A closure **longer than the frequency** (for example 5 weeks on a 4-weekly plan) covers two cycles: MOVE yields **one** visit after the break and SKIP drops both. The "future visit already scheduled" check alone does NOT achieve this (it stops protecting once the moved visit's date passes and would mint a past-dated visit); the **served-cycle guard** in `2026-11-16-closure-rules.md` s4.1 does. See examples B9 and B10 there.
- The existing pause-window skip (A4) keeps working; closure logic runs after it.

### 5.3 Projection (`round-projection.ts`)

1. **Anchor fix (ships first, with no closure dependency).** Real visits are still returned as real entries. Forecast entries are generated from the plans' `nextDueDate` anchor, not from the earliest upcoming visit date: the series starts at the earliest of the ACTIVE plans' `nextDueDate` (clamped to today) and the paused plans' resume days, then repeats the frequency snapped to the round day. "A date that already has real visits is real" and the 4-entry and 13-week caps stay.
2. **Closure-aware.** Each projected date goes through `resolveClosedDate`; `MOVE` shows the moved date, `SKIP` drops that entry. Real visits that were moved already carry their new date, so nothing extra is needed for them.

Open implementation detail to settle with a failing test first: a round where some plans have a generated visit and others do not (different `nextDueDate`s). The rule above (earliest anchor) should hold; the test matrix in section 7 covers it.

### 5.4 Apply to existing visits (new `src/services/closure-apply.service.ts`)

Selects SCHEDULED visits (not IN_PROGRESS, not completed) dated inside the window for the closure's rounds, with **`isOneOff: false`**. Verified 2026-11-16: `Visit.isOneOff` (schema line 544) is the authoritative one-off marker. It is set `true` by one-off creation (`visit.service.ts`) and by complaint re-cleans (`complaint.service.ts`), and `false` by nightly generation. A one-off can still have a `roundId` (it then shows in the Round Planner), so a null `servicePlanId` is **not** a safe filter; do not use it.
- `MOVE`: compute each visit's target with `resolveClosedDate`, group by `(fromDate, targetDate)`, and call the existing `carryOverVisits` once per group with `visitIds`, inside one transaction. Add `"closure"` to its `via` union so the activity log distinguishes it. A moved visit gets the normal carryover side effects (reminder reset, queued message cancel, `carriedOverFromDate`, `carryoverCount`).
- `SKIP`: set status SKIPPED, `skipReason = closure.label`, cancel queued messages for those visits, one activity log row. The plan's `nextDueDate` is not touched (the next cycle is handled by generation).
- Technician notification reuses `notifyCarryoverTechnicians`. Customer notification reuses the `notifyCarryoverCustomers` mechanism with a message per mode: constants `CLOSURE_MOVE_CUSTOMER_BODY` and `CLOSURE_SKIP_CUSTOMER_BODY` next to `CARRYOVER_CUSTOMER_BODY` (variables: firstName, address, newDate or startDate/endDate, businessName). Customers are told at apply time only; visits created later by the nightly job simply never land in the window and need no message.
- Sets `appliedAt`. Re-running finds only what is still inside the window, so it is safe to run twice and after extending a window.
- `preview` runs the same selection and computation with no writes and returns the section 4 payload.
- Refuse target dates in the past and dates on an already closed day the same way carryover does (`CARRYOVER_TARGET_IN_PAST` and `CARRYOVER_TARGET_CLOSED` reasoning); see `carryover.service.ts`.

### 5.5 Warnings

`reschedule` and carryover compute `DATE_IN_CLOSURE` for the target date with `closuresFor`. They never block (decision: one-offs and manual moves are the owner's call).

## 6. Permissions, docs, housekeeping

- `src/lib/permissions.ts`: new routes are writes for ADMIN and MANAGER, so no entry in `ADMIN_ONLY_ROUTES`. The repo has a role-matrix test that covers every route; add the new routes to it.
- `swagger.ts`: new schemas and paths (Closure, Preview, ApplyResult, warnings).
- **`docs/ARCHITECTURE_LATEST.md`: update it once, at the very end, after all tests are written and green** (owner instruction 2026-11-16, specific to this feature; the general rule of not editing it unprompted still stands). Add a new section 23 after "22. Flo AI", in the same style as sections 19 to 22: closures model and migration, the two modes and the anchor rule, generation and projection changes, apply flow, warnings, permissions, test and coverage gates, and the follow-ups. Also add the new files to any file lists or the migrations table in that document. Do not touch it before then.
- **`roundflow-e2e/` is now in scope** (owner instruction, later on 2026-11-16, superseding the earlier "do not touch"). The scenario, simulation and browser layers live there under a `CLO` domain; see `2026-11-16-business-closures-execution-plan.md` for the files, the helper contract and the parallel build order. Unit tests still live in `roundflow-backend` and `roundflow-frontend`.

## 7. Tests: 100% coverage required

Target: 100% line, branch, function and statement coverage on everything added or changed. Mechanics in this repo:
- Add the new whole files to a gated list in `vitest.config.ts` (per-file 100%): `src/lib/closures.ts`, `src/services/closure-apply.service.ts`, `src/routes/closures.ts`, and the closure service if one is split out.
- Already gated, so changes must not drop them below 100%: `src/jobs/visitGeneration.ts`, `src/lib/schedule.ts`, `src/lib/working-days.ts`, `src/services/carryover.service.ts`, `src/services/service-plan-lifecycle.ts`.
- Not gated whole (legacy code mixed in): `src/services/round-projection.ts` and `round.service.ts`, `routes/visits.ts`. Their changed lines must be fully covered; check with `npm run test:diff-coverage`, and run `npm run test:coverage`.
- Gap-filling effort is capped at 2 or 3 rounds per file; if a branch is truly unreachable, say so and justify it rather than adding a contrived test.

Matrix (each row is a test, grouped by file):

`lib/closures.test.ts`: no closure; closure on its first day, last day and day after; empty `roundIds` covers all rounds; `roundIds` scoping includes and excludes; MOVE onto round day (Mon, Thu); round with no day uses working days; weekend in the middle; two back-to-back closures chained; overlapping MOVE and SKIP (SKIP wins); closure ending exactly on the round day (target is the next occurrence); iteration cap throws.

`visitGeneration.test.ts` additions: KEEP unchanged; MOVE creates the visit on the moved date and `nextDueDate` equals the cycle from the **original** date (the anchor test); SKIP creates nothing, no GHL event, `nextDueDate` advanced past the window; weekly plan with two cycles in the window creates one visit; round-scoped closure leaves other rounds alone; technician unavailability resolved for the moved date; closure plus pause window together; closures loaded once per run (assert one query).

`round-projection.test.ts` additions: anchor fix, **reproduce the 21 Dec versus 14 Dec case first**; all visits on Tuesday; mixed Monday and Wednesday visits; paused plan resume; weekly and 4-weekly and 12-weekly; real wins; caps still hold; MOVE shows the moved date; SKIP drops the entry; round-scoped closure; no closures (unchanged output).

`routes/closures.route.test.ts`: every endpoint and every error code; role matrix (ADMIN, MANAGER allowed, TECHNICIAN and anonymous refused, other tenant's id is a 404); label trimming and length; range validation (end before start, over 366 days, in the past); unknown round id; PATCH partial; idempotency key replay on `apply`.

`closure-apply.service.test.ts`: preview equals apply (same counts and groups); MOVE grouping by (from, target); SKIP marks status and reason and cancels queued messages; in-progress and completed visits untouched; one-off visits untouched; technician conflicts reported; customers notified only when ticked; customer-message failure still completes the move and reports the error; re-run is a no-op; extended window picks up the remainder; empty result; past target refused; closed-day target refused; `appliedAt` set.

`reschedule` and `carryover` test additions: `DATE_IN_CLOSURE` warning present and absent; never changes the status code.

Also: `npm run typecheck` clean, `npm run build` clean (stop any running dev server first; it locks the Prisma engine on this machine), `npm test` full run green.

## 8. Suggested slices (each shippable and testable alone)

1. Projection anchor fix, with its reproduction test. No schema change.
2. Migration, Prisma model, `lib/closures.ts` and its tests.
3. `closures` router with CRUD, permissions, swagger, role-matrix entries.
4. Generation and projection use closures (section 5.2 and 5.3.2).
5. Apply and preview, notifications.
6. `DATE_IN_CLOSURE` warnings on reschedule, carryover and options.

Slices 1 to 3 are enough for the frontend to start; the frontend plan lists what it can build against each.

## 9. Related follow-ups (not in this plan)

- **Item 4, free date when pushing outstanding jobs.** Add an optional `targetDate` next to `target` on `POST /visits/carryover` and `/today/close`. Rules: not in the past, not a closed day, at most about 60 days ahead (confirm the number with Hamza), warn on non-working days and `DATE_IN_CLOSURE`, keep the technician conflict report. `nextDueDate` stays untouched (same anchor rule). `carryover.service.ts` and `working-days.ts` are gated at 100%.
- **Item 5, manual "generate visits".** The endpoint exists (`POST /rounds/:id/generate-visits`, `generateVisitsNow`, ACTIVE rounds only, always from today). A button on the round detail panel is a frontend-only change. Closures apply to it automatically because it calls `generateForRound`.
- **Wednesday stays Wednesday.** A deliberate "move permanently" action that changes the round day. Separate discussion.
- **Per-business editable closure message.** Later, once the wording is agreed.
- **28-day look-ahead materialisation.** Evaluated and deferred (see the conversation notes): it would rework one-visit-per-plan, GHL event timing and plan-edit propagation. Revisit only if the owner needs to edit visits weeks ahead.

## 10. Open items to confirm before or during implementation

1. ~~Which field marks a one-off visit~~ Resolved: `isOneOff` (see section 5.4).
2. Whether date columns in this schema are `@db.Date` or timestamp; copy the existing convention.
3. Exact routes and shape of the carryover options and close-day paths, for the warning field.
4. Whether `TECHNICIAN` (and any office role) must read closures; defaulted to no.
5. Whether closure-driven moves should increment `carryoverCount` (they do under this plan, because they reuse the carryover core; the badge text "Carried over from {date}" is then shown for them). Acceptable unless the owner objects.

## 11. Scenario suite: exhaustive verification before any handoff (added 2026-11-16)

Owner requirement: every closure, generation, projection and apply behaviour is tested rigorously and exhaustively **before** any hand-off note, commit message or "done" statement. Section 7 (per-file unit tests) is necessary but not sufficient: it proves each function; this section proves the whole system. Both are required. **Location (updated by the owner, later on 2026-11-16): the scenario and simulation layers live in `roundflow-e2e`** (real Postgres, real backend, Playwright), not in `roundflow-backend`; see `2026-11-16-business-closures-execution-plan.md`. Layer 1 (unit tests) stays in `roundflow-backend` and `roundflow-frontend`. Where 11.1 and 11.2 below mention backend test files or in-memory fakes, read them as the e2e equivalents (`roundflow-e2e/specs/scenarios/closures-*.spec.ts`, SQL-seeded tenants, a request-scoped test clock).

### 11.1 Three layers

1. **Unit tests** (section 7), 100% coverage as gated.
2. **Scenario tests**: named, numbered, readable cases that drive the real service and job code through a full story (set up closures, run the nightly job over simulated days, read the calendar, apply, carry over) and assert the exact dates. File `src/services/__tests__/closures.scenarios.test.ts` (split by area if large). Each test title starts with its catalogue ID.
3. **Simulation and invariant tests**: a day-by-day simulator runs the nightly job over a simulated calendar (at least two years) for a grid of generated configurations, and asserts properties that must always hold (11.3). This finds the bugs nobody thought to write a scenario for, and it is how the projection defect would have been caught.

A **scenario catalogue** document, `docs/handoff/backend/2026-11-16-business-closures-scenario-catalogue.md`, lists every scenario ID, its setup, the expected dates and the result (PASS or the failure). It is written before the tests, updated as they are written, and handed over complete. IDs: `CLO-GEN-nnn` (generation), `CLO-PRJ-nnn` (projection), `CLO-APP-nnn` (apply), `CLO-WRN-nnn` (warnings), `CLO-LIF-nnn` (lifecycle and edge cases), `CLO-API-nnn` (routes), `CLO-UI-nnn` (frontend, in the frontend doc).

### 11.2 Simulation harness

- A fake tenant store (in memory, the same shape the existing job and service tests already fake; check how `visitGeneration.test.ts` does it and reuse it, do not invent a second style) holding plans, properties, rounds, technicians, availability, closures and visits.
- A virtual clock: `runNightly(date)` calls the real `generateForRound` per ACTIVE round exactly as the cron does, so tests move through time deterministically. No real timers and no `Date.now()` leaks (inject or fake the clock).
- Helpers to read the calendar (`projectOccurrences`), run apply and preview, carry over, reschedule, and snapshot the visits.
- Optional, decision for the owner: if a local throwaway Postgres is available, also run the migration and a seeded subset of the scenarios against a real tenant schema. It must be a scratch database, never a shared or live one, and nothing is applied to any real database without asking.

### 11.3 Invariants checked on every simulated run

1. **No plan visit is dated inside a covering closure** (for the rounds the closure covers), in either mode.
2. **Every plan visit is on its round's day**, or on a working day when the round has none.
3. **Anchor holds**: with no closures the visit dates equal the pure cycle from the start date. With MOVE, the cycle after the closure returns to the original anchor dates (a 4-weekly Monday round is back on its original Mondays).
4. **No duplicates**: at most one visit per plan per date; at most one open (scheduled or in progress) visit per plan unless the frequency makes two legitimate.
5. **SKIP arithmetic**: visits created = cycles in the run minus cycles that fell in the closure.
6. **Projection equals generation**: for every simulated day, each forecast date the calendar shows is the date the nightly job later actually creates a visit on, and no forecast is shown for a date generation will not use. This is the key consistency property.
7. **Idempotence**: running the nightly job twice on one day changes nothing; running apply twice changes nothing; preview equals what apply then does.
8. **No writes from reads**: projection and preview leave the visit table unchanged (row count and contents).
9. **Untouched means untouched**: one-off visits, completed, in-progress, cancelled and other-round visits are never changed by apply or generation.
10. **Termination**: no input can hang the job. Adversarial closures (covering a whole year, chained back to back for years, covering every working day) end in a bounded number of steps with the defined error.
11. **Anchor immunity**: a move, reschedule or carryover never re-anchors `servicePlan.nextDueDate`; it only ever changes by whole cycles (rules s0.3). Reschedule and carryover do not write it at all.

### 11.4 Scenario dimensions (the grid)

The simulator crosses these. The named scenarios hand-pick the interesting cells and the invariants run over the whole grid.

- **Frequency**: 4, 6, 8 and 12 weekly (the only frequencies that exist), and a plan whose own frequency differs from the round's.
- **Round day**: each of the seven days including a weekend day, and no round day (falls back to working days).
- **Working-day config**: Mon to Fri, including Saturday, a custom set, a single working day.
- **Closure position against the cycle**: ends the day before the due date, on it, starts on it, in the middle, ends on the round day, ends the day before the round day, spans several cycles, spans a whole year.
- **Closure length**: 1 day, shorter than a week, exactly a week, two weeks, longer than the frequency, 366 days.
- **Mode and scope**: MOVE, SKIP, all rounds, one round, several rounds, an empty scope list.
- **Combinations**: duplicate, adjacent, overlapping, nested and chained closures; MOVE overlapping SKIP; a closure whose end lands inside another closure; two rounds on different days in one closure.
- **Calendar edges**: Christmas to New Year, leap day, year end, UK clock changes (late March and late October; confirm how `tenantToday` and `startOfUtcDay` interact with the tenant time zone and assert the dates stay correct), a closure straddling a month end.
- **Plan state**: ACTIVE; paused before, during and across the closure; pause starting or ending inside it; resumed inside it; a plan added during a closure (its first `nextDueDate` falls inside it); cancelled or inactive plan; `nextDueDate` already overdue (the job was down), including catch-up after the closure.
- **Round and property state**: round archived, draft or renamed; round day changed during a closure; a property moved to another round during a closure (`moveFutureVisitsToRound`); a property with a custom assigned technician; a property with no technician; a round with no technicians.
- **Technicians**: unavailable on the original date, on the moved date, on both, on neither; inactive technician; moved date lands on a technician's leave (conflict reported, not blocking).
- **Visit state when apply runs**: SCHEDULED, IN_PROGRESS, COMPLETED, SKIPPED, CANCELLED; one-off; complaint re-clean (also `isOneOff`); payment hold set; already carried over once or more; carried over into the closure.
- **Closure lifecycle**: created before the due day; after the visit exists; after apply; edited to shrink, extend, change mode or change scope after apply; deleted after apply; created with a window already partly in the past; ended while a visit still points at it.

### 11.5 Named scenario list (each becomes a catalogue row with exact expected dates)

**Generation (`CLO-GEN`)**
1. No closures: output identical to today (regression baseline for every frequency and round-day combination).
2. 4-weekly Monday round, due date inside a closure: the visit goes to the first Monday after, and the following cycle is on the **original** Monday cadence.
3. Same, SKIP: no visit; `nextDueDate` is the first cycle after the window; no GHL event queued.
4. 4-weekly plan, 5-week MOVE closure covering two cycles: one visit after the break, not two (rules B9).
5. Same closure as SKIP: both cycles dropped, cadence resumes (rules B10).
6. Closure ends exactly on the round day; closure ends the day before; closure starts on the due date.
7. Two rounds on Monday and Thursday in one closure: each lands on its own day, nothing piles onto one day.
8. Round with no round day: lands on the first working day after the closure; weekend handling.
9. Round-scoped closure leaves other rounds untouched; empty scope means all.
10. Chained and overlapping closures resolve to the first open day; MOVE plus SKIP overlap resolves to SKIP.
11. Closure plus pause window plus technician leave all at once.
12. Plan created during a closure; plan resumed inside a closure.
13. The job was down for the whole closure (overdue plans): catch-up creates the right dates without duplicates.
14. A technician unavailable on the moved date gets a different or null assignment, as for any visit.
15. The 500-property round: the query count does not grow per plan (closures loaded once); document the measured count.
16. Closure edited, deleted or shortened between two nightly runs: the next run uses the new state.

**Projection (`CLO-PRJ`)**: the pushed-visit case (21 Dec versus 14 Dec, reproduced first); all upcoming visits on Tuesday; mixed Monday and Wednesday; MOVE shows the moved date; SKIP removes the entry and the 4-entry cap then admits the next one; two forecasts colliding on the same moved date become one; forecast window edges and the 90-day cap; paused plans; draft and archived rounds not projected; round-scoped closure; no closures unchanged; **projection equals generation** for every cell of the grid (invariant 6).

**Apply (`CLO-APP`)**: preview equals apply; MOVE groups by (from, target) with each round on its own day; SKIP marks status and reason and cancels queued messages; in-progress, completed, cancelled, one-off and complaint re-clean visits untouched; an already-carried-over visit moved again; technician conflicts reported; customers notified only when ticked; customers with opt-out or no contact skipped without error; a customer-message failure still completes and reports; GHL not connected falls back to the native email path; technician notification sent once per technician; running twice is a no-op; window extended then re-applied picks up the remainder; window shrunk does not undo; apply to a closure entirely in the past refused; target on an already closed day refused; target in the past refused; idempotency-key replay returns the stored result; concurrent apply does not double-move (transaction); empty result; a very large result stays within payload limits (groups, not rows).

**Warnings (`CLO-WRN`)**: reschedule into a closure warns and succeeds; carryover (all targets) warns; carryover options mark closure dates; close-day push-to-tomorrow into a closure warns; no warning outside any closure; round-scoped closure warns only for that round's visit; a one-off placed in a closure warns and is not blocked.

**Lifecycle and edges (`CLO-LIF`)**: the calendar-edge, plan-state and round-state items in 11.4; deleting a closure keeps moved visits; editing the mode after apply; time-zone and clock-change dates; leap day.

**Routes (`CLO-API`)**: every endpoint, status code and error code, role matrix, other-tenant ids, validation boundaries (80-character label, 366-day range, past end date, unknown round), idempotency key.

### 11.6 Process rules

- **Red before green**: for the first scenario of each slice, write it, run it and see it fail for the right reason (the projection one must fail on today's code with 21 Dec), then fix.
- **Break it on purpose**: after a slice is green, make three or four deliberate one-line breaks (for example advance `nextDueDate` from the moved date, drop the SKIP precedence, skip the scope filter) and confirm a scenario fails each time. If none does, the suite has a hole; add the scenario. Revert every break and record in the catalogue which break each scenario catches.
- **Findings are reported, not hidden**: any behaviour that looks wrong or surprising while writing scenarios goes into the catalogue as a finding with the actual and expected dates, and is raised with the owner before it is "fixed by design".
- **Definition of done before any hand-off**: unit coverage gates at 100%, every catalogue row PASS, every invariant passing across the full grid, break-it checks done, `typecheck` and `build` clean, full `npm test` green, then `ARCHITECTURE_LATEST.md` section 23 (section 6), then the hand-off note. No commit message and no "done" message before that.
