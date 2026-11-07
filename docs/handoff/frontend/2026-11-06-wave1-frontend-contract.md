# Wave 1 API contract for web and app (2026-11-06)

For the web (`roundflow-frontend`) and technician app (`roundflow-app`). Backend detail: `docs/handoff/backend/2026-11-06-wave1-backend.md`.

After the backend deploys, regenerate types:

```
# in roundflow-backend
npx tsx -e 'import("./src/swagger.ts").then(m=>require("fs").writeFileSync("../roundflow-frontend/openapi.json",JSON.stringify(m.openApiDocument)))'
# in roundflow-frontend
npx openapi-typescript openapi.json -o src/api/types.gen.ts && rm openapi.json
# same idea for roundflow-app/src/api/types.gen.ts
```

## 1. Breaking or behaviour changes (read first)

| # | Change | Who | What to do |
|---|---|---|---|
| 1 | `PUT /rounds/:id/technicians` response has **three new required fields**: `visitsGenerated`, `overriddenVisits`, `nextVisitDate`. Existing fields are unchanged. | web | Update MSW handlers/types; show the result (see 3.1). |
| 2 | `POST /invoices` with `sendEmail: true` is now **`400 EMAIL_NOT_AVAILABLE`** (was silently ignored). | web | Do not send `sendEmail: true`; if a UI toggle exists, hide or disable it until native email ships. Map the code to "Email sending is not available yet." |
| 3 | `POST /mobile/visits/:id/photos`: `url`/`path` must start with `<tenantId>/visits/<visitId>/`. Anything else is **`400 INVALID_PHOTO_PATH`**. | app | The app already sends the `path` returned by `POST /mobile/visits/:id/photos/upload-url`, which satisfies this. A queued photo that fails with this code is permanently invalid (drop it, do not retry). |
| 4 | `GET /reports/export?type=` accepts only `visits`, `technicians`, `revenue`; anything else is **`400 INVALID_EXPORT_TYPE`**. CSV string cells that start with `= + - @` are now prefixed with `'` (so a cell may read `'=SUM(...)`). | web | No code change if the export dropdown only offers the three types. |
| 5 | Unknown URLs now return **`404 {error:"Not Found"}`** instead of 405. A known path with a wrong method is still 405 + `Allow`. | web/app | Treat 404 on a mistyped path as a client bug, not a missing record. |
| 6 | In production `/docs` and `/openapi.json` are closed unless `EXPOSE_API_DOCS=true`. | dev | Generate types against dev/local, not production. |
| 7 | Webhook endpoints can now answer 500/503 on internal failure (providers retry). | none | Informational. |

## 2. New error codes

| Code | Status | Endpoint | Show |
|---|---|---|---|
| `EMAIL_NOT_AVAILABLE` | 400 | `POST /invoices` | "Emailing an invoice on creation is not available yet." |
| `INVALID_EXPORT_TYPE` | 400 | `GET /reports/export` | "Unknown report type." |
| `INVALID_PHOTO_PATH` | 400 | `POST /mobile/visits/:id/photos` | App: discard the queued photo. |

## 3. Web

### 3.1 Round assignment result (FLOW-01/02/04)

```jsonc
// PUT /rounds/:id/technicians  (and ?dryRun=true)
{
  "roundId": "rnd_1",
  "allocation": [ /* unchanged */ ],
  "visitsUpdated": 6,        // future SCHEDULED visits restamped
  "visitsGenerated": 2,      // NEW: due visits created now (0 on dryRun / non-ACTIVE round / empty list)
  "overriddenVisits": 1,     // NEW: hand-assigned visits the restamp skipped
  "nextVisitDate": "2026-11-09" // NEW: earliest upcoming SCHEDULED visit, or null
}
```

UI guidance: after a real save show a toast/panel "N visits updated, M visits generated, next visit <date>". When `visitsUpdated + visitsGenerated === 0` warn clearly: if `nextVisitDate` is null, "No visits are scheduled for this round yet, so nothing will appear in the technician's app"; otherwise "Next visit is <date>". When `overriddenVisits > 0` add "N visits were assigned by hand and were not changed" with a link to the technician's Schedule. The dry-run preview can show the same three numbers (generated is always 0 there).

