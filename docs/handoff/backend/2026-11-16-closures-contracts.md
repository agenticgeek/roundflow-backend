# Business closures: interface contracts (2026-11-16, Phase 0)

**Status: contract. Agents work from this file and `2026-11-16-closure-rules.md`; they do not ask each other.** If something here is wrong, stop and tell the coordinator; do not patch it locally. Related: backend plan (what), execution plan (how), rules (exact behaviour).

## 0. What Phase 0 already did (do not redo)

- Prisma model `BusinessClosure` and enum `ClosureMode` added to `prisma/tenant/schema.prisma`; migration `20261116100000_business_closures` written (not applied anywhere); tenant client generated once. **No agent runs `prisma generate`.** Backend `tsc --noEmit` is clean.
- Shared API types: `roundflow-backend/src/lib/closure-types.ts` is canonical and is copied byte for byte to `roundflow-frontend/src/features/closures/types.ts` and `roundflow-e2e/src/scn/closure-types.ts`. Change it only through the coordinator.
- `"closure"` added to the `via` union in `carryover.service.ts` (so slice 5 does not touch that file for it).
- `generateForTenant` is now exported from `jobs/visitGeneration.ts` (the test-hook route needs it).
- Coverage gates registered: `CLOSURE_FILES` in the backend `vitest.config.ts`, and the new frontend files in `AUDIT_REMEDIATION_FILES` in the frontend `vitest.config.ts`. The names below are the names those lists expect; use them exactly.
- e2e: domain code `CLO` added to `DOMAIN_ORDER` in `scripts/catalogue.ts`; `ALLOW_TEST_CLOCK=1` is set in the generated backend env by `scripts/stack.ts`; `docker-compose.yml` host port is overridable with `E2E_PG_PORT` (default unchanged).
- Baselines recorded in section 7.

## 1. File ownership (one owner per file; nobody edits a file they do not own)

### Backend (`roundflow-backend/`), tests beside each file as `__tests__/<name>.test.ts`

| Owner | File | Notes |
|---|---|---|
| B1 | `src/lib/closures.ts` | pure helpers (section 3) |
| B2 | `src/services/round-projection.ts` | anchor fix only (rules s5.1); closure logic is added later by B5 |
| B3 | `src/services/closure.service.ts`, `src/routes/closures.ts`, `src/lib/permissions.ts`, role-matrix test, `src/swagger.ts` (closure paths and schemas only), `src/server/bootstrap.ts` (mount `/closures` only) | CRUD, validation, errors |
| B4 | `src/lib/clock.ts`, `src/routes/test-hooks.ts`, `src/services/business-time.ts`, `src/services/round.service.ts` (the "today" reads only), `src/server/bootstrap.ts` (install the clock middleware and mount the guarded route only) | test hooks, section 2 |
| B5 | `src/jobs/visitGeneration.ts`, `src/services/round-projection.ts` (closure logic, after B2) | rules s4, s5 |
| B6 | `src/services/closure-apply.service.ts`, the apply routes in `src/routes/closures.ts` (after B3), `src/services/closure.service.ts` apply wiring | rules s6 |
| B7 | `src/services/visit-reschedule.ts`, `src/services/carryover.service.ts` (warnings only), `src/routes/visits.ts` | rules s7 |

`src/server/bootstrap.ts` and `src/routes/closures.ts` are touched by more than one owner in different phases (B3 and B4 first, B6 later). Phase 1 owners append to separate, clearly marked regions; the coordinator merges. Phase 2 starts only after Phase 1 for those files has landed.

### Frontend (`roundflow-frontend/`)

| Owner | Files |
|---|---|
| F1 | `src/api/closures.api.ts`, `src/features/closures/hooks/useClosures.ts`, `src/features/closures/lib/closure-days.ts`, `src/content/closures.ts`, `src/lib/query-keys.ts` (closures keys only) |
| F2 | `src/features/closures/components/ClosuresPanel.tsx`, `ClosureForm.tsx`, `ApplyPreviewDialog.tsx`, `ClosureWarning.tsx`, the Settings wiring in `src/components/settings/SettingsScreen.tsx`, calendar shading in `src/components/round-planner/RoundPlannerCalendar.tsx` and `RoundPlannerScreen.tsx`, warnings in `RescheduleVisitModal.tsx` and `src/components/todays-work/CarryoverChoice.tsx` |

