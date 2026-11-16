# Flo AI v2: backend handoff (2026-11-17)

Source documents: `docs/FLO_AI_AUDIT_2026-11-17.md` (why), `docs/FLO_AI_V2_BUILD_SPEC.md` (contracts and ownership). Builds on `2026-11-10-flo-ai-backend.md`; read that first for the pipeline and guardrails, which are unchanged.

## 1. Status

| Check | Result |
|---|---|
| `tsc --noEmit` | clean |
| `npm run test:coverage` | 252 files, 4,251 tests, all per-file gates met (`FLO_FILES` extended) |
| `npm run test:diff-coverage` | OK, 3,497 changed lines in 42 files covered |
| Live eval against the real API | **Not run.** The prompts are still unmeasured. See section 9. |
| Migration `20261117100000_flo_feedback` | Written, **not applied to any database** |
| Commits | None. Everything is uncommitted for you to review. |

Run vitest from an **uppercase** drive path (PowerShell `Set-Location D:\...`). From a lowercase `d:` path every test file fails with "Vitest failed to find the current suite".

## 2. What changed

**Prompts (`system-prompt.ts`, `modes.ts`, `scope-gate.ts`, `declines.ts`)**
- Seven worked examples (single fact, ranked table, comparison using `calculate`, disambiguation, empty result, vague "how are we doing", chart), a business glossary (revenue = completed-visit value, not cash; debt buckets; carryover; strikes), routing for all 24 tools, and six multi-tool recipes including the **morning briefing** ("3 things that need you today").
- Rule 6 now says the model never does arithmetic: it uses pre-computed fields or the `calculate` tool.
- Insights are reframed as the recommended next thing to look at, naming the entity.
- Date anchors (yesterday, this/last week Mon to Sun, this/last month, quarter, year, next Monday) are precomputed in `buildFloContext` and printed in the context block.
- Modes have behaviour briefs (Thorough compares with the previous period and cross-checks; Quick is one fact) and a new `maxCharts` (2 / 1 / 0).
- Classifier: weather holds and impact on jobs are in scope; only general forecasts are out. "Give me my morning briefing" is the first suggestion.
- `buildSystemParts(ctx, mode)` returns `{ stable, dynamic }`. `stable` is the cached system block; `dynamic` (mode and date) goes as an uncached second block, so a new day or mode no longer busts the cache.

**Provider client (`client.ts`)**: `systemDynamic`, `toolChoice: "none"` (tools stay in the request so the cached prefix is stable), `thinking` and `temperature`. The 5.x models reject a custom temperature and already run adaptive thinking, so `modes.ts` sets neither; `supportsTemperature(model)` drops it for models that reject it, so it can never cause a 400. This corrects the audit, which suggested a low temperature.

**Orchestration (`orchestrator.ts`, `flo.service.ts`, `data-summary.ts`)**
- Last round forces an answer (`toolChoice: "none"` plus a "answer now, say what you could not check" note) instead of throwing the data away. `FLO_NO_ANSWER` only if that forced turn still has no valid content.
- Follow-ups keep their data: each answered turn stores `dataSummary` (tool, args, row count, first 5 rows of the first 6 columns, values cut to 60 chars, at most 6 sources) and the next turn receives it fenced as untrusted `<previous_data>`, capped at 2,400 characters per turn. Closing tags are defused at build and render time.
- Tool failures carry `kind: "validation" | "infrastructure"`. Infrastructure errors tell the model not to retry and to say that part could not be looked up.
- The model's own "I can't look that up yet." is persisted as `DECLINED` / `NO_DATA_USED`, like the no-data decline.
- `ToolContext.results` gives each tool the live map of this request's results (used by `calculate`).

**Answer builder (`answer.ts`, `figure-check.ts`)**
- Chart block, built from a stored result like tables (section 5).
- Auto deep links: the server attaches `link` from the tool when the model gave none (map in `AUTO_LINK_SCREEN`; `calculate` has none). A valid model link wins. Only `TODAYS_WORK` gets a param (`date`, single-day results). `roundId`/`visitId`/`period` are not auto-attached because the right id cannot be derived reliably.
- Figure check accepts a number that equals the sum, absolute difference, ratio, percent-of or percent-change of any two known result values (first 400 values; direct matches are not capped). Anything else is still flagged `unverified`.

## 3. Endpoints added (ADMIN only, in swagger, `ROLE_MATRIX` and `ADMIN_ONLY_ROUTES`)

