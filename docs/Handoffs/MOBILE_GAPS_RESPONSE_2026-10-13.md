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

### Shipped — round 2 (also live + verified on dev)

| # | What shipped |
|---|---|
| **17/31** | `GET`/`PATCH /mobile/me` now return/update **`avatarUrl`** + **`areaName`**; **`POST /mobile/me/avatar/upload-url`** returns a signed upload URL. |
| **28** | Chat image attachments: **`POST /mobile/messages/attachments/upload-url`**; `POST /mobile/chat/messages` accepts **`type:"PHOTOS"` + `photoUrls[]`** (`ChatMessage.photoUrls`). |
| **22-24** | **`GET /mobile/notifications?cursor=`** (+`unreadCount`/`nextCursor`), **`PATCH /:id/read`**, **`POST /read-all`**, **`POST /devices`** `{pushToken,platform}`, **`DELETE /devices/:token`**. Push via Expo (token-gated). ⚠️ `createNotification` is the **producer hook** — no events generate notifications yet; wiring them (round assignment, payment, etc.) is the next step. Expo is assumed; swap for FCM/APNs if the app isn't Expo. |

Round-2 migration: tenant `20261013000002_mobile_notifications`. 208 tests.

**Bugs found + fixed while wiring this:**
- **Technician resolution** — mobile home endpoints resolved the technician by `supabaseUserId`, but `Technician.profileId` stores `Profile.id` — they'd return **empty for every real invited tech**. Now pass `req.profile.id`.
- **Deploy stale-image** — the dev/qa EC2 disk filled; `docker pull` failed and (no `set -e`) the deploy silently re-ran the old image, so new code/migrations never landed despite green deploys. Fixed: `docker image prune -f` before the pull + a `concurrency` guard so deploys can't race.

## Deferred — with reasons (not built)

| # | Item | Why / what it needs |
|---|---|---|
| 27 | Realtime | Poll the existing chat `since` param; no websocket layer today (client-side). |
| 22-24 producers | What *generates* notifications | The notification API is shipped, but no backend events create notifications yet — wiring producers (round assignment, payment, schedule) is a product-driven follow-up. |
| 7 | Customer import | Blocked on Mark's spreadsheet template; admin feature. |
| 4 | Access-issue auto-close | Product decision: app sends `skip` after the last reason, or backend auto-closes (needs a defined "all reasons" set). |
| 12 | Mobile sign-up | Don't expose — `POST /auth/signup` is admin tenant provisioning. Techs join via the invite flow. |
| 20, 21 | My Subscription / Add account | Remove — no billing concept; account-switching is client-side. |
| 32 | AI assistant | Product/scope decision; net-new feature. |
| 6, 8-11, 13, 18 | Debt-policy settings; forgot/resend/magic-link/change-pw/OAuth; change email | No backend work — admin-only (already there) or Supabase-side. |

## Frontend action required
These endpoints exist; the app must call them. As with the admin frontend, the buttons won't do anything real until the mobile app wires to them.
