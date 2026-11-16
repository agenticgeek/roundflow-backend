# Business closures: parallel execution plan (2026-11-16)

**Status: PLAN ONLY. No agent has been started and nothing is implemented.** This is the how-and-in-what-order for the work specified in `2026-11-16-business-closures-backend-plan.md` and `docs/handoff/frontend/2026-11-16-business-closures-frontend-contract.md`. Where those documents disagree with this one on **where tests live**, this one wins (owner instruction, 2026-11-16): unit tests stay in `roundflow-backend` and `roundflow-frontend` (100% coverage gates); the scenario, simulation and browser layers live in `roundflow-e2e`.

Goal: finish as fast as the dependencies allow. Rule: **contracts first, then everything that can run in parallel runs in parallel.**

## 1. One decision needed before Phase 0 (blocks the e2e layer)

The e2e stack drives the real backend over HTTP and SQL. It cannot move the server's clock, and the code that matters reads the real "today": the nightly job (`tenantToday`), `generateVisitsNow`, and the planner projection. Without a way to set "now", e2e can only test dates that are in the real future or past relative to the actual day, so it **cannot** run a Christmas closure through generation, cannot walk two years of cycles, and cannot prove "projection equals generation".

| Option | What it takes | Consequence |
|---|---|---|
| **A. Guarded test hooks in the backend (recommended)** | Small product-code change: one `now()` helper replacing the three `new Date()` defaults (`business-time.ts`, `round.service.ts` line 971, projection), a request header `X-Test-Now: <ISO>` honoured per request, and a route to run the nightly tenant job at a given time. All three **inert unless** `ALLOW_TEST_CLOCK=1` **and** `NODE_ENV !== "production"`; only the e2e stack sets the flag. Covered by unit tests, including proof they do nothing without the flag. | Full exhaustive suite possible. Header is per request, so parallel workers and tenants cannot disturb each other (a global clock would break parallelism). Adds a little code that must never be reachable in production; the guard and its tests exist for that. |
| B. No product change | e2e shifts everything into the past with SQL back-dating, inserts closures by SQL, loops `POST /rounds/:id/generate-visits`. | Cannot test projection against generation, cannot test closures that are in the future (which is what real closures are), cannot test the nightly pause transitions. Does not meet the "exhaustive" requirement. |

The rest of this plan assumes **A**. If you choose B, Phase 0 item 7 and agent B4 disappear and the e2e invariants lose the projection and nightly-job checks.

## 2. Environment facts that shape the plan

- `roundflow-backend`, `roundflow-frontend`, `roundflow-app` are git repositories. `roundflow-e2e` is **not**: no diff, no rollback. Mitigation: copy `roundflow-e2e/specs`, `src` and `docs` to the scratchpad before Phase 1, give every agent a disjoint set of files, and never let two agents edit the same file.
- Agents never commit. The owner commits manually. Agents leave changes in the working tree and report the file list.
- `prisma generate` locks the engine DLL on this machine while a dev server runs (EPERM). **Only the coordinator runs `prisma generate`, once, at the end of Phase 0** and again if the schema changes. No agent runs it.
- The e2e stack is one Postgres (Docker, port 54329), one backend (3100) and one web (5173). Two agents must never start or reset it concurrently. Only the coordinator controls the stack. The fail-early rules apply (skill `e2e-run-fail-early`): health gate before and between suites, stop at the first sign of a degraded environment, reset and re-run once.
- E2E scratch tenants need Supabase dev auth users. Many scratch tenants at once risks dev-project rate limits and the health gate. The simulator therefore **seeds tenants with SQL** (the suite already has `tenantSql`) and reuses one tenant per scenario family rather than one per scenario.
- Existing e2e machinery to reuse, not rebuild: `domain("CLO", ...).S(id, title, meta, fn)` declarations in `specs/scenarios/*.spec.ts`, helpers in `src/scn/helpers.ts` (`scratchTenant`, `tenantSql`, `futureDay`, `addDays`, `dayCode`), `npm run catalogue` and `catalogue:check`, the report and demo-gate scripts, the `known-failing` mechanism. The CARRY spec already uses a **reference-implementation oracle** pattern; the closure suite uses the same idea.

## 3. Phase 0: contracts (serial, small, done by the coordinator; everything else waits for this)

Keep this phase short: it is the only serial stretch. Each item is a file so agents read it instead of asking.

