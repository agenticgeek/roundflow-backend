# Wave 2A API contract for web and app (2026-11-06)

For the web (`roundflow-frontend`) and technician app (`roundflow-app`). Backend detail: `docs/handoff/backend/2026-11-06-wave2a-backend.md`. The new tenant migrations are **not applied**; use the new fields only after the backend deploys. Regenerate types after deploy as in the Wave 1 contract (`src/api/types.gen.ts` in both apps).

## 1. Breaking or behaviour changes (read first)

| # | Change | Who | What to do |
|---|---|---|---|
| 1 | `GET /invoices/preview` and the invoice render data: `business` is now an object with many fields (`phone`, `address`, `vatNumber`, `companyNumber`, `bank`, `paymentTerms`, `invoiceFooter`, besides `name`, `email`) and there is a new required `paymentReference`. | web | Update types and MSW handlers. Old consumers that read `business.name`/`email` keep working. |
| 2 | `POST /today/close` response has a new field `carriedToDate` (`YYYY-MM-DD` or null). `push_to_tomorrow` on a **Friday** defaults to **Monday**; pass `target: "SATURDAY"` for Saturday. An invalid `target` is `400 INVALID_CARRYOVER_TARGET` and nothing is closed. | web | Show the choice (see 3.2) before closing on a Friday. |
| 3 | Today's Work `kpi` and each `rounds[]` row have a new `carriedOver` count; `GET /invoices` rows have a new `overdue` boolean. | web | Update types. |
| 4 | Visit/stop rows and property DTOs gain `geocodePrecision` and `locationApproximate` (see 3.1). A pin is no longer always a postcode centre. | web, app | Treat `locationApproximate: true` as "approximate location". Do not rely on the old assumption that all properties in a postcode share a point. |
| 5 | Editing a property's **address line** (not only the postcode) now re-geocodes it and briefly resets `latitude`/`longitude` to null until the lookup finishes. | web | A freshly saved address can show "no location yet" for a moment; refetch later. |
| 6 | `GET /invoices?status=OVERDUE` is accepted (SENT and past due). | web | Use it for the overdue filter. |

## 2. New and changed error codes

| Code | Status | Endpoint | Show |
|---|---|---|---|
| `INVALID_CARRYOVER_TARGET` | 400 | `POST /visits/carryover`, `POST /today/close` | "That day is not available. Pick one of the offered days." |
| `CARRYOVER_TARGET_IN_PAST` | 400 | `POST /visits/carryover` | "The chosen day has already passed." |
| `CARRYOVER_TARGET_CLOSED` | 409 | `POST /visits/carryover` | "That day has already been closed." |
| `INVALID_BATCH_SIZE` | 400 | `POST /invoices/bulk-send`, `/preview` | "Select between 1 and 500 invoices." |
| `BATCH_NOT_FOUND` | 404 | `GET /invoices/bulk-send/:batchId` | "That send batch was not found." |
| `EMAIL_NOT_AVAILABLE` | 400 | `POST /invoices` with `sendEmail: true` | unchanged until Wave 2B |

Per-invoice result codes in a bulk batch (`results[].code`): `NO_CONTACT_FOR_CHANNEL`, `OPTED_OUT`, `INVOICE_NOT_SENDABLE`, `INVOICE_ALREADY_SENT`, `GHL_SEND_FAILED`.

## 3. What to build

### 3.1 Map and property pages (ACT-10, WEB-10/19)

New on every property/stop DTO that has `latitude`/`longitude`: `geocodePrecision` (`ROOFTOP` | `RANGE_INTERPOLATED` | `GEOMETRIC_CENTER` | `APPROXIMATE` | `POSTCODE_FALLBACK` | null) and `locationApproximate` (boolean). Where: `GET /customers` rows, `GET /customers/:id` (`property`, `tabs.overview`), `GET /properties/:id`, `GET /visits/:id`, round planner stops, today panel stops, the mobile today/schedule rows and the mobile visit detail `property`. When `locationApproximate` is true show "approximate location" on the pin and the property page; when `latitude` is null show "location not found" (no pin). Pins can still coincide, so keep the clustering work. No new env var for the web: the browser Maps key is unchanged.

