# Flo AI backend handoff (2026-11-10)

Scope: the admin-only, read-only, streaming AI assistant ("Flo AI") from `FloAI.pdf`. Plan: `docs/FLO_AI_PLAN_2026-11-10.md` (repo root `docs/`). Frontend contract: `docs/handoff/frontend/2026-11-10-flo-ai-frontend-contract.md`. All work is **uncommitted**. **Nothing was applied to any database** and **the real Anthropic API was never called** (tests use scripted fakes). `roundflow-e2e` was deliberately not touched.

## 1. Not done yet (read first)

| Item | Status |
|---|---|
| `npm run prisma:generate` and `npm run build` | Could not finish on the dev machine: a running dev server (`tsx src/index.ts`) locks the Prisma engine DLL (EPERM). Types were generated earlier and `tsc --noEmit` and `tsc -p tsconfig.build.json --noEmit` are clean. Stop the dev server, then run `npm run prisma:generate` and `npm run build`. |
| Live eval against the real API | **Not written, not run.** The plan's `flo.live.test.ts` (red-team and golden thresholds, cost and latency numbers) is outstanding. The guardrail fixtures it needs exist (section 6). Until it has been run, **the classifier and system prompts are unproven first drafts.** |
| Streaming through AWS | Not checked. Verify the stream is not buffered on the deployed path (section 9). |
| Frontend against this backend | The frontend was built against fixtures only. Do one manual pass with a real key. |
| e2e | Deferred by the owner. |
| Cumulative token cap | Only a per-call `maxTokens` per mode exists, no total across tool rounds. The round cap and the 90 s budget bound a request. |
| Migration | `20261110100000_flo_ai` is not applied; it ships with the normal deploy (startup runs `migrateAllTenantSchemas`). |
| App `types.gen.ts` | Left stale on purpose (section 10). |

## 2. Migration (additive, idempotent)

`prisma/tenant/migrations/20261110100000_flo_ai`: `FloConversation` (id, profileId, title, createdAt, updatedAt) and `FloMessage` (role, mode, model, text, answer JSON, toolCalls JSON, warnings, token counts, durationMs, status `OK|ERROR|DECLINED|ABORTED`, declineReason, errorCode), with indexes. Code that writes these fails on an un-migrated tenant, so migrate with or before the release. No rollback needed (new tables only).

## 3. Environment variables

| Var | Default | Notes |
|---|---|---|
| `ANTHROPIC_API_KEY` | unset | Recommended (in `RECOMMENDED_ENV_VARS`). Unset = Flo disabled: `GET /flo/status` says `enabled:false`, `POST /flo/chat` answers 503 `FLO_UNAVAILABLE`. Never logged. |
| `ANTHROPIC_BASE_URL` | SDK default | Optional mock or proxy. |
| `FLO_ENABLED` | `true` | Kill switch. |
| `FLO_MODEL_THOROUGH` / `_BALANCED` / `_QUICK` | `claude-opus-5-5` / `claude-sonnet-5-5` / `claude-haiku-5-5` | Change a model without a code deploy. |
| `FLO_MODEL_SCOPE` | `claude-haiku-5-5` | Scope classifier. |
| `FLO_DAILY_LIMIT_PER_TENANT` | `100` | **Platform-owned.** Answered questions per tenant-local day. Tenants cannot see or change it; they only see `dailyRemaining`. |
| `FLO_DECLINE_LIMIT_PER_DAY` | `30` | Declined messages per admin per day (capability replies excluded). |
| `RATE_LIMIT_FLO_PER_MIN` | `20` | Per admin profile. |
| `FLO_TIMEOUT_MS` | `90000` | Whole-request budget. |
| `FLO_RETENTION_DAYS` | `90` | Purge job. |

Dependency added: `@anthropic-ai/sdk` pinned to `1.3.0`. `createLimiter` in `lib/rate-limit.ts` gained an optional `keyGenerator`.

## 4. Endpoints (all ADMIN only)

`GET /flo/status`, `GET /flo/suggestions`, `POST /flo/chat` (SSE), `GET /flo/conversations?cursor=&limit=` (default 30, max 100; cursor is the last conversation id), `GET /flo/conversations/{id}`, `DELETE /flo/conversations/{id}`. They are in `ADMIN_ONLY_ROUTES`, `ROLE_MATRIX` (ADMIN) and `src/swagger.ts` (no schema `default` values; literal paths before the templated one). A MANAGER or TECHNICIAN gets 403 `ADMIN_ONLY`. Conversations are scoped to the calling admin; another admin's id is 404.

`POST /flo/chat` body `{ conversationId?, message (1..2000), mode: THOROUGH|BALANCED|QUICK }`, optional `Idempotency-Key`. The key is claimed inside `flo.service.ts` as `flo:<profileId>:<key>` (not through the idempotency middleware). A replay streams `start` (plus `declined` when applicable) and `done`, with header `Idempotent-Replay: true`; a second request while the first runs is 409 `FLO_REQUEST_IN_PROGRESS`.