### e2e (`roundflow-e2e/`)

| Owner | Files |
|---|---|
| E1 | `src/scn/closure-oracle.ts`, `src/scn/closure-world.ts`, `src/scn/closure-clock.ts`, `src/scn/closure-invariants.ts`, `tests/closure-oracle.test.ts` (unit tests of the oracle against the rules examples) |
| E2 | `specs/scenarios/closures-generation.spec.ts` |
| E3 | `specs/scenarios/closures-projection.spec.ts` |
| E4 | `specs/scenarios/closures-apply.spec.ts` |
| E5 | `specs/scenarios/closures-warnings.spec.ts`, `specs/scenarios/closures-lifecycle.spec.ts` |
| E6 | `specs/scenarios/closures-api.spec.ts` |
| E7 | `specs/scenarios/closures-ui.spec.ts` |

Scenario IDs: `CLO-GEN-nnn` (E2), `CLO-PRJ-nnn` (E3), `CLO-APP-nnn` (E4), `CLO-WRN-nnn` and `CLO-LIF-nnn` (E5), `CLO-API-nnn` (E6), `CLO-UI-nnn` (E7). Each spec file declares `const { S, M } = domain("CLO", "Business closures", "specs/scenarios/<file>.spec.ts")`. IDs are unique across the whole suite (the registry throws on a duplicate); sub-IDs use the example IDs from the rules document (for example `CLO-GEN-B1`, `CLO-PRJ-P1`, `CLO-APP-Ap4`), and grid cells append a short key (`CLO-GEN-GRID-4w-MON-xmas-move`).

## 2. Test hooks (option A)

Purpose: let e2e set "now" per request and run the nightly job on demand. **Inert in production.**

- **Flag**: active only when `process.env.ALLOW_TEST_CLOCK === "1"` **and** `process.env.NODE_ENV !== "production"`. Define once as `testClockEnabled()` in `src/lib/clock.ts`; every other check calls it.
- **`src/lib/clock.ts`**: `now(): Date` returns the request-scoped test time if one is set, else `new Date()`. `runWithClock<T>(at: Date, fn: () => T): T` (AsyncLocalStorage, so concurrent requests cannot affect each other). `testClockMiddleware`: when `testClockEnabled()` and the request has header `X-Test-Now` (an ISO instant), run the rest of the request inside `runWithClock`. An invalid value while enabled answers 400 `INVALID_TEST_NOW`. When **not** enabled the header is ignored without error and nothing changes.
- **Seam**: replace the `now: Date = new Date()` defaults in `tenantTodayRange` and `tenantToday` (`business-time.ts`) with `now()`, and the `new Date()` in `generateVisitsNow` (`round.service.ts`, the `today` read) with `now()`. Everything that already goes through `tenantToday` follows (nightly job, projection, carryover, reschedule, close day). B4 greps for any other "what day is it" read on the closure paths (`new Date()` used as a business date, not as a timestamp or duration) and either routes it through `now()` or lists it as a finding.
- **Route** `POST /test-hooks/run-nightly` (body `{ at?: ISO }`): mounted only when `testClockEnabled()`; otherwise the path does not exist (404, not 403). Requires the normal authentication and ADMIN role. It runs `generateForTenant(tp, tenantToday(tp))` for the **calling tenant only**, inside `runWithClock(at)`, and returns `200 { date: "YYYY-MM-DD" }`. It never loops over other tenants.
- **Tests (100%)**: with the flag unset or `NODE_ENV=production`: the header changes nothing (a visit generated through `generate-visits` uses the real today) and the route is 404. With the flag set: the header sets `today` for the nightly job, projection, carryover and reschedule; invalid header is 400; two concurrent requests with different `X-Test-Now` do not leak into each other; the route runs only the caller's tenant.
- The coordinator reviews this change explicitly before it merges.