| Method and path | Purpose |
|---|---|
| `POST /flo/messages/{id}/feedback` | Body `{ rating: "UP"\|"DOWN", comment?: string (<=500) }`. 204. 400 `INVALID_FEEDBACK`, 404 `FLO_MESSAGE_NOT_FOUND` (another admin's message, a USER message or unknown id). Re-rating overwrites both fields; a blank comment clears the old one. |
| `GET /flo/gaps?limit=` | `{ items: [{ question, at, reason: "NO_DATA_USED" }] }`, newest first, default 20, max 50, 400 `INVALID_LIMIT`. Whole business, not per admin. Rows with no preceding user text are skipped, so a page can be shorter than `limit`. |

The final message (`done` event and `GET /flo/conversations/{id}`) gains `rating: "UP" | "DOWN" | null` on every ASSISTANT message.

## 4. Schema

`20261117100000_flo_feedback` adds three columns to `FloMessage`, all `ADD COLUMN IF NOT EXISTS`: `rating TEXT`, `ratingComment TEXT`, `dataSummary JSONB`. Nothing else. It ships the same way as `20261110100000_flo_ai`. `npm run prisma:generate` was run locally to refresh `src/generated/tenant-client`.

## 5. Chart block

Model tag: `<block>{"type":"chart","kind":"bar","title":"...","sourceId":"r2","x":"technician","y":["revenue"]}</block>`. `kind` is `bar` or `line`; `y` is 1 to 3 distinct numeric columns (integer, currency or percent) not equal to `x`. Rejected with `UNKNOWN_SOURCE`, `UNKNOWN_COLUMN`, `INVALID` or `EMPTY`. Over 24 rows the first 24 are used. Limited by `mode.maxCharts`.

Built block (values come from the stored result, never the model):

```json
{"type":"chart","kind":"bar","title":"Revenue by technician","sourceId":"r1",
 "x":{"key":"technician","label":"Technician","format":"text"},
 "series":[{"key":"revenue","label":"Revenue","format":"currency"}],
 "rows":[{"technician":"James Carter","revenue":5460}],
 "link":{"screen":"TECHNICIANS"}}
```

## 6. Tools (24). Original eleven: derived metrics added; new thirteen

All read-only, fixed column lists, no secrets, provider ids, notes or message bodies. Existing keys and order are unchanged; new keys are appended. Descriptions of the original ten now have a "Do NOT use" line, a worked example and a field glossary.

**Existing tools, new fields**
- `get_day_overview`: `completionRate, valueAtRisk, behindBy, firstCompletedAt, lastCompletedAt`. No row scan (three `groupBy` calls). `behindBy` assumes an even pace across 08:00 to 17:00 local on today, all of a past day, none of a future day, because the schema has no scheduled times.
- `compare_technicians`: `completionRate, skipRate, avgJobValue, avgMinutesOnSite`; `compare: true` adds `previousJobs, previousRevenue, jobsChange, revenueChange, revenueChangePercent`. Rates count visits due up to today only.
- `list_debtors`: exact totals (one `invoice.groupBy` plus a `customer.count`): `customers, avgDaysOverdue, balanceNotOverdue, balance1To30, balance31To60, balance61To90, balanceOver90, shareOver30, shareOver60`. With a bucket, `minBalance` or `minDaysOverdue` the totals describe the scanned, filtered customers (stated in the description).
- `list_payments`: totals `paidAmount/Count, failedAmount/Count, dueAmount, collectionRate` and per method (`gocardless, stripe, cash, cheque, bacs` Amount and Count) from one `groupBy`.
- `list_complaints`: `issueType, upheld, resolvedAt, daysToResolve`; totals by severity and by technician (`byTechnician` is a "Name: n; Name: n" text list, so the figure check can still read the counts), `upheldRate`. These counts differ from `compare_technicians`' KPI definition (stated in the description).
- `list_skipped_visits`: totals `byReason, topReason, topReasonCount, byRound, topRound, topRoundCount`.
- `revenue_summary`: `groupBy` adds `DAY, WEEK` (Monday start), `SERVICE, CUSTOMER` (top 20), `PAYMENT_METHOD`; `compare: true` uses the same-length previous window (`compareFrom`/`compareTo` still win). All aggregates, so totals are exact.
- `get_customer_summary`: adds `planPrice, planFrequency, activePlans, paymentMethod, directDebitStatus, holdReason, openComplaints, lastPaymentDate, properties, lifetimeValue`. `directDebitStatus` is `gocardlessMandateStatus` (a state, never the mandate id).
- `list_rounds_due`, `list_technicians`: descriptions only.

**New tools**
| Tool | Columns (totals extras in brackets) |
|---|---|
| `get_business_snapshot` | one wide row (also in totals): `todayStops, todayCompleted, todaySkipped, todayRemaining, todayCompletionRate, monthRevenue, previousMonthRevenue, revenueChange, revenueChangePercent, totalOwed, customersOwing, owedOver30Days, shareOver30Days, openComplaints{High,Medium,Low,Total}, failedPaymentsCount, failedPaymentsAmount, customersSkippedTwice, visitsCarriedOver`. Ten parallel aggregate queries. Previous period = same days of last month, clamped. |
| `list_invoices` | `invoiceNumber, customer, amount, status, dueDate, daysOverdue, sentToCustomer, paidAt` (`invoices, draft/sent/paid/void Count and Amount` from an exact `groupBy`). Statuses: DRAFT, SENT, PAID, VOID. |
| `service_plan_health` | `group, plans, active, paused, cancelled, annualisedValue, averagePrice, nextResumeDate, overduePlans` (`cancellationsInPeriod, pausedWithoutResumeDate, monthlyRecurringValue`). `VISITS_PER_YEAR` = 13 / 8.67 / 6.5 / 4.33. `cancellationsInPeriod` is approximate (no cancel date; uses `updatedAt`). |
| `revenue_leakage` | `category, visits, value, detail`: six fixed non-overlapping categories plus "Total at stake". All aggregates. |
| `backlog_and_carryover` | `round, carriedOver, carriedOverValue, maxCarryovers, oldestCarriedFrom, pastDue, pastDueValue, oldestPastDue, daysBehind` (`rounds`). |
| `calculate` | `label, value`. Ops: `sum, difference, percent_change, percent_of, ratio, average, rank` over refs `{sourceId, path}`, `path` = `totals.<k>`, `rows.<i>.<k>` or `column.<k>`. No expression strings, no eval. `percent_change` = (a-b)/b*100 (a new, b baseline). `rank` = 1-based position of `b` among `a`'s values. Division by zero gives `value: null` plus a note row. Currency and integer are not mixed in `sum/average/difference/percent_change/rank`. |
| `round_performance` | `round, properties, stops, completed, skipped, scheduledValue, completedValue, completionRate, skipRate, revenuePerStop, avgMinutesOnSite, technicians` (`rounds`). |
| `technician_workload` | `kind, technician, stops, busiestDay, busiestDayStops, daysOff, offDetail, byDay` (`technicians`). Kinds: Technician, Unassigned, Round without technician. |
| `technician_incidents` | `technician, strikes, damageCount, damageAmount, upsellCount, upsellAmount, kpiAlerts, kpiAlertDetail` (`technicians`). |
| `list_messages_delivery` | `kind, channel, status, customer, date, count, credits` (`customers`). Never the message body. |
| `list_issues_photos` | `kind, label, count, date, customer, address`. There is no "damage" photo type (PROPERTY, BEFORE, AFTER, ACCESS_ISSUE only), so it reports photos awaiting review, photos on access issues and photos on complaints. |
| `forecast_schedule` | `weekStart, weekEnd, round, scheduledStops, projectedStops, stops, value, closure`. Rolling 7-day blocks from today, reuses `round-projection` (read-only, capped at 4 occurrences per round within 13 weeks), flags weeks overlapping a closure. |
| `closures_and_weather` | `kind, label, status, startDate, endDate, action, rounds, visits, condition, applied` (`closures, weatherHolds`). Weather holds are read from `ActivityLog` rows the weather-hold service writes (`entityId`, `createdAt`, `details` only, never the message). Default range 30 days back to 90 ahead. |

`list_at_risk_customers` (upgraded): adds `riskScore, signals, openComplaints, balanceOwed, daysOverdue, failedDirectDebits` and optional `minScore` (0 to 100). Score: skips 15 each (max 45), open complaints 15 each (max 30), overdue debt 5/10/15/20 by days, failed GoCardless payment in 60 days 15, messages opt-out 5, invalid email 5, capped at 100. Without `minScore` the list is as before; with it, the score filter replaces the skip filter. **Rows are now one per customer** (the property with the longest streak), not one per property.

## 7. Tests

New or extended: per-tool test files (each with a no-write run against a fake that throws on writes, a no-secrets key and canary check, empty result, bad input, timezone edge) for all 13 new tools and every changed tool; `answer-chart`, `figure-check-derived`, `data-summary`, `e1-helpers`, `e2-helpers`; orchestrator, service, route, migration, swagger and role-matrix tests for the new endpoints and the forced last round. The cross-tool `tools.safety.test.ts` keeps covering the original eleven in one shared fake world; the 13 v2 tools carry their own safety tests next to their code (stated in a comment there). The registry snapshot is now 24 tools. 21 new golden questions (`NEW_TOOL_GOLDEN_QUESTIONS`) run through the classifier pre-checks. `FLO_FILES` gained `data-summary.ts`, 13 tools and two helper files, all at 100% per file. Two unreachable branches were removed from `flo.service.ts` (an empty `dataSummary` on an answered row, a `declineReason` fallback the query already filtered).

## 8. How to add a tool (unchanged checklist, plus)

File under `services/flo/tools/`, name in `TOOL_NAMES` and `tool-registry.ts`, `FOLLOW_UPS_BY_TOOL`, an `AUTO_LINK_SCREEN` entry if it has a screen, a routing line in `system-prompt.ts`, a golden question, the no-write and no-secrets tests, and `FLO_FILES`.

## 9. Not done, and decisions for you

- **Live eval is still not run.** Everything above is proven by unit tests with scripted models. Prompt quality, latency, cost per answer and cache hits remain unmeasured. This is the highest-value next step (audit Q1). Check that `cachedTokens` in `FloMessage` is non-zero after the first two questions; the stable block must exceed the model's minimum cacheable size to help.
- Apply the migration through your normal tenant migration path before deploying.
- `compare_technicians.compare`, the new `revenue_summary.groupBy` values and the new tools are not yet in `FOLLOW_UPS_BY_TOOL` beyond the keys A added; tune after reading real answers.
- Left as audit items, not built: per-tenant cap overrides, resuming a dropped stream, a customer-facing agent, e2e scenarios (deliberately out of scope).
- `list_at_risk_customers` row shape change (one per customer) may affect any saved fixtures that assumed one row per property.
