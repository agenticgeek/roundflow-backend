# Business closures: rules specification (2026-11-16)

**Status: contract (Phase 0). Part of the plan; nothing is implemented yet.** This is the single source of truth for: the backend helpers (`lib/closures.ts`), generation, projection and apply; the e2e **oracle** (written independently from this document); the unit tests; and the scenario catalogue. If code and this document disagree, one of them is wrong and the owner is told; nobody quietly picks a side.

Related: `2026-11-16-business-closures-backend-plan.md` (what and why), `2026-11-16-business-closures-execution-plan.md` (how it is built), `2026-11-16-closures-contracts.md` (interfaces, test hooks, helper signatures).

## 0. Corrections to the earlier plan documents (read first)

Reading the code while writing this spec found three things the earlier documents had wrong. This document is authoritative; the backend plan has been corrected to match.

1. **There is no weekly or fortnightly frequency.** `CleaningFrequency` is `FOUR_WEEKLY | SIX_WEEKLY | EIGHT_WEEKLY | TWELVE_WEEKLY` (4, 6, 8 and 12 weeks). A closure of up to three weeks can therefore touch **at most one cycle** of a plan. A cycle is only "collapsed" by a closure longer than the frequency (for example the 5-week closure in example B9).
2. **The "future visit already scheduled" check does not protect the next cycle.** It only blocks while the existing visit is dated today or later. After that date passes, a plan whose `nextDueDate` is still earlier than the moved visit would mint a visit **in the past**. The rule that fixes this is the **served-cycle guard** (section 5.3).
3. **`nextDueDate` is not "never changed".** The correct invariant is: **`nextDueDate` only ever changes by a whole number of cycles from where it already was (it is never re-anchored to a moved date).** Generation already advances it by one cycle after creating a visit; the guard may advance it by more.

## 1. Vocabulary and conventions

