# RoundFlow — Backend Response to the Technician-App Gaps Doc

**Date:** 2026-10-13
**Re:** "RoundFlow Technician App — Gaps Against the Backend" (2026-10-07)
**Audit:** `docs/Handoffs/MOBILE_GAPS_AUDIT_2026-10-13.md`
**Status:** shipped + deployed to **dev** (`api-dev.roundflow.ai`); tenant migrations applied, routes verified `401` (deployed). Not on QA/prod. Not yet exercised with live authenticated data; the mobile app still needs to call these.

## Already existed (3 corrections to the doc)
- **#1 doorstep debt** — `POST /mobile/visits/:id/debt-payment` already works (full-clears outstanding, CASH payment, clears badDebt). It just differs from the proposed contract (`{ cashConfirmed }` → `{ cleared, amountPaid }`, pays full not a passed amount, payment not visit-linked). **Say if you want it realigned** to `{ amount, method }` / partial / visit-linked — otherwise it stands.
- **#26 office chat** — already exists and is per-round (`GET/POST /mobile/chat/messages?roundId=`). Round is a param (not a path), pagination is `since` (not cursor), and photos reference a visit's photos (no inline `photoUrls`).
- **#25 round-updates toggle** — use the per-user preferences store (`GET/PATCH /auth/me/preferences`). One key, no new endpoint.

## Shipped this round (live on dev)

| # | Endpoint / change | Contract |
|---|---|---|
| **2** | `GET /mobile/visits/:id` | now returns **`canStart: boolean`** + **`blockReason: string\|null`** (same debt-hold logic as Start, shared). No more learning the hold only from a 403. |
| **3** | `PATCH /mobile/visits/:id/price` | body now `{ price, reason? }`. First adjustment stores **`originalPrice`**; reason stored as **`priceAdjustmentReason`**; both returned on `GET /visits/:id`. Setting price back to the original **restores** (clears both). |
| **5** | `POST /mobile/visits/:id/access-issues` | `type` now also accepts **`DOG_LOOSE`, `NO_REAR_ACCESS`, `UNSAFE_CONDITIONS`, `WRONG_ADDRESS`** (plus existing `GATE_LOCKED`, `ACCESS_PROBLEM`, `PAYMENT_ISSUE`, `OTHER`). |
| **14** | `GET /mobile/me` · `PATCH /mobile/me` | GET → `{ name, email, dateOfBirth }`. PATCH `{ name?, dateOfBirth? }` (DOB `YYYY-MM-DD`) → same shape. |
| **15/19** | `GET /mobile/company` | `{ name, phone, email, termsUrl, privacyUrl }` (Help & Support + policy links; set terms/privacy in BusinessSettings). |
| **16** | `POST /mobile/support/reports` | `{ description, appVersion?, device? }` → `201 { id, createdAt }`. |
| **29** | `GET /mobile/completions` | adds **`revenueByMethod { cash, directDebit, other }`** (Direct Debit = GOCARDLESS; computed from the visit's payment method). |
| **30** | `GET /mobile/rounds/today` | each round adds **`expectedRevenue`** + **`earnedRevenue`**. |

Migrations: tenant `20261013000000_mobile_issue_types` + `20261013000001_mobile_gaps` (applied at startup, verified), public `20261013000000_profile_dob`. `tsc` clean; 205 tests pass.

## Deferred — with reasons (not built)

| # | Item | Why / what it needs |
|---|---|---|
| 17, 31 | Avatar upload + `areaName` on `/mobile/me` | Needs the Profile→Technician join + an avatar storage path. Next focused piece — `/mobile/me` and `dateOfBirth` are already in. |
| 22-24 | Notifications list / read / push | Needs (a) a **notification-event producer** design (what generates them) and (b) **FCM/APNs credentials**. A dedicated build, not a field-add. |
| 27 | Realtime | Poll the existing chat `since` param; no websocket layer today. |
| 28 | Chat photo attachments | Small follow-up (a chat-scoped upload-url, like visit photos). |
| 7 | Customer import | Blocked on Mark's spreadsheet template; admin feature. |
| 4 | Access-issue auto-close | Product decision: app sends `skip` after the last reason, or backend auto-closes (needs a defined "all reasons" set). |
| 12 | Mobile sign-up | Don't expose — `POST /auth/signup` is admin tenant provisioning. Techs join via the invite flow. |
| 20, 21 | My Subscription / Add account | Remove — no billing concept; account-switching is client-side. |
| 32 | AI assistant | Product/scope decision; net-new feature. |
| 6, 8-11, 13, 18 | Debt-policy settings; forgot/resend/magic-link/change-pw/OAuth; change email | No backend work — admin-only (already there) or Supabase-side. |

## Frontend action required
These endpoints exist; the app must call them. As with the admin frontend, the buttons won't do anything real until the mobile app wires to them.
