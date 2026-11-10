# Flo AI frontend contract (2026-11-10)

Backend handoff: `docs/handoff/backend/2026-11-10-flo-ai-backend.md`. Plan: `docs/FLO_AI_PLAN_2026-11-10.md` (repo root `docs/`). **Breaking changes: none** (new endpoints only). The web app was built against this contract with MSW fixtures and has not yet been run against the real backend.

## Rules the frontend relies on

- All six endpoints are **ADMIN only**. A MANAGER or TECHNICIAN gets 403 `ADMIN_ONLY` (hide the nav item, show the admin-only note).
- `POST /flo/chat` is a **stream** (`text/event-stream`). Use `fetch` and read the body; `EventSource` cannot POST or send the bearer token. Send `Authorization` and `Content-Type: application/json`, and a fresh `Idempotency-Key` per send.
- Errors **before** the first byte are normal JSON `{ error, code, ... }`. Errors **after** it arrive as an `error` event.
- Render everything as **plain text**. Never render HTML or markdown from the model, and never follow a URL the model produced; links come only from the closed `link.screen` enum.
- Do **not** announce each streamed sentence to a screen reader. Announce statuses politely and the finished answer once.
- Money is decimal GBP. `format: "percent"` values are already percentages (96.4 means 96.4%).

## Endpoints

| Method and path | Response |
|---|---|
| `GET /flo/status` | `{ enabled, modes: [{ key, label, description }], dailyRemaining }` |
| `GET /flo/suggestions` | `{ groups: [{ area, questions: string[] }] }` |
| `POST /flo/chat` | SSE stream (below). Body `{ conversationId?, message (1..2000), mode: "THOROUGH"\|"BALANCED"\|"QUICK" }` |
| `GET /flo/conversations?cursor=&limit=` | `{ conversations: [{ id, title, updatedAt }], nextCursor }` (limit default 30, max 100) |
| `GET /flo/conversations/{id}` | `{ id, title, messages: [] }` |
| `DELETE /flo/conversations/{id}` | 204 |

Messages in `GET /flo/conversations/{id}`: a USER message is `{ id, role: "USER", text, createdAt }`. An ASSISTANT message is the final message below. ERROR and ABORTED messages carry `status` and `errorCode`.

## Final message (the `done` event, and ASSISTANT items in GET)

```json
{
  "id": "clx...", "role": "ASSISTANT", "mode": "THOROUGH", "model": "claude-opus-5-5",
  "status": "OK", "createdAt": "2026-11-10T09:12:44.000Z",
  "declined": null,
  "answer": {
    "intro": "Here is October so far across your 3 active technicians and 10 rounds.",
    "introUnverified": false,
    "dateRange": { "from": "2026-10-01", "to": "2026-10-30", "label": "1 to 30 Oct 2026" },
    "blocks": [
      { "type": "cards", "items": [ { "label": "Jobs completed", "value": 781, "format": "integer", "sub": "of 810 scheduled (96.4%)", "tone": "neutral" } ] },
      { "type": "table", "title": "Performance by technician", "sourceId": "r2",
        "columns": [ { "key": "technician", "label": "Technician", "format": "text", "align": "left" },
                     { "key": "revenue", "label": "Revenue", "format": "currency", "align": "right" } ],
        "rows": [ { "technician": "James Carter", "revenue": 5460.00 } ],
        "totals": { "technician": "Total", "revenue": 13650.00 },
        "link": { "screen": "REPORTS", "params": { "period": "thisMonth" } } } ],
    "insights": [ { "text": "Liam Walsh had the most skips (14).", "unverified": false } ],
    "followUps": [ "Show the Round 7 skipped properties" ],
    "sources": [ { "id": "r1", "tool": "compare_technicians", "label": "Technicians", "rows": 3 } ],
    "truncated": false
  },
  "warnings": []
}
```