### 3.2 Carryover (ACT-02..04)

1. `GET /visits/carryover/options?date=YYYY-MM-DD` returns `{ date, options: [{ key, date, label, default }] }`. Friday: two options (Saturday, Monday; Monday is `default`); other days: one (`NEXT_WORKING_DAY`). Render a radio group with `label`, preselect `default`, never offer Sunday.
2. Close day: send `POST /today/close { unfinishedAction: "push_to_tomorrow", target?: key }`. Show `carriedToDate` in the confirmation.
3. Move work without closing: `POST /visits/carryover { date, target, visitIds?, notifyCustomers?, dryRun? }`. Call it first with `dryRun: true` to show `moved`, `conflicts` (`TECHNICIAN_UNAVAILABLE` or `TECHNICIAN_INACTIVE`: link to reassign) and `skipped`; then confirm. `notifyCustomers` is an off-by-default checkbox ("Message customers", needs GHL; failures come back as `customerNotificationError` and do not undo the move).
4. Show a "Carried over from <date>" badge on rows where `carriedOver` is true (`carriedOverFromDate`): planner stops, today panel stops, the app Today and Schedule lists; the Today's Work rounds table can show the `carriedOver` count.
5. App: a carried visit arrives as a normal SCHEDULED visit on the new date with a `SCHEDULE` notification (`data.date`, `data.roundId`); refetch `visits` and `schedule` on receipt (APP-09).

### 3.3 Invoice details (GHL-10)

Settings > payment: add two optional fields to `PATCH /settings/payment`: `invoiceFooter` (max 500, shown at the bottom of invoices) and `paymentTerms` (max 200, replaces "Payment due within N days"). Blank or null clears. The invoice PDF now prints address, VAT number, company number, bank details, terms, due date and payment reference from existing settings; no web change is needed to see them, but the settings pages for address, VAT, company number and bank details should be reachable before sending invoices.

### 3.4 Send all (ACT-01)

1. Invoices page: add a status filter (DRAFT, SENT, PAID, VOID, OVERDUE via `GET /invoices?status=`).
2. "Send all" acts on the DRAFTs of the current view. Call `POST /invoices/bulk-send/preview { status: "DRAFT", filters: { customerId?, q?, from?, to? } }` (or `{ ids }` for a selection) and show a confirm step: `willSend`, `byChannel` counts and `skipped` counts with reasons (`NOT_DRAFT`, `PAID`, `VOID`, `NO_CONTACT_FOR_CHANNEL`, `OPTED_OUT`, `GHL_NOT_CONNECTED`). If `truncated` is true say only the first 500 will go and the rest can be sent next.
3. Confirm: `POST /invoices/bulk-send` (same body). It answers **202** immediately with `{ batchId, queued, skipped }`; disable the button while pending (a repeat is skipped as `ALREADY_QUEUED`, so a double click is safe).
4. Poll `GET /invoices/bulk-send/:batchId` every 2 to 3 seconds until `done` is true. `results[]` has `{ id, status: QUEUED|SENT|FAILED|SKIPPED, error?, code? }`. Announce the outcome in an `aria-live` region ("12 sent, 2 failed, 1 skipped") and list failures with `error`. Refetch the invoice list at the end.
5. An invoice only becomes SENT after the provider accepts. A failed one stays DRAFT and can be retried by sending again. Needs GHL connected (until the Wave 2B email channel); without it every invoice is skipped with `GHL_NOT_CONNECTED`.

### 3.5 Notifications

KPI alerts now also reach managers, and cash collected by a technician on site (`POST /mobile/visits/:id/debt-payment`, CASH) raises an "invoice paid" item in the office feed. No client change.

## 4. Environment

Web and app: none. Backend: `GOOGLE_MAPS_GEOCODING_API_KEY`, `GEOCODE_DAILY_LIMIT` (see the backend handoff).