### 3.2 Admin notification centre (NOTIF-02, NOTIF-06)

Endpoints (ADMIN and MANAGER, caller's own rows only):

```jsonc
GET  /notifications?cursor=<nextCursor>
// 200
{
  "notifications": [
    { "id": "ntf_1", "type": "PAYMENT", "title": "Payment failed",
      "body": "A payment from Jane Doe failed.", "read": false,
      "createdAt": "2026-11-06T10:00:00.000Z",
      "data": { "customerId": "cus_1" } }   // data may be null
  ],
  "unreadCount": 3,          // all unread, not just this page
  "nextCursor": "ntf_30"     // null on the last page
}
GET  /notifications/unread-count   // { "unreadCount": 3 }  (poll every 30 s, pause while the tab is hidden, refetch on focus)
POST /notifications/:id/read       // { "ok": true }
POST /notifications/read-all       // { "ok": true }
```

`type` values and where to link (use `data`):

| type | data keys | Link target |
|---|---|---|
| `CHAT` | `roundId` | chat thread of the round |
| `ACCESS_ISSUE` | `visitId`, `propertyId`, `roundId?` | property / visit |
| `SCHEDULE` | `visitId`, `propertyId`, `roundId`, `date` | planner or Today's Work for that date (skipped visit) |
| `DAY_CLOSED` | `date` | Today's Work for that date |
| `PAYMENT` | `invoiceId?`, `customerId` | invoice or customer / debt |
| `COMPLAINT` | `customerId`, `propertyId?` | complaints queue |
| `INVITE` | none | team settings |
| `KPI_ALERT` | none (existing producer) | technician KPIs |

Accessibility (NOTIF-06): announce the unread count on the bell (live region), real buttons in a labelled list, do not auto-dismiss. Keep the emergencies bell as a separate high-priority item.

Chat grouping: the office gets at most one `CHAT` notification per round per 5 minutes while the previous one is unread, so do not expect one per message.

### 3.3 Notification preferences (item 10)

Stored in `PATCH /auth/me/preferences` (shallow merge: send the whole `notifications` key):

```json
{ "notifications": { "categories": { "CHAT": false, "SCHEDULE": true } } }
```

`categories.<TYPE> === false` suppresses the **push only**; the in-app row is still created. Missing keys mean on.

## 4. Technician app

- `GET /mobile/notifications` rows now include `data` (same keys as above, or `null`). Use it for deep links from the list (APP-11) and to invalidate queries on receipt.
- The Expo push payload now carries the same object under `data` (`{ roundId?, visitId?, date?, ... }`). On receipt: invalidate `visits`, `schedule` (and `chat` for `type` CHAT).
- Technician-facing notifications you will now receive (inbox + push): round assigned / removed / schedule changed, visits assigned or moved off, visit rescheduled or cancelled (service paused, frequency change), weather hold, complaint revisit, payment hold placed/released on a customer with upcoming visits (type `PAYMENT`: the visit cannot be started while held).
- Inactive technicians and technicians without an accepted invite are skipped.
- Types now in use: `SCHEDULE`, `ROUND_UPDATE`, `CHAT`, `PAYMENT`, plus the existing `KPI_ALERT` (admins only).

## 5. Examples of notification titles (for copy and tests)

- `"3 visits assigned to you"` body `"Alnwick North: first visit 2026-11-09."` data `{roundId, date}`
- `"You have been added to a round"` / `"You have been removed from a round"` / `"Your schedule on a round changed"`
- `"Weather hold: 2 visits postponed"`, `"A visit was rescheduled"`, `"2 visits cancelled"`, `"Complaint revisit scheduled"`
- `"Payment hold: 1 visit on hold"`, `"Payment hold released: 1 visit"`
- Office: `"New message from Sam"`, `"Access problem reported"`, `"Visit skipped"`, `"<name> finished the day"`, `"Payment failed"`, `"Invoice paid"`, `"New complaint logged"`, `"Invite accepted"`

## 6. Migrations and env

One tenant migration, **not applied by this wave**: `20261106000000_notification_data_category` (adds nullable `Notification.data`, `Notification.category`). The backend must be deployed with it applied before the web or app relies on `data`. New env var: `EXPOSE_API_DOCS` (backend only).
