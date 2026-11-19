# One stop per property (backend)

Date: 2026-11-19. Branch: `integrate/live`.

Plan and contract: `../docs/PROPERTY_STOPS_PLAN_2026-11-19.md` (workspace root). §7 is the API contract the app and web code against.

## What changes

A **stop** is every visit with the same property, the same day and the same technician. Visits stay one per service; nothing is stored for the stop itself.

| Area | Before | After |
|---|---|---|
| Completion | One visit, one payment, one invoice, one message | `services[]` on `PATCH /mobile/visits/:id/complete` completes or skips every service in one transaction: one payment for the total, one invoice with a line per service, one message |
| Skipped service | n/a | `SKIPPED` with its reason; the plan's `nextDueDate` is untouched (next cycle); one office notification lists the skipped services |
| Invoices | Exactly one implied line | `InvoiceLine` rows; an invoice made before this change has no lines and renders as before |
| Billing group | n/a | The anchor visit (the first done one) plus `Visit.billedWithVisitId = anchor`. `createInvoice(visitId)` invoices the group |
| Reminders | One per visit | One per stop, naming the services; dropped only when no service in it is still SCHEDULED |
| "Visit completed" message | One per visit | One per stop; `{{services}}` reads "window clean and gutter clear" |
| Mobile rows | Per visit | Per visit plus `propertyId` and `stopKey`; `position` counts stops (siblings share it) |
| Mobile detail | Visit | Plus `stop { stopKey, leadVisitId, services[], price, grossTotal }`; `roundPosition` counts stops |
| Start / arrive | One visit | Every open visit in the stop; debt gate once |
| Skip | One visit | One visit, or the whole stop with `stop: true` |
| Counts | Visits | Stops: mobile rounds/completions/day, office `/today`, round today panel and planner |

Older app builds keep working: without `services` the completion is exactly as before, and a skip without `stop` skips one visit.

## Files

- New: `src/services/stops.ts` (key, order, status, where).
- Schema: `prisma/tenant/schema.prisma` (`InvoiceLine`, `Visit.billedWithVisitId`). Migration `prisma/tenant/migrations/20261119120000_property_stops/migration.sql` (idempotent).
- `src/services/visit-completion.ts` (`parseStopServices`, the stop path in `completeVisit`).
- `src/services/invoice.service.ts` (billing group, stored lines, preview, bulk).
- `src/mobile/services/{home,job-detail,job-tracker,day-close}.service.ts`, `src/mobile/routes.ts`.
- `src/jobs/preCleanReminders.ts`, `src/jobs/outboxWorker.ts`, `src/services/message-templates.ts` (`serviceList`, fallback bodies).
- `src/services/{round,today,customer}.service.ts` (office reads).
- `src/swagger.ts` (schemas above), then regenerate the web and app `types.gen.ts`.

## Tests (written before the code)

| File | Covers |
|---|---|
| `src/services/__tests__/stops.test.ts` | key, order, status, where |
| `src/services/__tests__/visit-completion.stop.test.ts` | parsing, every payment method, skips, ignored services, races, idempotency |
| `src/services/__tests__/invoice.service.stops.test.ts` | group invoices, VAT per line, legacy invoices, preview, render data, bulk |
| `src/mobile/__tests__/stops.mobile.test.ts` | row stop keys and positions, counts, start/arrive/skip |
| `src/mobile/__tests__/job-detail.stop.test.ts` | the `stop` block and position |
| `src/mobile/__tests__/routes.stops.test.ts` | route wiring for `services` and `stop` |
| `src/jobs/__tests__/preCleanReminders.stops.test.ts` | one reminder per stop |
| `src/jobs/__tests__/outboxWorker.stops.test.ts` | `{{services}}`, the reminder drain rule |
| `src/services/__tests__/office-stops.test.ts` | planner, round today panel, `/today` counts |
| `src/services/__tests__/customer-visits.stops.test.ts` | visit history invoice and payment for billed-together services |

Run from PowerShell with an upper-case drive letter: `Set-Location D:\VsCodeRepos\Roundflow\roundflow-backend; npx vitest run`.

## Deploying

- The migration only adds a table, a column and indexes. It runs on start-up like the others.
- Deploy the backend before the app build that sends `services`. The other order is also safe: an old server ignores `services` and completes the one visit.
- Existing tenant "Visit completed" and reminder templates keep their own text. Only the built-in fallbacks and new tenants use `{{services}}`.