- `status`: `OK | ERROR | DECLINED | ABORTED`. A declined message has `answer: null` and `declined: { reason, text, suggestions }`.
- Column `format`: `text | integer | currency | percent | date`. `align`: `left | right`.
- `link.screen` is one of `TODAYS_WORK | ROUND | CUSTOMERS | DEBT_PAYMENT | REPORTS | COMPLAINTS | TECHNICIANS | INVOICES`. Cards blocks can carry a `link` too. **Insights carry no link** (the answer grammar has none). Honour only the `round`/`roundId`, `date` and `visitId` params; other screens link to the bare route.
- `answer.introUnverified` and `insights[].unverified` mark sentences whose figures could not be matched to the data. `warnings` may contain `UNVERIFIED_FIGURES`.

## SSE events

Wire format: `event: <name>` then one `data: <json>` line, a blank line between events; `: ping` comment lines (at open and every 15 s) are heartbeats to ignore.

| Event | Data | Notes |
|---|---|---|
| `start` | `{ conversationId, messageId, mode }` | `messageId` is the assistant message id that `done` and `GET` will use |
| `status` | `{ phase: "checking"\|"checked", tool, label, rows? }` | drives "Checking…" then "Checked N data sources" |
| `block` | `{ index, block }` | a finished cards or table block, in order |
| `text` | `{ target: "intro"\|"insight", index, text, unverified?: true }` | one sentence; `index` is the 0-based position **within its target** (intro sentences and insights are indexed separately) |
| `follow_ups` | `{ items }` | up to 3 |
| `declined` | `{ reason, text, suggestions }` | out of scope, write request, capability question, unsafe. Calm copy, not an error. Followed by `done` with `status: "DECLINED"` |
| `warning` | `{ code: "UNVERIFIED_FIGURES" }` | |
| `done` | `{ message }` | **replace streamed state with this**, so the view equals a reload |
| `error` | `{ code, message, retryable }` | stream ends after it |

Order: `start`, `status` pairs, intro / blocks / insights as produced, `follow_ups`, `warning`, `done`. Unknown events and block types must be ignored safely.

**Dropped stream:** if the connection ends before `done`, call `GET /flo/conversations/{id}` once and find the assistant message whose `id` equals `start.messageId`. If present, show it; otherwise show a retryable error. Do not leave a half answer looking complete.

**Idempotency:** the same `Idempotency-Key` replays the stored result (`start`, `done`, header `Idempotent-Replay: true`); while the first is still running a second request gets 409 `FLO_REQUEST_IN_PROGRESS`.

## Error codes

| Where | Code | Meaning | Intended copy |
|---|---|---|---|
| 400 | `INVALID_MESSAGE` | empty, over 2000 chars, bad mode | inline field error |
| 400 | `INVALID_IDEMPOTENCY_KEY` | malformed key | generic retry |
| 401 | (existing) | session expired | existing refresh-and-retry |
| 403 | `ADMIN_ONLY` | not an admin | admin-only note |
| 404 | `FLO_CONVERSATION_NOT_FOUND` | not the caller's | start a new chat |
| 409 | `FLO_REQUEST_IN_PROGRESS` | same key still running | show message |
| 429 | `RATE_LIMITED` | per-admin limiter (`Retry-After`) | existing copy |
| 429 | `FLO_DAILY_LIMIT` | tenant cap, body has `resetsAt` | "Flo has reached today's limit. It resets at midnight." |
| 429 | `FLO_DECLINE_LIMIT` | too many declined messages | "Flo can only help with your RoundFlow data." |
| 503 | `FLO_UNAVAILABLE` | key unset or kill switch | "Flo is not switched on for this account" |
| `error` event | `FLO_PROVIDER_ERROR` | AI service failed or overloaded | "Flo could not reach its AI service, try again" |
| `error` event | `FLO_TIMEOUT` | 90 s budget | "That took too long, try Balanced or Quick" |
| `error` event | `FLO_NO_ANSWER` | no valid answer | "Flo could not answer that, try rephrasing" |
| `error` event | `FLO_INTERNAL_ERROR` | unexpected | generic retry |

## Fixtures

The recorded example, declined and error streams the frontend uses are in `roundflow-frontend/src/test/flo-fixtures.ts` (`toSse()` serialises them) and the MSW handler is `src/test/msw/handlers/flo.ts`. If this contract changes, update them so the frontend tests fail loudly.