## 3. Backend helper contract (`src/lib/closures.ts`, B1)

Pure, no I/O, no `new Date()` and no Prisma imports beyond types. Dates are UTC-midnight `Date`s.

```ts
import type { DayOfWeek } from "../generated/tenant-client";
import type { ClosureMode } from "./closure-types";

export interface ClosureWindow {
  id: string; label: string;
  startDate: Date; endDate: Date;           // inclusive, UTC midnight
  mode: ClosureMode;
  roundIds: readonly string[];              // empty = all rounds
}
export type ClosureResolution =
  | { action: "KEEP"; date: Date }
  | { action: "MOVE"; date: Date; closureIds: string[] }   // the closures that forced the move
  | { action: "SKIP"; closureId: string };                 // the SKIP closure that decided it

export const CLOSURE_RESOLUTION_LIMIT = 400;
export class ClosureResolutionLimitError extends Error {}  // message code: CLOSURE_RESOLUTION_LIMIT

export function closuresCovering(date: Date, roundId: string, closures: readonly ClosureWindow[]): ClosureWindow[];
export function resolveClosedDate(input: {
  visitDate: Date; roundId: string;
  defaultDay: DayOfWeek | null; workingDays: readonly string[];
  closures: readonly ClosureWindow[];
}): ClosureResolution;                      // rules s3
export function activeClosures(closures: readonly ClosureWindow[], today: Date): ClosureWindow[];  // endDate >= today
export function isServedCycle(candidateVisitDate: Date, latestPlanVisitDate: Date | null): boolean; // rules s4.1
export function advanceDueDate(dueDate: Date, visitDate: Date, input: { weeks: number; defaultDay: DayOfWeek | null; workingDays: readonly string[] }): Date; // rules s1 nextDue(V)
```
It must reproduce every row of rules sections 8.1 to 8.4. It must use the existing `visitDateFor`-equivalent (`nextOccurrenceOfDay`, `snapToWeekday` from `lib/schedule.ts`) and not re-implement them. `visitDateFor` is currently private to `visitGeneration.ts` and B1 does not own that file, nor `lib/schedule.ts`. So B1 builds an equivalent `visitDateFor(date, defaultDay, workingDays)` inside `closures.ts` from `nextOccurrenceOfDay` and `snapToWeekday`, and exports it. B5 later makes `visitGeneration.ts` import that one function, so there is a single definition.

## 4. Frontend interface contract (F1 and F2 code against this, not against each other)

```ts
// src/api/closures.api.ts (F1) — modelled on src/api/rounds.api.ts
export const closuresApi: {
  list(params?: { from?: IsoDate; to?: IsoDate }, signal?: AbortSignal): Promise<ClosureListResult>;
  create(input: ClosureCreateInput): Promise<Closure>;
  update(id: string, input: ClosureUpdateInput): Promise<Closure>;
  remove(id: string): Promise<void>;
  previewApply(id: string): Promise<ClosureApplyPreview>;
  apply(id: string, input?: ClosureApplyInput, idempotencyKey?: string): Promise<ClosureApplyResult>; // sends the Idempotency-Key header
};

// src/features/closures/hooks/useClosures.ts (F1)
useClosures(params?: { from?: IsoDate; to?: IsoDate }, enabled?: boolean): UseQueryResult<ClosureListResult, ApiError>;
useCreateClosure(): UseMutationResult<Closure, ApiError, ClosureCreateInput>;
useUpdateClosure(): UseMutationResult<Closure, ApiError, { id: string; input: ClosureUpdateInput }>;
useDeleteClosure(): UseMutationResult<void, ApiError, string>;
useClosureApplyPreview(): UseMutationResult<ClosureApplyPreview, ApiError, string>;          // a POST, so a mutation
useApplyClosure(): UseMutationResult<ClosureApplyResult, ApiError, { id: string; input?: ClosureApplyInput }>; // generates and reuses one idempotency key per attempt

// src/features/closures/lib/closure-days.ts (F1) — pure
closuresForDate(date: IsoDate, closures: readonly Closure[], roundId?: string): Closure[];
closureForDate(date: IsoDate, closures: readonly Closure[], roundId?: string): Closure | null; // the first by startDate

// src/lib/query-keys.ts (F1): queryKeys.closures = { all, list(params?) }; invalidateClosures(qc)
//   (create, update, delete and apply invalidate closures, planner occurrences, rounds and today)

// src/features/closures/components (F2)
<ClosuresPanel />                                                          // Settings section, ADMIN and MANAGER only
<ClosureForm closure?: Closure rounds: { id: string; name: string }[] onSaved(c: Closure): void onCancel(): void />
<ApplyPreviewDialog closure: Closure open: boolean onClose(): void />
<ClosureWarning warnings?: readonly ClosureWarning[] closure?: Closure | null />   // role="status", never disables a button

// src/content/closures.ts (F1): export const closuresContent = { ... } with every string used by F2 (keys agreed in the first PR; F2 imports, never inlines copy)
```
F2 mocks F1's hooks in tests (`vi.mock`), so it does not wait for F1.