Headers: `Content-Type: text/event-stream`, `Cache-Control: no-cache, no-transform`, `X-Accel-Buffering: no`, `Connection: keep-alive`. Frames are `event:` + one `data:` JSON line. `: ping` is sent at open and every 15 s.

### SSE events as implemented

| Event | Data |
|---|---|
| `start` | `{ conversationId, messageId, mode }` (`messageId` is the assistant message id used in `done` and in `GET`) |
| `status` | `{ phase: "checking"\|"checked", tool, label, rows? }` |
| `block` | `{ index, block }` (cards or table, built by the server from tool results) |
| `text` | `{ target: "intro"\|"insight", index, text, unverified?: true }`; `index` is 0-based within its target |
| `follow_ups` | `{ items }` (max 3) |
| `declined` | `{ reason, text, suggestions }`, followed by `done` with `status: "DECLINED"` |
| `warning` | `{ code: "UNVERIFIED_FIGURES" }` |
| `done` | `{ message }` (the persisted final message) |
| `error` | `{ code, message, retryable }` |

Order: `start`, `status` pairs, intro / blocks / insights as parsed, `follow_ups`, `warning`, `done`.

### Errors

Before the first byte (plain JSON): 400 `INVALID_MESSAGE`, 400 `INVALID_IDEMPOTENCY_KEY`, 404 `FLO_CONVERSATION_NOT_FOUND`, 409 `FLO_REQUEST_IN_PROGRESS`, 429 `RATE_LIMITED`, 429 `FLO_DAILY_LIMIT` (body has `resetsAt`), 429 `FLO_DECLINE_LIMIT`, 503 `FLO_UNAVAILABLE`. After the stream started (`error` event, persisted as ERROR): `FLO_PROVIDER_ERROR`, `FLO_TIMEOUT`, `FLO_NO_ANSWER`, `FLO_INTERNAL_ERROR`. Hitting the round cap while the model still wants tools is `FLO_NO_ANSWER`. A decline is a normal 200 stream, not an error.

## 5. How a question is answered

1. HTTP checks (auth, admin, validation, limiter, daily cap, decline cap, idempotency), then the stream opens.
2. **Scope gate** (`scope-gate.ts`): deterministic pre-checks (empty, over-long, code fences or HTML, prompt-extraction phrases) then a small Haiku classification with no tools. Verdicts `IN_SCOPE | OUT_OF_SCOPE | WRITE_REQUEST | CAPABILITY_QUESTION | UNSAFE`. Any error or odd output fails closed to `OUT_OF_SCOPE`. Anything other than `IN_SCOPE` makes **no main-model call and runs no tool**; the reply is fixed copy from `declines.ts`. Capability questions are answered from `SUGGESTION_GROUPS` and persisted as DECLINED with `declineReason CAPABILITY` (they do not count to the decline cap).
3. **Tool loop** (`orchestrator.ts`): last 10 turns of history (assistant turns as final text only), tools run in parallel, each result stored under a `sourceId` and returned to the model wrapped as untrusted data. Caps per mode (rounds 8 / 6 / 3, tokens per call, 90 s total).
4. **Streamed answer**: the model must answer in a closed tag grammar (`<intro>`, `<block>{json}</block>`, `<insight>`, `<follow_up>`). `stream-parser.ts` parses it incrementally; anything outside the tags is discarded. Cards and tables are **built by the server from stored tool results** (the model gives only `sourceId`, column keys and title). Prose is split into sentences, each is linted (`prose-lint.ts`: no URLs, markdown links, code, HTML, emails, phones, over-length) and figure-checked (`figure-check.ts`: every number must match a tool result, with dates, ranks, ordinals and times whitelisted) **before** it is sent. A failing figure check sends the sentence with `unverified: true`, adds the warning and sets `answer.introUnverified` for the intro (a streamed sentence cannot be retracted, so there is no repair turn).
5. Zero tool calls, or no valid content, becomes the fixed `NO_DATA_USED` decline.
6. Persist and send `done`. A client disconnect aborts the provider call and tools and persists ABORTED (not counted against the cap if nothing was emitted).

## 6. Tools (read-only, tenant client only, fixed column lists)

`get_day_overview`, `list_rounds_due`, `list_debtors`, `list_payments`, `compare_technicians`, `list_complaints`, `list_at_risk_customers`, `revenue_summary`, `list_skipped_visits`, `get_customer_summary` (`src/services/flo/tools/`). Money is **decimal GBP rounded to 2 dp**; `percent` columns hold percentages (12.5 = 12.5%). Rows are capped at 200 (`MAX_ROWS`), ranges at 366 days. Names, balances, dates, counts and round names go to the provider as-is (owner decision: no PII stripping). Secrets (bank details, payment tokens, API keys, auth and webhook secrets) are never in any tool result (snapshot test per tool).