- **Date-only**: every date is a calendar day, stored and compared as UTC midnight (`startOfUtcDay`). "Today" is the tenant-local calendar day (`tenantToday`). No times of day anywhere in these rules.
- **Plan** (`ServicePlan`) has `nextDueDate`, `cleaningFrequency` (else the round's), and belongs to a property in a **round**. A round has `defaultDay` (a weekday or null), `frequency`, and the tenant has **working days** `W` (`defaultWorkingDays`, empty means Monday to Friday).
- `weeks(f)`: FOUR 4, SIX 6, EIGHT 8, TWELVE 12.
- `nextOcc(x, day)`: the first date on or after `x` that is `day`. `snapWD(x, W)`: `x` if it is a working day, else the next working day.
- `visitDateFor(N)` (existing, `visitGeneration.ts`): `defaultDay ? nextOcc(N, defaultDay) : snapWD(N, W)`. The round day is **not** checked against `W`: a round on a non-working day still runs on its day.
- `nextDue(V)` (existing: `nextDueAfter` then the generator's snap): the date `V + 7 * weeks(f)` days, then `defaultDay ? nextOcc(., defaultDay) : snapWD(., W)`.
- **Anchor**: the original cycle. After any closure move, the following cycle is computed from the **original** raw visit date `V0`, never from the moved date.

## 2. Closures

A closure has: `label` (free text), `startDate`, `endDate` (both inclusive), `mode` (`MOVE` or `SKIP`), `notifyCustomers`, `roundIds` (empty means all rounds), `appliedAt`.

- **Applies to a round** if `roundIds` is empty or contains the round's id.
- **Covers a day `x` for a round** if it applies to the round and `startDate <= x <= endDate`.
- A closure only ever matters for the dates it covers. **Apply, warnings and the default `GET /closures` list** consider only closures with `endDate >= today`. **Generation and projection** load closures with `endDate >= today - 366 days` (once per run), so a cycle that fell inside a closure that has since ended (for example the job was down over the closure) is still moved or skipped correctly (ruling 2026-11-16, example B20). A closure that ended before a cycle's own date never affects it (example B19).
- Several closures may overlap, nest, touch or duplicate each other. No uniqueness.
- **Validation** (API): `label` trimmed, 1 to 80 characters, plain text (no control characters); dates valid `YYYY-MM-DD`; `endDate >= startDate`; `endDate - startDate + 1 <= 366` days; `endDate >= today` (a closure that is entirely in the past is refused; editing an existing closure never makes this check on fields it did not change); every id in `roundIds` exists; `mode` one of the two; `notifyCustomers` boolean.

## 3. `resolve`: where does a visit due on `V0` go?

Input: `V0` (a raw visit date from `visitDateFor`), the round, `W`, the closures that apply to the round. Output: `KEEP(V0)`, `MOVE(M)` or `SKIP`.

```
x = V0
repeat (at most 400 times; the 401st throws CLOSURE_RESOLUTION_LIMIT):
    cov = closures covering x
    if cov is empty:  return (x == V0) ? KEEP(x) : MOVE(x)
    if any closure in cov has mode SKIP:  return SKIP          // SKIP wins, also on a landing day
    e = the latest endDate among cov
    x = visitDateFor(e + 1 day)                                // the round's own day (or a working day) after the closure
```

Consequences (each has an example below): MOVE lands on the first round-day after the closure; a round with no day lands on the first working day; chained, nested and touching closures resolve to the first open day; a landing day that is itself in a SKIP closure makes the visit SKIP; closures that overlap with different modes resolve to SKIP.

## 4. The nightly job (generation), per plan

Runs once per night per tenant, and also from `POST /rounds/:id/generate-visits` (same function). Unchanged parts: only ACTIVE plans of ACTIVE rounds; only when `nextDueDate <= today`; at most one visit per plan per run; skip if the plan has a SCHEDULED or IN_PROGRESS visit dated today or later; skip while a future-dated pause window covers the visit date; a created visit queues the `visit.scheduled` event and fires the usual side effects.

New parts, in this order, for a plan with `N = nextDueDate <= today`:

1. `V0 = visitDateFor(N)`; `r = resolve(V0)`. (Catch-up: `N` may be in the past; `resolve` still applies every loaded closure that covers `V0`, so the visit lands on the first open day after the closure even if that day is itself already past; past-dated catch-up visits are existing behaviour.)
2. **SKIP**: create nothing, queue nothing. `N = nextDue(V0)`. If `N <= today` re-evaluate from step 1 (still no visit created for a skipped cycle); stop when `N > today` or a visit has been created. Write `nextDueDate = N`. Log one activity row per closure per run with the number of skipped cycles.
3. **KEEP or MOVE(X)**: apply the **served-cycle guard** (4.1). If the cycle is served: `N = nextDue(V0)` and go back to step 1. Otherwise create the visit on `X` (`V0` for KEEP, `M` for MOVE), then `N = nextDue(V0)` (**from the original `V0`, not from `X`**) and write `nextDueDate = N`. Stop.

**Writing `nextDueDate`** (ruling 2026-11-16): whenever the loop changed `N` (a cycle skipped, served, or a visit created), the final `N` is written back to the plan, including on a night where no visit was created, so the stored anchor and the calendar never go stale.

### 4.1 Served-cycle guard

**Pause windows** (existing rule A4) are checked against the **resolved** visit date (`V0` for KEEP, `M` for MOVE): no visit is created if the resolved date falls inside a pause window of the plan. Order of checks for a KEEP or MOVE result: (1) the served-cycle guard, then (2) the pause check; a pause hit creates nothing and does NOT advance `N` (existing behaviour), so the same cycle is re-evaluated the next night.

A cycle is **served** when the plan already has a non-cancelled visit (any status except CANCELLED, with `servicePlanId` equal to the plan) dated **on or after** the date this cycle's visit would have. The guard exists so a plan never gets two visits for one cycle and never gets a past-dated catch-up visit after its own moved visit. It also covers a visit pushed past its next cycle by carryover (example C2). One-off visits (`isOneOff = true`) are not plan visits and never count.

## 5. Calendar projection

Forecast entries (display only, never written) follow the **generation rule**, so the calendar shows what the job will do.

1. **Anchor, per plan (amended 2026-11-16 after the first real run).** The projection must follow what the nightly job will do, including for a plan whose stored `nextDueDate` is *stale* (on or before today while an open visit dated today or later, e.g. a moved or pushed one, still blocks generation). So the anchor is NOT clamped to today and NOT re-snapped from today. For each ACTIVE plan: start from its own `N = nextDueDate` and walk cycles exactly as generation does: `V0 = visitDateFor(N)`, `resolve(V0)`; a SKIP cycle is dropped (`N = nextDue(V0)`); a cycle whose resolved date is on or before the plan's **latest non-cancelled, non-one-off visit date** (any date, including past ones and the blocking future one) is **served** and dropped (`N = nextDue(V0)`); the first surviving cycle is the plan's first forecast. Only that first forecast date is then clamped up to today when it is in the past (overdue catch-up display). The round's series starts from the plan whose first forecast is earliest and continues with the generation rule (original raw dates, never the moved date); PAUSED plans with a `pauseEndDate` contribute their resume day as before. One-off visits (`isOneOff`) never count as real or served. It does **not** start from the dates of existing visits (the pushed-visit defect, example P1). Worked examples: P1, P4 and the new P7 and P8 below.
2. For each cycle: `V0 = visitDateFor(N)`; `resolve`; SKIP drops the entry and advances `N = nextDue(V0)`; KEEP or MOVE gives an entry on its date and then `N = nextDue(V0)` (original, not moved). A cycle whose resolved date is on or before the previous entry's date is served and produces no entry (the same guard).
3. **Real wins** (unchanged): a date that already has real visits is real; no forecast at or before the latest real date in the series.
4. **Caps** (unchanged): at most 4 entries per round counting real and forecast together; none later than 13 weeks after the earliest of the first upcoming real visit date and the first forecast date (the horizon base is unchanged from today's behaviour). "First forecast date" means the first forecast entry actually EMITTED, after closures are applied (so in example P3 the base is 2027-01-25, not the skipped raw cycle 2026-12-28); only inside the requested window (90-day cap); only ACTIVE rounds.
5. Forecasts never create rows.

**Equivalence requirement** (an e2e invariant): for any state, every forecast date equals the date on which the nightly job, run on each day in turn, later creates a visit for that plan; and the job creates no visit on a day the calendar did not forecast, within the forecast window.

## 6. Apply to existing visits

Selection for closure `K`: visits with `status = SCHEDULED`, `isOneOff = false`, `date` inside `[K.startDate, K.endDate]` and `date >= today`, whose round is in `K`'s scope. Nothing else is touched: IN_PROGRESS, COMPLETED, SKIPPED, CANCELLED, one-off (including complaint re-cleans) and other-round visits are left alone. Visits with no round are never selected.

For each selected visit dated `x`: `r = resolve(x)` using **all** applicable closures (not only `K`).

- **MOVE(M)**: group by `(from = x, to = M)` and call the existing carryover core once per group (reminder markers reset, queued messages for the old date cancelled, `carriedOverFromDate` and `carryoverCount` updated, technician conflicts reported, one activity row with `via: "closure"`). **The plan's `nextDueDate` is not written.** The served-cycle guard (section 4.1) prevents a duplicate later.
- **SKIP**: status `SKIPPED`, `skipReason = K.label`, queued messages cancelled, one activity row. `nextDueDate` untouched.
- If `r` is `KEEP` (because a different closure no longer covers the day, or the closure was shrunk): untouched.

Then: technician notification (once per technician), customer notification only when ticked (once per customer, best effort, never fails the move), `appliedAt` set. Re-running selects only what is still inside the window, so it is idempotent. `preview` is the same computation with no writes. A target on a past day or an already closed day is refused the same way carryover refuses it (`CARRYOVER_TARGET_CLOSED` 409): **the whole apply is refused atomically** (one transaction, nothing moved), not just the offending group (ruling 2026-11-16).

## 7. Warnings (never block)

When a visit is moved by `reschedule` or `carryover` (and when the carryover options are listed), a target date covered by a closure that applies to the visit's round produces `{ code: "DATE_IN_CLOSURE", closureId, label, startDate, endDate }`. One-off visits get the warning too. The status code is unchanged.

## 8. Worked examples (exact dates; the oracle, the helpers and the scenarios must all reproduce these)

Calendar facts: 16 Nov 2026 is a Monday. Christmas closure `XMAS` = 2026-12-24 (Thu) to 2027-01-03 (Sun), MOVE, all rounds. Working days Monday to Friday unless stated. `*` marks a moved visit. "Visits" are the visit dates the nightly job creates for one plan in order. "Next due after" is the plan's `nextDueDate` once the last listed visit exists.

### 8.1 Baselines, no closures (regression: identical to today's behaviour)

| ID | Setup | Visits |
|---|---|---|
| A1 | 4-weekly, Monday round, N = 2026-11-16 | 2026-11-16, 12-14, 2027-01-11, 02-08, 03-08, 04-05 |
| A2 | 6-weekly, Monday round, N = 2026-11-16 | 2026-11-16, 12-28, 2027-02-08, 03-22 |
| A3 | 8-weekly, Tuesday round, N = 2026-11-17 | 2026-11-17, 2027-01-12, 03-09 |
| A4 | 12-weekly, Friday round, N = 2026-11-20 | 2026-11-20, 2027-02-12 |
| A5 | 4-weekly, no round day, Mon to Fri, N = Sat 2026-11-21 | 2026-11-23, 12-21, 2027-01-18, 02-15, 03-15, 04-12 |

### 8.2 Closures in generation

| ID | Setup | Visits |
|---|---|---|
| B1 | XMAS, 4w Monday round, N = 11-30 | 11-30, **01-04\***, 01-25, 02-22, 03-22, 04-19 (the cycle after the move is 25 Jan, not 1 Feb: anchor kept) |
| B2 | XMAS, 4w **Thursday** round, N = 12-03 | 12-03, **01-07\***, 01-28, 02-25, 03-25, 04-22 |
| B3 | XMAS as **SKIP**, 4w Monday, N = 11-30 | 11-30, 01-25, 02-22, 03-22, 04-19 (skipped cycle: 12-28) |
| B4 | XMAS, 4w, **no round day**, Mon to Fri, N = 11-30 | 11-30, **01-04\***, 01-25, 02-22, 03-22, 04-19 |
| B5 | XMAS, 4w, no round day, Mon to **Sat**, N = Sat 12-26 | **01-04\***, 01-23, 02-20, 03-20, 04-17 (the anchor stays on Saturdays) |
| B6 | XMAS, 4w, no round day, working days **Tue to Sat**, N = Sat 12-26 | **01-05\*** (Monday is not a working day), 01-23, 02-20, 03-20, 04-17 |
| B7 | XMAS (ends Sun 01-03), 4w Monday, N = 12-28 | **01-04\***, 01-25, 02-22, 03-22, 04-19 |
| B8 | closure 12-24 to **Mon 01-04**, 4w Monday, N = 12-28 | **01-11\*** (the closure covers the first Monday), 01-25, 02-22, 03-22, 04-19 |
| B9 | **5-week** closure 12-14 to 2027-01-18, MOVE, 4w Monday, N = 12-14 | **01-25\***, 02-08, 03-08, 04-05 (the 01-11 cycle is served by the 01-25 visit: collapsed) |
| B10 | same closure as **SKIP** | 02-08, 03-08, 04-05 (skipped cycles: 12-14, 01-11) |
| B11 | XMAS (MOVE) plus SKIP 01-02 to 01-10, 4w Monday, N = 12-28 | 01-25, 02-22, 03-22, 04-19 (landing day 01-04 is SKIP, so the cycle is skipped: 12-28) |
| B12 | XMAS plus MOVE 01-04 to 01-10 (chained), 4w Monday, N = 12-28 | **01-11\***, 01-25, 02-22, 03-22, 04-19 |
| B13 | one-day closure Mon 12-28 (MOVE), Monday round, N = 12-28 | **01-04\*** (a whole week), 01-25, 02-22, 03-22, 04-19 |
| B14 | same, **no round day**, Mon to Fri | **12-29\*** (next working day), 01-25, 02-22, 03-22, 04-19 |
| B15 | one-day closure Tue 12-29, Monday round, N = 12-28 | 12-28 (not covered), 01-25, 02-22, 03-22, 04-19 |
| B16 | closure Mon 12-14 to Mon 12-21, Monday round, N = 12-14 | **12-28\***, 01-11, 02-08, 03-08, 04-05 |
| B17 | XMAS, 6w Monday, N = 12-28 | **01-04\***, 02-08, 03-22 |
| B18 | XMAS, 12w Monday, N = 12-21 (the Monday before it starts) | 12-21 (not covered), 2027-03-15, 06-07 |
| B19 | XMAS, 4w Monday, N = 2027-01-11 (closure already ended before the cycle) | 01-11, 02-08, 03-08, 04-05 (closure does not cover the cycle) |
| B20 | XMAS (MOVE), 4w Monday, N = 12-28, the job was down and first runs on 2027-01-10 (after the closure ended) | one visit created on 01-10 dated **2027-01-04** (moved, past-dated like any catch-up), next due 2027-01-25; no visit dated inside the closure |

### 8.3 Carryover and the served-cycle guard (no closures)

| ID | Setup | Result |
|---|---|---|
| C1 | 4w Monday, N = 11-16; the 11-16 visit is carried over to Wed 11-18 | next visits: 12-14, 2027-01-11 (the carryover does not move the cycle: Mike's rule) |
| C2 | 4w Monday, N = 12-14, but the plan already has a visit pushed to Wed 12-16 | 12-17: the 12-14 cycle is served by the 12-16 visit (guard) so no catch-up visit; next visits: 2027-01-11, 02-08 |

### 8.4 `resolve` table (pure function; unit-test every row)

Round day or "none"; working days Mon to Fri unless stated; closures as stated (XMAS unless otherwise noted).

| ID | Input `V0` | Result |
|---|---|---|
| R1 | Mon round, no closure, Mon 12-21 | KEEP 12-21 |
| R2 | Mon round, XMAS, Mon 12-28 | MOVE 2027-01-04 |
| R3 | Thu round, XMAS, Thu 12-24 (first closed day) | MOVE 2027-01-07 |
| R4 | Thu round, XMAS, Thu 12-31 | MOVE 2027-01-07 |
| R5 | Fri round, XMAS, Fri 2027-01-01 | MOVE 2027-01-08 |
| R6 | Sun round, XMAS, Sun 12-27 | MOVE 2027-01-10 (the round day is not checked against working days) |
| R7 | no round day, XMAS, Mon 12-28 | MOVE 2027-01-04 |
| R8 | no round day, working days Tue to Sat, XMAS, Sat 12-26 | MOVE 2027-01-05 |
| R9 | Wed round, XMAS, Wed 2027-01-06 | KEEP 01-06 |
| R10 | Wed round, XMAS, Wed 12-23 | KEEP 12-23 |
| R11 | Sat round, XMAS, Sat 01-02 | MOVE 2027-01-09 |
| R12 | Mon round, XMAS as SKIP, Mon 12-28 | SKIP |
| R13 | Mon round, XMAS MOVE + SKIP 01-04 only, Mon 12-28 | SKIP (the landing day is covered by a SKIP closure) |
| R14 | Mon round, XMAS + MOVE 01-04 to 01-17, Mon 12-28 | MOVE 2027-01-18 |
| R15 | Mon round, two identical XMAS closures, Mon 12-28 | MOVE 2027-01-04 |
| R16 | Mon round, MOVE 12-24 to 01-10 containing MOVE 12-28 to 12-30, Mon 12-28 | MOVE 2027-01-11 |
| R17 | Mon round, closure 12-24 to Mon 01-04, Mon 12-28 | MOVE 2027-01-11 |
| R18 | Mon round, one-day closure Mon 12-28, Mon 12-28 | MOVE 2027-01-04 |
| R19 | a chain of more than 400 back-to-back closures | throws `CLOSURE_RESOLUTION_LIMIT` |
| R20 | round-scoped closure that does not include this round, Mon 12-28 | KEEP 12-28 |

### 8.5 Projection

Real-visit and forecast rules as in section 5. `today` is given per row.

| ID | Setup | Calendar |
|---|---|---|
| P1 | **Pushed-visit defect.** 4w Monday round, one plan with `nextDueDate` 2026-12-14, its one upcoming real visit pushed to Tue 2026-11-17, today 11-17, no closure | real 11-17; forecast **12-14, 2027-01-11, 02-08** (4 entries). Today's code wrongly gives 12-21, 01-18, 02-15 |
| P2 | XMAS MOVE, 4w Monday, plan N = 12-28, today 12-01 | forecast **01-04**, 01-25, 02-22, 03-22 |
| P3 | XMAS as SKIP, same plan | forecast 01-25, 02-22, 03-22, 04-19 (the skipped cycle removed, the cap admits the next) |
| P4 | 5-week MOVE closure 12-14 to 01-18, 4w Monday, plan N = 12-14, today 12-01 | forecast **01-25**, 02-08, 03-08, 04-05 |
| P5 | closure that has ended before the forecast window | no effect |
| P6 | round-scoped closure | forecast changes only for that round |
| P7 | **Stale anchor, MOVE collapse.** 4w Monday round, closure 2026-12-14..2027-01-18 MOVE, plan N=12-14; after the 12-14 night the plan has the visit on 2027-01-25 and `nextDueDate` 2027-01-11 (stale until 01-25 passes). Read on 2027-01-27 | forecast **2027-02-08**, 03-08, 04-05, 05-03 (four entries: the 01-25 visit is already past on 01-27, so it uses no cap slot; the 01-11 cycle is served by it; never 02-01 or 03-01) |
| P8 | **Stale anchor, pushed visit (C2).** 4w Monday round, plan N=2026-12-14 with a SCHEDULED visit pushed to Wed 2026-12-16; read on 2026-12-14 | real 2026-12-16; forecast **2027-01-11**, 02-08, 03-08 (the 12-14 cycle is served by the 12-16 visit; never 12-14 or 12-21) |

### 8.6 Apply to existing visits

Visits already exist: Monday round visit on 12-28, Thursday round visit on 12-31, no-day round visit on 12-29, all SCHEDULED, plus others.

| ID | Case | Result |
|---|---|---|
| Ap1 | XMAS MOVE | Monday round 12-28 to **01-04**; Thursday round 12-31 to **01-07**; no-day round 12-29 to **01-04**; a visit on 12-23 and one on 01-04 untouched; all plans' `nextDueDate` unchanged |
| Ap2 | XMAS SKIP | the three visits become SKIPPED with `skipReason = "<label>"`, queued reminders cancelled |
| Ap3 | an IN_PROGRESS visit on 12-24, a COMPLETED visit on 12-27, a one-off visit on 12-28, a complaint re-clean on 12-30, a visit of a round outside the closure's scope | all untouched |
| Ap4 | preview with 20 visits for the Monday round on 12-28 | one group `{ from: 12-28, to: 01-04, count: 20 }`, not 20 rows |
| Ap5 | apply twice | the second run changes nothing |
| Ap6 | closure extended by a week after apply, then apply again | only the visits now inside the extension move |

### 8.7 Warnings

| ID | Case | Result |
|---|---|---|
| W1 | reschedule a visit to 12-30 with XMAS | 200 with `warnings: [{ code: "DATE_IN_CLOSURE", ... }]`, visit moved |
| W2 | reschedule to 01-05 | 200, no `warnings` field |
| W3 | carryover whose target is inside a closure | warning, move done |
| W4 | round-scoped closure and a visit of another round | no warning |

## 9. Invariants every implementation must satisfy

The e2e simulator checks these on every run of the grid (backend plan section 11.3):

1. No plan visit is dated on a day covered by an applicable closure.
2. Every plan visit is on its round's day, or on a working day when the round has none (carried-over and rescheduled visits excepted).
3. With no closures, visit dates equal the pure cycle from the start (examples A1 to A5).
4. With MOVE, the cycle after a move returns to the original anchor dates (B1, B2).
5. `nextDueDate` only changes by whole cycles.
6. At most one non-cancelled plan visit per plan per date, and at most one open visit per plan.
7. SKIP arithmetic: visits created = cycles in the period minus the skipped ones.
8. Projection equals generation (section 5).
9. The job is idempotent within a day; apply is idempotent; preview equals apply.
10. Projection and preview write nothing.
11. Untouched means untouched (section 6).
12. Nothing can hang the job (`CLOSURE_RESOLUTION_LIMIT`).