1. **Preflight**: Docker up, `.env.regression` present, `npm run stack:health` green, one `npm run test:smoke` run to record a green baseline. Back up `roundflow-e2e/specs`, `src`, `docs`.
2. **Rules spec** `docs/handoff/backend/2026-11-16-closure-rules.md`: a decision table (inputs: due date, round day, working days, closures with modes and scopes; output: visit date or skip, and the next `nextDueDate`) plus **at least 40 worked examples with exact dates**. This is the single source of truth for the backend helpers, the e2e oracle and the unit tests.
3. **Schema**: the Prisma model and the migration SQL (section 3 of the backend plan), so the backend, the e2e SQL seeding and the tests agree on columns.
4. **Shared types** `closure.types.ts` (Closure, Preview, ApplyResult, warning shapes, error codes), copied verbatim into the frontend and e2e (no cross-repo imports).
5. **Swagger entries** for `/closures` and the new warning fields, so the frontend can generate types and the e2e API tests have a source.
6. **Frontend interface list**: names and signatures of the hooks and components (`useClosures`, `useCreateClosure`, ..., `ClosuresPanel`, `ClosureForm`, `ApplyPreviewDialog`, `ClosureWarning`) so the UI agent and the hook agent do not block each other.
7. **Test-hook contract** (option A): the flag, header name, route path and exact behaviour, and the inertness guarantee.
8. **E2E helper contract**: the signatures the scenario writers code against, for example `closureWorld({ rounds, plans, closures })`, `advanceTo(date)`, `runNightly(date)`, `calendar(from, to)`, `snapshotVisits()`, `oracle.expectedVisitDates(...)`, `checkInvariants(world)`.
9. **Registry and shared one-line edits made once**: register the `CLO` domains in `src/scn/registry.ts`; add `"closure"` to the `via` union in `carryover.service.ts`; add the planned files to the `vitest.config.ts` gated lists. This removes the shared-file conflicts later.
10. `prisma generate` once, then `npm run typecheck` to confirm the contract compiles.

Exit criterion: every Phase 1 agent can start from files alone.

### Phase 0 status (completed 2026-11-16) and deviations from the list above

Done: preflight (green baseline), rules spec (`2026-11-16-closure-rules.md`, 60+ worked examples), schema and migration, shared types, interface and helper contracts (`2026-11-16-closures-contracts.md`), shared one-line edits, `prisma generate` once, typechecks. Deviations:

- **Swagger entries (item 5)** were not written in Phase 0: the shared types file plus the endpoint tables in the contracts serve as the contract, and B3 owns the swagger change (it needs the real route code). The frontend uses the hand-typed `types.ts` until the backend is deployed and `generate:types` can run.
- **Backup (item 1)** was replaced by making `roundflow-e2e` a git repository with a baseline commit.
- **Port**: the e2e Postgres default port 54329 is inside a Windows reserved range on this machine; every e2e command must run with `E2E_PG_PORT=55600` (compose now honours it).
- **Rules corrections** found while writing the spec (no weekly frequency; the served-cycle guard; `nextDueDate` moves only by whole cycles) are recorded in rules section 0 and propagated to the backend plan.

## 4. Phase 1: parallel build (all start together, disjoint files)

Concurrency cap: about 8 agents at once (machine load and token spend), started in critical-path order: B1, B4, E1 first. Every agent gets: its file ownership list, the contract files, the rules spec, "do not touch other files", "no commits", "no `prisma generate`, no stack control", "100% unit coverage on your files, capped at 3 gap-filling rounds", and a one-paragraph report format.

| Agent | Repo | Owns (only these files) | Needs from Phase 0 | Delivers |
|---|---|---|---|---|
| **B1** closure helpers | backend | `lib/closures.ts` + test | rules spec | the pure helpers, 100% covered |
| **B2** projection anchor fix | backend | `services/round-projection.ts` + test | none | slice 1, reproduction test first |
| **B3** closures CRUD | backend | `routes/closures.ts`, closure service, `lib/permissions.ts`, role-matrix test entries, swagger finalise + tests | schema, types | slice 3 |
| **B4** test hooks (option A) | backend | `lib/clock.ts`, `services/business-time.ts`, `services/round.service.ts` (the `today` sites only), the guarded route, tests | hook contract | slice 0, with inert-in-production tests |
| **F1** frontend data layer | frontend | `api/closures.api.ts`, `features/closures/hooks/*`, `features/closures/lib/*`, `content/closures.ts`, `lib/query-keys.ts` (closures keys) + tests | types, interface list | hooks and pure lib at 100% |
| **F2** frontend UI | frontend | `features/closures/components/*`, the Settings panel wiring, calendar shading, reschedule and carryover warnings + tests | interface list (mocks hooks) | components at 100%, changed lines covered |
| **E1** e2e harness | e2e | `src/scn/closure-oracle.ts`, `closure-world.ts`, `closure-clock.ts`, `closure-invariants.ts` | rules spec, helper contract | oracle, builders, event-driven clock stepper, 11 invariants |
| **E2** `CLO-GEN` | e2e | `specs/scenarios/closures-generation.spec.ts` | helper contract, rules spec | scenarios 1 to 16 plus the grid simulation |
| **E3** `CLO-PRJ` | e2e | `closures-projection.spec.ts` | same | projection scenarios and "projection equals generation" |
| **E4** `CLO-APP` | e2e | `closures-apply.spec.ts` | same | apply and preview scenarios |
| **E5** `CLO-WRN` and `CLO-LIF` | e2e | `closures-warnings.spec.ts`, `closures-lifecycle.spec.ts` | same | warnings, lifecycle, calendar edges |
| **E6** `CLO-API` | e2e | `closures-api.spec.ts` | swagger, types | route, role and validation scenarios |
| **E7** `CLO-UI` | e2e | `closures-ui.spec.ts` | interface list, helper contract | Playwright web scenarios, a11y |