Deviations from the plan: `get_day_overview`, `list_complaints`, `revenue_summary` and `list_payments` use small direct read queries because the existing services could not do it (the Today service only handles "today" and keeps its row builders private; `listComplaints` cannot sort by severity and uses the public Prisma client for `resolvedBy`). `list_debtors` uses `getBoard` (two pages per bucket), `compare_technicians` uses `computeTechnicianKpis`. `list_complaints` has a pseudo status `UNRESOLVED` (the default). `list_skipped_visits` also takes `roundName`. Cards `totals` may carry extra headline keys (`customers`, `rounds`, `payments`, `complaints`, `matches`, `skipped`).

### How to add a tool

1. New file in `src/services/flo/tools/` with a `ToolDefinition` (input validation, fixed columns, `MAX_ROWS`, read-only).
2. Register it in `tool-registry.ts` and update the allow-list snapshot test (a deliberate change).
3. Tests: happy path, empty, caps, bad input, the no-write Prisma fake, the no-secrets key snapshot.
4. Add a golden question to `guardrails.fixtures.ts`.
5. Add the file to `FLO_FILES` in `vitest.config.ts`.

## 7. Guardrails

Six layers (plan 3.8): pre-checks, scope gate, data only through tools, strict tag format with length caps, prose lint, fixed refusal copy. `guardrails.fixtures.ts` holds **75 red-team prompts in 15 categories, 43 golden questions and 3 capability questions**. `guardrails.test.ts` drives all of them through the real service and orchestrator with a scripted classifier; `guardrails.layers.test.ts` scripts a misbehaving main model (zero tools, free chat outside the tags, URL, code, invented tool, another tenant's id, unknown `sourceId`, an instruction injected through a round name) and proves each ends in a decline or a dropped sentence. To add a red-team prompt, add it to the fixtures; the tests pick it up.

Known limit: model text that appears before a `tool_use` in the same turn is released once tool results already exist. It still passes lint and figure check. It is documented, not a bypass of the format.

## 8. Quality gates

`FLO_FILES` in `vitest.config.ts` holds every new file at 100% line, branch, function and statement coverage per file. `bootstrap.ts`, `swagger.ts`, `permissions.ts` and `rate-limit.ts` stay at 100%. Last run on this machine: `tsc --noEmit` clean; full `npm run test:coverage` passed (216 files, 3589 tests, all gates); `npm run test:diff-coverage` OK (3923 changed lines in 33 files). The swagger contract and role-matrix tests pass. `floPurge` is registered in `bootstrap.ts` at `30 3 * * *` (cron labels now 9, calls 10 in `bootstrap.test.ts`). One line was added to `bootstrap.test.ts` `FULL_ENV` for `ANTHROPIC_API_KEY`.

## 9. Operations

- **Kill switch:** `FLO_ENABLED=false` (the page then shows "not switched on").
- **Raise a cap:** change `FLO_DAILY_LIMIT_PER_TENANT` and redeploy; it applies to every tenant. Per-tenant overrides are not built.
- **Rotate the key:** change `ANTHROPIC_API_KEY`, redeploy.
- **Change a model:** the `FLO_MODEL_*` vars.
- **Purge:** nightly `floPurge` removes conversations older than `FLO_RETENTION_DAYS`; one tenant failing does not stop the others.
- **Streaming check on AWS:** after deploying, ask a Thorough question and confirm status lines and sentences arrive progressively, not all at once. If buffered or cut off, check what sits in front of the backend: a load balancer's idle timeout (the 15 s heartbeat is there to stay under it), a CDN, or an API gateway layer, any of which can buffer or time out a long response. The app itself adds none (no `compression` dependency). The repo's older docs still say Railway; confirm the real deployment target.
- **Cost:** usage per message (input, output, cached tokens, duration, model) is in `FloMessage`. Cost per answer has not been measured with the real API yet.

## 10. Notes for other repos

- `roundflow-frontend`: built against fixtures; see the frontend contract and `roundflow-frontend/docs/2026-11-10-flo-ai-web.md`. It has `// TODO(types.gen)` types in `flo.api.ts`.
- `roundflow-app`: no Flo UI by design. Its generated `src/api/types.gen.ts` is **already stale versus swagger** (a few description lines and one extra 409, unrelated to Flo), so regenerating it would mix unrelated changes. It was left alone; app `tsc` and jest (41 suites, 516 tests) pass. Regenerate it in a pass of its own.

## 11. Not built (by design)

Writes of any kind, customer-facing agent, manager access, per-tenant cap overrides, resuming a dropped stream, CSV export, e2e scenarios, a mock Anthropic server.
