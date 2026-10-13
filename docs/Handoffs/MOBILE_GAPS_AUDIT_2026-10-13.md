# RoundFlow Technician App — Backend Audit of the Mobile Gaps Doc

**Date:** 2026-10-13
**Re:** "RoundFlow Technician App — Gaps Against the Backend" (2026-10-07)
**Method:** verified each of the 32 items against the actual backend code + Prisma schema (`file:line` cited).

## Corrections — the doc is wrong on these (already built)

1. **Item 1 (doorstep debt payment) — the endpoint EXISTS.** `POST /mobile/visits/:id/debt-payment` (`src/mobile/routes.ts:122` → `job-detail.service.ts:85`) records a CASH `Payment`, marks all the customer's DRAFT/SENT invoices `PAID`, and clears `badDebt` in one transaction. **But the contract differs:** path is singular; body is `{ cashConfirmed }` (pays the *full* outstanding, not a passed `amount`); returns `{ cleared, amountPaid }` (not `{ debtAmount, outstandingInvoices }`); the `Payment` is **not linked to the visit**; and it does **not** auto-start the visit.
2. **Item 26 (office chat) — EXISTS and is per-round.** `ChatMessage` model (`schema:624`), `GET`/`POST /mobile/chat/messages?roundId=` (`chat.service.ts`). Differences vs. the proposal: round is a query/body param (not `/rounds/:id/…`); pagination is a `since` timestamp (not `cursor`); POST takes no `photoUrls` (its `WORK_PHOTOS` type points at a visit's existing photos).
3. **Item 25 (round-updates toggle) — reuse the per-user preferences store** (`GET/PATCH /auth/me/preferences`) shipped 2026-10-13. One key, no new model.

## Full audit

### Policy mismatches
| # | Verdict | Evidence / note |
|---|---|---|
| 1 Doorstep debt | EXISTS, contract differs | `routes.ts:122`, `job-detail.service.ts:85` (see correction 1) |
| 2 `canStart`/`blockReason` on `GET /visits/:id` | **CONFIRMED** | Not in detail payload (`job-detail.service.ts:31-82`); hold only enforced as 403 in `startVisit` (`job-tracker.service.ts:41`) |
| 3 Partial price keeps reason + original | **CONFIRMED** | `PATCH /price` takes `{price}` only (`routes.ts:70`); `Visit` has no `originalPrice`/`priceAdjustmentReason` |
| 4 Access-issue auto-close | **DECISION** | `reportAccessIssue` only creates an `Issue` (`job-tracker.service.ts:73`); never closes |
| 5 Access reason enum | **CONFIRMED** | `IssueType = ACCESS_PROBLEM, GATE_LOCKED, PAYMENT_ISSUE, OTHER` (`schema:139`); `DOG_LOOSE/NO_REAR_ACCESS/UNSAFE_CONDITIONS/WRONG_ADDRESS` would 400 |
| 6 Debt-policy settings | Correct as-designed | Admin-only `PATCH /settings/payment` (`settings.ts:322`, gated `:43`) — no mobile work |
| 7 Customer import | **CONFIRMED (blocked)** | No `/customers/import` / bulk handling. Blocked on Mark's template; admin feature |

### Sign-in / recovery
| # | Verdict |
|---|---|
| 8-11, 13 forgot/resend/magic-link/change-pw/OAuth | **N/A — Supabase-side** (backend only verifies JWTs) |
| 12 mobile sign-up | **DECISION — don't expose**; `POST /auth/signup` is admin tenant provisioning (makes caller ADMIN). Techs join via invites |

### Profile / settings
| # | Verdict | Note |
|---|---|---|
| 14 `/mobile/me` GET/PATCH | **CONFIRMED** | no route; `dateOfBirth` on no model |
| 15 `/mobile/company` | **PARTIAL** | no route; `businessName/phone/email` exist; `termsUrl/privacyUrl` don't |
| 16 `/mobile/support/reports` | **CONFIRMED** | none |
| 17 avatar | **PARTIAL** | `avatarUrl` exists on `Technician` (`schema:339`), not public `Profile`; storage reusable |
| 18 change email | **N/A — Supabase-side** | |
| 19 terms/privacy URLs | **CONFIRMED** | same missing `BusinessSettings` columns as #15 |
| 20 My Subscription | **DECISION — remove** | no billing concept |
| 21 Add account | **DECISION — remove** | client-only |

### Notifications / messages
| # | Verdict | Note |
|---|---|---|
| 22 notifications list | **CONFIRMED** | no `Notification` model; `ActivityLog` is admin audit |
| 23 mark read/unread | **CONFIRMED** | follows #22 |
| 24 push devices | **CONFIRMED** | no `Device`/`PushToken`; needs FCM/APNs setup |
| 25 round-updates toggle | **PARTIAL — reuse prefs** | `/auth/me/preferences` |
| 26 chat per round | EXISTS, contract differs | see correction 2 |
| 27 realtime | **CONFIRMED (poll)** | no websocket/Realtime; poll via `since` |
| 28 chat photo attachments | **CONFIRMED** | only visit photos have an upload-url |

### Data shown but not returned
| # | Verdict | Note |
|---|---|---|
| 29 cash vs DD split | **CONFIRMED (cheap)** | flat `revenueToday` (`home.service.ts:86`); "Direct Debit" = `GOCARDLESS` |
| 30 per-round revenue | **CONFIRMED (cheap)** | counts only (`home.service.ts:129`); add `price` to select + sum |
| 31 `areaName` | **CONFIRMED** | needs `/mobile/me`; derivable via `TechnicianServiceArea` |
| 32 AI assistant | **CONFIRMED (DECISION)** | net-new feature |

## Totals
~16 real build gaps, 4 partial, 2 already exist (wrong contract), ~6 Supabase-side, ~5 product decisions.

## Build plan (what this backend will do)
- **Now (bounded, high-value):** #2, #3, #5 (P1 policy), #14/#17/#31 (`/mobile/me` + avatar), #15/#19 (`/mobile/company` + terms/privacy), #16 (support reports), #29, #30 (data). #25 = reuse prefs (no code).
- **Deferred with reasons:** #1 (align contract — coordinate with mobile; endpoint works), #4/#12/#20/#21/#32 (product decisions), #7 (blocked on Mark's template), #22-24 (notifications system — needs an event producer design + FCM/APNs creds), #26-28 (chat enhancements — works today), #27 (realtime), #6/#8-11/#13/#18 (no backend / Supabase).
