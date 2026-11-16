# Business closures: frontend contract and plan (2026-11-16)

**Status: PLAN ONLY. Nothing is implemented and the backend endpoints do not exist yet.** Backend counterpart: `docs/handoff/backend/2026-11-16-business-closures-backend-plan.md`. The endpoint shapes there (section 4) are the contract; if either document changes a shape, change both.

Audience: the web developer. Web code is in `roundflow-frontend/`. Follow the existing patterns named below instead of inventing new ones.

## 1. What the user gets

A business (for example Mark's company) can record any closure: pick dates, give it any label ("Christmas", "Staff holiday", anything), choose what happens to scheduled work, and optionally tell customers.

- **Move**: visits due in the closure go to the round's own day after it. Each round keeps its own day (a Monday round goes to the first open Monday, a Thursday round to the first open Thursday).
- **Skip**: visits due in the closure are dropped for that cycle.
- The planner calendar shows closure days and forecasts that already respect the closure.
- A one-time "Apply to existing visits" step moves or skips visits that were already created before the closure existed, with a preview.
- Warnings appear when someone reschedules or carries over work into a closure. They never block.

Closures are not tied to any fixed list of types or reasons, and several can exist at once.

## 2. Contract (summary; the backend doc is authoritative)

Dates are `YYYY-MM-DD`. Roles: writes ADMIN and MANAGER; reads ADMIN and MANAGER. Errors use the existing JSON error shape with a `code`.

```ts
type ClosureMode = 'MOVE' | 'SKIP'
interface Closure {
  id: string; label: string; startDate: string; endDate: string
  mode: ClosureMode; notifyCustomers: boolean
  roundIds: string[]            // empty array = all rounds
  appliedAt: string | null; createdAt: string; updatedAt: string
}
```

| Call | Notes |
|---|---|
| `GET /closures?from=&to=` -> `{ closures: Closure[] }` | Default (no params): closures that end today or later. |
| `POST /closures` -> 201 `Closure` | Body: `label, startDate, endDate, mode, notifyCustomers?, roundIds?`. Errors: 400 `VALIDATION_FAILED`, `INVALID_CLOSURE_RANGE`, `UNKNOWN_ROUND`. |
| `PATCH /closures/:id` -> `Closure` | Any subset. 404 `CLOSURE_NOT_FOUND`. |
| `DELETE /closures/:id` -> 204 | Does not undo visits already moved or skipped. |
| `POST /closures/:id/apply/preview` -> `Preview` | No writes. Groups, not one row per visit. |
| `POST /closures/:id/apply` `{ notifyCustomers? }` -> `ApplyResult` | Send an `Idempotency-Key` header. 409 `CLOSURE_ENDED` if the window is in the past. |

`Preview`: `{ closureId, mode, totals: { visits, rounds, customers, technicianConflicts }, rounds: [{ roundId, roundName, visitCount, groups: [{ from, to /* null for SKIP */, count }] }], conflicts: [...], customerMessage }`.
`ApplyResult`: `{ closureId, mode, moved, skipped, conflicts, notifiedTechnicians, notifiedCustomers, customerNotificationError?, appliedAt }`. A `customerNotificationError` means the visits **were** changed but the message step failed: show it as a warning, not a failure (same handling as the existing carryover result).

Warnings on existing endpoints: `PATCH /visits/:id/reschedule` and `POST /visits/carryover` may return `warnings: [{ code: 'DATE_IN_CLOSURE', closureId, label, startDate, endDate }]`. The carryover options response may mark an option with `closure: { closureId, label }`. Treat both as optional.

Types: regenerate with `npm run generate:types` once the backend is deployed (it reads `/openapi.json` from the deployed URL). Until then hand-write the interfaces above in `src/api/closures.api.ts`, and replace them with the generated ones afterwards. Do not edit `src/api/types.gen.ts` by hand.

## 3. Work breakdown

Follow the repo's structure: API module in `src/api/`, hooks in `src/features/<area>/hooks/`, copy in `src/content/`, components in `src/components/`.

1. **API module** `src/api/closures.api.ts`: `closuresApi.list/create/update/remove/previewApply/apply`, modelled on `src/api/rounds.api.ts` (uses `api(...)` and `jsonRequest`).
2. **Hooks** `src/features/closures/hooks/useClosures.ts` (TanStack Query, same shape as `features/rounds/hooks/useRounds.ts`): `useClosures`, `useCreateClosure`, `useUpdateClosure`, `useDeleteClosure`, `useClosureApplyPreview`, `useApplyClosure`. Add `queryKeys.closures` to `src/lib/query-keys.ts`. After create, update, delete or apply, invalidate closures, planner occurrences, rounds, and today (use the existing `invalidateRounds` and `invalidateToday` helpers, and add an `invalidateClosures`).
3. **Pure helper** `src/features/closures/lib/closure-days.ts`: `closureForDate(date, closures, roundId?)` for the calendar banner and the inline warnings, so the UI does not depend on a round trip for that. Keep it pure so it is easy to test.
4. **Copy** `src/content/closures.ts`: all user-facing strings in one file, like `content/carryover.ts`. Includes plain explanations of Move and Skip (below) and the read-only default customer message shown in the preview.
5. **Settings screen**: a "Closures" section under Settings (`components/settings/SettingsScreen.tsx` holds the pattern; a separate panel component like `KpiThresholdsPanel.tsx` keeps it out of that big file). Contents:
   - List of closures (label, dates, mode badge, rounds "All rounds" or names, "Applied <date>" or "Not applied to existing visits").
   - Add and edit form in a modal: label, start date, end date, mode (radio group with the two explanations), "Apply to specific rounds" (default all), "Tell customers" checkbox (off by default, with help text), Save.
   - Delete with a confirm dialog that states it does not restore moved visits.
   - Row action "Apply to existing visits" opens the preview dialog.
6. **Apply preview dialog**: totals, per-round groups ("20 visits: Mon 28 Dec -> Mon 4 Jan"), technician conflicts, the customer message when notify is ticked, Confirm and Cancel. After confirm show the result summary; when `customerNotificationError` is set, show it as a warning line.
7. **Planner calendar** (`components/round-planner/RoundPlannerCalendar.tsx`, `RoundPlannerScreen.tsx`): fetch closures for the visible window with `GET /closures?from&to`; shade closure days and show the label (not colour alone, for accessibility). Forecast cards already arrive from the backend with closure rules applied, so no client-side date maths is needed for them. Closure days must not count towards the "no visits in window" message or the unassigned-rounds alert (`features/rounds/hooks/useUnassignedRoundsAlert.ts`).
8. **Warnings**: an inline, non-blocking `role="status"` warning ("This date is inside <label>: <start> to <end>.") in `RescheduleVisitModal.tsx` and in the carryover choice (`components/todays-work/CarryoverChoice.tsx`), driven by the response `warnings` or `closure` marker, and by `closureForDate` while the user is still picking a date. Never disable the submit button because of it.
9. **Related, separate pieces that share this work**: item 4's free date picker for carryover should reuse `closureForDate` and the same warning component; item 5's "Generate visits now" button on the round detail panel calls the existing `roundsApi.generateVisits` (`useGenerateRoundVisits` already exists) and needs no closure code.

Copy for the two modes (draft, final wording is the owner's):
- Move: "Visits due during the closure move to the first open day for their round. The regular schedule carries on afterwards."
- Skip: "Visits due during the closure are skipped for that cycle. The next visit is the next regular one after it."
- Note shown under Move: "If the closure is longer than a customer's cleaning cycle, they get one visit after it, not one for each missed cycle."

## 4. What can start before the backend is ready

| Backend slice (see backend doc section 8) | Frontend work unlocked |
|---|---|
| 1 projection anchor fix | nothing needed in the web app; calendar simply becomes correct |
| 2 and 3 CRUD | items 1 to 5 above (list, form, delete) against a mock |
| 4 generation and projection | calendar shading (7) |
| 5 apply and preview | items 6 |
| 6 warnings | item 8 |

Build against fixtures or MSW-style mocks first (the Flo AI frontend was built the same way, see `2026-11-10-flo-ai-frontend-contract.md`), then do one manual pass against the real backend.

## 5. Accessibility and style

- The repo uses 24px minimum touch targets (`h-6 w-6` inputs, `min-h-6` labels) and axe checks in tests; match that.
- Radios in a `fieldset` with a `legend`, labels tied to inputs, dialogs trapping focus, errors in `role="alert"`, status text in `role="status"`.
- Dates shown with the existing formatter in `src/lib/round-dates.ts` (`formatShortDate`), not new date code.
- Closure days are marked with text and a pattern or icon as well as colour.

## 6. Tests: 100% coverage required

Target: 100% line, branch, function and statement coverage on every new or changed frontend file. The frontend uses Vitest and Testing Library with a per-file 100% gate: new whole files are added to the `AUDIT_REMEDIATION_FILES` list in `roundflow-frontend/vitest.config.ts` (thresholds `{ 100: true, perFile: true }`). Legacy files that only gain a few lines (`SettingsScreen.tsx`, `RoundPlannerCalendar.tsx`, `RescheduleVisitModal.tsx`, `CarryoverChoice.tsx`) are not gated whole; their changed lines must be covered and are checked by `npm run test:diff-coverage`. Check the exact script names in `roundflow-frontend/package.json` before relying on them. Cap gap-filling at 2 or 3 rounds per file and justify any unreachable branch.

Files to gate: `src/api/closures.api.ts`, `src/features/closures/hooks/useClosures.ts`, `src/features/closures/lib/closure-days.ts`, the closures panel, form modal, preview dialog and the shared warning component, and `src/content/closures.ts` if it holds logic (plain string objects need no test of their own but are exercised by the component tests).

Matrix:

`closure-days.test.ts`: no closures; date before, on first day, inside, on last day, after; empty `roundIds` covers all rounds; `roundIds` scoping; several closures overlapping returns the right one; invalid date input.

`closures.api.test.ts`: each call builds the right URL, method and body; query params for `from` and `to`; error propagation (follow `api/email-settings.api.test.ts` for the pattern).

`useClosures.test.tsx`: list, create, update, delete, preview and apply success paths; cache invalidation of the right keys on each mutation; error and pending states; apply sends an idempotency key.

Closures panel: loading, empty, populated, and error-with-retry states; mode badge and "All rounds" versus named rounds; "Applied" versus "Not applied"; add flow; edit flow; delete confirm and cancel; role gating (technician sees nothing); form validation (empty label, end before start, over 366 days, past end date); server error codes mapped to messages; notify checkbox default off.

Preview dialog: totals and group rendering for MOVE and for SKIP (`to: null`); conflicts list; message shown only when notify is ticked; confirm calls apply once (double click ignored); `customerNotificationError` shows a warning and still reports success; `CLOSURE_ENDED` error; cancel closes without calling apply.

Planner calendar additions: closure days shaded with the label; none when there are no closures; closure over a window edge; closure day does not trigger the "no visits" message or the unassigned alert; axe clean with a closure present.

Reschedule modal and carryover choice: warning shown for a date inside a closure from the response and while picking; hidden otherwise; submit stays enabled; warning is announced (`role="status"`).

Also: `npm run typecheck`, lint and the full test run green.

## 7. Open items

1. Final wording of the Move, Skip and default customer messages (owner, later).
2. Whether the closures section lives under Settings or gets its own item in the planner area; defaulted to Settings.
3. Maximum look-ahead for the item 4 date picker (about 60 days proposed, confirm with Hamza).
4. Whether the apply preview should list individual properties on demand (not in the first version; groups only).

## 8. Scenario suite (added 2026-11-16)

Same rule as the backend (backend doc section 11): everything is tested exhaustively **before** any hand-off. Component and integration scenarios live in `roundflow-frontend` under Vitest and Testing Library. Browser end-to-end tests (the `CLO-UI` scenarios) are written in `roundflow-e2e` as `specs/scenarios/closures-ui.spec.ts` (owner instruction, later on 2026-11-16; see `2026-11-16-business-closures-execution-plan.md`). Unit and component tests stay in `roundflow-frontend`. Catalogue rows use IDs `CLO-UI-nnn` and go in the same scenario catalogue document as the backend rows (`docs/handoff/backend/2026-11-16-business-closures-scenario-catalogue.md`).

Scenarios to cover, each with exact expected rendering and requests:
1. Settings > Closures: loading, empty, one, many, error with retry; sorting by start date; ended closures hidden by default.
2. Create: every field, label at 80 characters and 81, end before start, range over 366 days, end in the past, all-rounds versus named rounds, notify default off, server errors for each code, double-submit ignored, the form keeps its input after a failed save.
3. Edit after apply (change dates, mode, scope): the "Applied" badge and the prompt to apply again.
4. Delete: confirm, cancel, the "does not restore visits" wording, error handling.
5. Apply preview and apply: MOVE and SKIP rendering, groups for a 500-visit round, zero visits, conflicts, message shown only when notify is ticked, confirm once, `customerNotificationError` shown as a warning with a success state, `CLOSURE_ENDED`, network failure with retry, idempotency key sent and reused on retry.
6. Roles: ADMIN and MANAGER see and use it; technician and anonymous do not.
7. Calendar: closure shading with a label (not colour alone), closure at window edges, several overlapping closures, a round-scoped closure shading only the relevant rounds, a closure day does not trigger the "no visits" message or the unassigned-rounds alert, forecast cards rendered at the backend's dates, filters unaffected, axe clean.
8. Warnings: the reschedule modal and carryover choice show the inline status for a date inside a closure (from the response and while picking), none outside, submit stays enabled, announced to screen readers, a round-scoped closure warns only for that round.
9. Data freshness: after create, edit, delete or apply, the calendar, today view and rounds lists refetch (assert the invalidated keys).
10. Dates: year end, leap day, month end and clock-change weeks render the correct day (the display code uses the existing formatter, no new date maths).
11. Resilience: slow and failing endpoints do not break the planner (closures are an overlay: if the closures request fails the calendar still renders).

Definition of done is the backend's: coverage gates at 100% on the files named in section 6, every catalogue row PASS, `typecheck`, lint and the full test run green, and a manual checklist (below) handed to the owner for the parts only a browser can show.

Manual browser checklist (written during slice 7, run by the owner, or by me if a dev server and browser are available): create a Christmas MOVE closure, see the shading, apply with a preview, confirm the visits moved in the planner; repeat with SKIP; reschedule into the closure and see the warning; delete the closure.