## 5. e2e helper contract (E1 builds; E2 to E7 code against it)

```ts
// src/scn/closure-oracle.ts — independent implementation of rules s3-s6 (E1 must NOT read backend/src/lib/closures.ts)
export type DayCode = "MON"|"TUE"|"WED"|"THU"|"FRI"|"SAT"|"SUN";
export interface ClosureSpec { id?: string; start: IsoDate; end: IsoDate; mode: ClosureMode; roundKeys?: string[] }   // [] or undefined = all
export function resolve(i: { visitDate: IsoDate; roundKey?: string; day: DayCode|null; workingDays: DayCode[]; closures: ClosureSpec[] }): { action: "KEEP"|"MOVE"; date: IsoDate } | { action: "SKIP" };
export function simulatePlan(i: { start: IsoDate; weeks: 4|6|8|12; day: DayCode|null; workingDays: DayCode[]; closures: ClosureSpec[]; until: IsoDate; existingVisits?: IsoDate[] }):
  { visits: { createdOn: IsoDate; date: IsoDate; raw: IsoDate; action: "KEEP"|"MOVE" }[]; skipped: IsoDate[]; nextDue: IsoDate };
export function projectRound(i: { today: IsoDate; anchor: IsoDate; weeks: 4|6|8|12; day: DayCode|null; workingDays: DayCode[]; closures: ClosureSpec[]; realDates: IsoDate[]; windowFrom: IsoDate; windowTo: IsoDate }): IsoDate[];

// src/scn/closure-world.ts
export interface PlanSpec { key: string; nextDueDate: IsoDate; weeks?: 4|6|8|12; status?: "ACTIVE"|"PAUSED"; pause?: { start: IsoDate; end: IsoDate|null }; technicianKey?: string }
export interface RoundSpec { key: string; name?: string; day: DayCode|null; weeks: 4|6|8|12; plans: PlanSpec[] }
export interface ClosureWorldSpec { today: IsoDate; workingDays?: DayCode[]; rounds: RoundSpec[]; technicians?: { key: string }[] }
export function closureWorld(world: World, label: string, spec: ClosureWorldSpec): Promise<ClosureWorld>;   // ONE scratch tenant, SQL-seeded rounds, properties, plans; no per-scenario tenant explosion
export interface ClosureWorld {
  api: ApiClient; tenant: TenantHandle;
  roundId(key: string): string; planId(key: string): string;
  setNow(date: IsoDate): void;                       // virtual clock: every call below sends X-Test-Now for this date
  runNightly(date?: IsoDate): Promise<void>;         // POST /test-hooks/run-nightly at the virtual date
  generateNow(roundKey: string): Promise<{ visitsGenerated: number }>;
  createClosure(input: ClosureCreateInput): Promise<Closure>;
  updateClosure(id: string, input: ClosureUpdateInput): Promise<Closure>;
  deleteClosure(id: string): Promise<void>;
  previewApply(id: string): Promise<ClosureApplyPreview>;
  applyClosure(id: string, input?: ClosureApplyInput): Promise<ClosureApplyResult>;
  calendar(roundKey: string, from: IsoDate, to: IsoDate): Promise<{ date: string; projected?: boolean; stopCount: number }[]>;
  visits(filter?: { roundKey?: string; planKey?: string; status?: string }): Promise<VisitRow[]>;   // SQL snapshot: id, planKey, roundKey, date, status, isOneOff, skipReason, technicianId, carriedOverFromDate, carryoverCount
  planDueDate(planKey: string): Promise<IsoDate>;
  snapshot(): Promise<WorldSnapshot>;                // all visits and plan due dates, for invariants and "writes nothing" checks
  reschedule(visitId: string, date: IsoDate): Promise<ApiResponse>;
  carryover(body: { date: IsoDate; target?: string; targetDate?: IsoDate; visitIds?: string[]; notifyCustomers?: boolean; dryRun?: boolean }): Promise<ApiResponse>;
}

// src/scn/closure-invariants.ts
export function checkInvariants(ctx: { spec: ClosureWorldSpec; closures: ClosureSpec[]; before: WorldSnapshot; after: WorldSnapshot }): string[];  // the 12 invariants of rules s9; [] = pass
// src/scn/closure-clock.ts
export function eventDrivenDates(world: ClosureWorld, until: IsoDate): Promise<IsoDate[]>;   // the next interesting night(s): earliest plan due date, day after a visit date, plus sampled idle days; walks a simulated year in far fewer than 365 calls
```
Notes: E1 may add helpers but must keep these names and shapes. Seeding is by SQL through `tenantSql` (existing); closures are created through the API (not SQL) except the scenarios that need an already-ended closure, which insert by SQL. Virtual dates may be in the real future: that is the point of the clock.