E2 to E7 write against the contract before the product code exists. That is deliberate: their specs are the red half of red-before-green, they compile and list (`npm run test:scenarios:list`), and they run for real in Phase 3.

Independent implementation guard: **E1 writes the oracle from the rules spec and must not read the backend implementation** (B1 is writing it at the same moment). Two independent implementations of the same rules compared on a large grid is what catches a rule that both would otherwise get wrong the same way.

## 5. Phase 2: backend integration (parallel, after B1 to B4 are in)

| Agent | Owns | Needs |
|---|---|---|
| **B5** generation and projection use closures (slice 4) | `jobs/visitGeneration.ts`, `services/round-projection.ts` | B1, B2 |
| **B6** apply and preview (slice 5) | `services/closure-apply.service.ts`, the apply routes | B1, B3 (uses the existing `carryOverVisits`; the `via` edit is already in) |
| **B7** warnings (slice 6) | `services/visit-reschedule.ts`, the carryover options, the visits route | B1 |

They own different files, so they run side by side. Frontend F2 can finish against the final warning fields as soon as B7 lands.

## 6. Phase 3: verification (the long pole; mostly e2e run time)

1. Coordinator: `prisma generate` and `npm run build` (dev server stopped), `typecheck`, full unit runs in backend and frontend with coverage, confirm every gated file is at 100%.
2. Coordinator: `npm run stack:up`, health gate, `npm run catalogue` then `catalogue:check`.
3. **Smoke first** (one worker): the closure smoke subset, to prove the stack and the hooks work before scaling.
4. **Scale**: run the closure spec files sharded across workers (`E2E_WORKERS`, start at 3 or 4 and watch the breaker and health gate; this repo has hit environment degradation before, hence the fail-early rules). API-layer files shard cleanly; `closures-ui.spec.ts` runs separately.
5. **Triage in parallel**: one agent per failing area decides *oracle bug, product bug or test bug*, with the actual and expected dates. Product bugs go to the matching Phase 1 or 2 owner. Findings are reported to the owner, never quietly "fixed by design". Cap: three fix-and-rerun rounds per area, then report.
6. **Break-it checks** (backend plan 11.6): each deliberate one-line break needs a backend restart, so run them in a **git worktree of the backend on the isolated second stack** (`journey:up`, separate state directory) in parallel with the main run, and revert every break.
7. Final gates: all catalogue rows PASS or listed as findings, the invariants pass across the whole grid, unit gates 100%, `typecheck`, `build`, full test runs.

## 7. Finish (after all testing is green, and only then)

1. `docs/ARCHITECTURE_LATEST.md` section 23 (per the owner's instruction).
2. The generated e2e docs (`npm run catalogue` regenerates `SCENARIO_CATALOGUE.md` and `MANUAL_DEVICE_CHECKLIST.md`) and `npm run report`.
3. The scenario catalogue results, the findings list, and the post-implementation handoff note.
4. A commit message of 150 characters or fewer per repo. No commit by me.

## 8. Why this is as parallel as it can be

- The only serial parts are Phase 0 (a handful of files) and the e2e run time in Phase 3.
- Backend, frontend and e2e authoring all start at the same moment because each works from the contract files, not from each other's code.
- Within the backend, Phase 2 is parallel because the three slices own different files.
- Anything that would collide is removed up front: shared edits are made once in Phase 0, `prisma generate` and the stack have a single owner, and e2e (no git) is protected by a backup plus strict file ownership.

## 9. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Two agents editing the same file | Explicit ownership table above; coordinator reviews the combined diff per repo before Phase 3 |
| e2e has no git history | Backup copy first; agents report changed files; no agent deletes existing specs |
| Prisma DLL lock, port clashes, stack reset mid-run | Single owner for `prisma generate` and the stack |
| Supabase dev rate limits and environment degradation | SQL-seeded tenants, few tenants, health gate, smoke before scale, fail-early rules, breaker |
| Oracle and implementation share the same bug | Independent authorship from the rules spec; E1 does not read B1's code |
| Test hooks reachable in production | Double guard (flag and `NODE_ENV`), unit tests that prove inertness, reviewed explicitly by the coordinator |
| Token and cost spend of about 14 agents | Concurrency cap of about 8; scenario writers are narrow, file-scoped tasks; stop early if the contracts turn out wrong rather than letting agents run on a bad contract |
| Contract wrong after agents start | Phase 0 exit criterion; any contract change is made once by the coordinator and broadcast, not patched locally by agents |
