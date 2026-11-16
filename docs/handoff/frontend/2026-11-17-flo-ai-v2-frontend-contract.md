# Flo AI v2: frontend contract (2026-11-17)

Breaking changes first: **none.** Every existing endpoint, event and field is unchanged. Additions only. Backend detail: `docs/handoff/backend/2026-11-17-flo-ai-v2-backend.md`. Builds on `2026-11-10-flo-ai-frontend-contract.md`.

## 1. New block type: `chart`

Arrives in the `block` SSE event and in `answer.blocks` of the final message, next to `cards` and `table`.

```json
{"type":"chart","kind":"bar","title":"Revenue by technician","sourceId":"r1",
 "x":{"key":"technician","label":"Technician","format":"text"},
 "series":[{"key":"revenue","label":"Revenue","format":"currency"}],
 "rows":[{"technician":"James Carter","revenue":5460},{"technician":"Liam Walsh","revenue":8190}],
 "link":{"screen":"TECHNICIANS"}}
```

- `kind`: `"bar"` or `"line"`. `series`: 1 to 3 entries, formats `integer | currency | percent`. `rows`: at most 24, each holding only the `x` key and the series keys. Cells may be `null`. A line chart over dates has `x.format: "date"` (`YYYY-MM-DD`).
- `link` is optional. An unknown block type must still be ignored safely (existing rule).
- A chart is a visual of numbers the server already verified; never compute or alter values in the client.

## 2. `link` on every block, now filled in by the server

`cards`, `table` and `chart` blocks carry an optional `link: { screen, params? }`. When the model gave none, the server adds one from the tool that produced the data. `screen` stays within the existing closed enum (`TODAYS_WORK | ROUND | CUSTOMERS | DEBT_PAYMENT | REPORTS | COMPLAINTS | TECHNICIANS | INVOICES`). Only `TODAYS_WORK` can carry `params: { date }`. Render with the existing `links.ts` mapping; never follow a URL.

## 3. Rating on the final message

Every ASSISTANT message (in `done` and in `GET /flo/conversations/{id}`) has `rating: "UP" | "DOWN" | null`. USER messages have no `rating`. Treat a missing field as `null`.

## 4. New endpoints (ADMIN only)

**`POST /flo/messages/{id}/feedback`**: body `{ "rating": "UP" | "DOWN", "comment"?: string }` (comment at most 500 chars). Returns **204, no body.** Errors: 400 `INVALID_FEEDBACK` (bad rating, non-string or over-long comment), 404 `FLO_MESSAGE_NOT_FOUND` (not an assistant message in the caller's own conversations), plus the usual 401/403. Re-rating overwrites. A blank or omitted comment clears the previous comment. The id is the assistant message id from the `done` event.

**`GET /flo/gaps?limit=`**: `{ "items": [{ "question": string, "at": "ISO date-time", "reason": "NO_DATA_USED" }] }`, newest first, default 20, max 50. 400 `INVALID_LIMIT`. Questions Flo could not answer, whole business. No UI is required; it is for the owner and for deciding what to build next.

## 5. Behaviour you must handle

- **A streamed intro can be replaced.** If the model's only content is "I can't look that up yet.", the intro may already have been sent as a `text` event before a `declined` event arrives. On `declined` or `done`, replace the streamed state (existing rule: `done` replaces everything).
- **Suggestions**: the first group is now "Today", and its first item is "Give me my morning briefing". Render the suggestions the server returns; do not hard-code them. A "Morning briefing" button simply sends that exact message.
- **Follow-ups** still come from the model (`follow_ups` event); the static list is only a fallback.
- **Row shapes of existing tools gained columns.** Table columns are declared in each block, so render from `columns`, never from assumed keys. `list_at_risk_customers` now returns one row per customer.

## 6. Fixtures

Update MSW and fixtures with: a final message containing a `chart` block and `rating: "UP"`, a recorded stream with a `chart` `block` event, a 204 handler for the feedback POST, and a suggestion group starting with the morning briefing.

## 7. Frontend must never

Render model-supplied HTML or URLs, compute or round chart values itself, announce every streamed sentence to a screen reader (unchanged), or treat a `declined` event as an error.