## 6. Quality rules for every agent

- Own files only. Never edit another agent's file; ask the coordinator.
- No commits, no `prisma generate`, no stack start, stop, reset or health commands (coordinator only). e2e agents write and type-check (`npx tsc --noEmit`) and list (`npm run test:scenarios:list`); they do not run the stack.
- Backend and frontend agents run only their own tests (`npx vitest run <file>` and with `--coverage` for gated files). 100% line, branch, function and statement coverage on the files they own; at most three gap-filling rounds; report any branch that is truly unreachable instead of writing a contrived test.
- Do not weaken a test to get green. A failing expectation that looks like a rules problem is reported, with the actual and expected dates.
- Final report (short): files created or changed, tests added, coverage numbers, anything not done, anything surprising.

## 7. Baselines (recorded 2026-11-16, before any closures code)

- e2e static: `npm run test:unit` 14 of 14, `tsc --noEmit` clean, `catalogue:check` OK (1360 scenarios).
- e2e stack: healthy (`/health/ready` 200 in 159 ms, 7 of 2000 connections, 2 tenant schemas, 194 GB free). **`npm run test:smoke`: 52 passed, 2 skipped, 0 failed, 1m18s, no breaker trip.**
- The stack needed `E2E_PG_PORT=55600` on this machine: Windows reserves TCP 54325 to 54424, which contains the default 54329. Set `E2E_PG_PORT=55600` in the shell for every e2e command. (`docker-compose.yml` now reads it; the default is unchanged.)
- Backend `tsc --noEmit`: clean (with the generated closure model). Frontend `tsc -p tsconfig.app.json`: one **existing** error in `RoundPlannerDetailPanel.test.tsx` (`projected` missing); not caused by this work, do not fix it here unless the owner asks.
- Unit-test baselines: see section 8.

## 8. Unit-test baselines

- Backend `npx vitest run`: 219 files, 3641 tests passed, 47 s (run after the Phase 0 edits). Frontend `npx vitest run`: 131 passed (131) files, 841 passed (841) tests, 123.80s.
