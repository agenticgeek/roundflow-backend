# Settings API Design Report — RoundFlow Phase 1

*Grounded in `designFindings.md` Screens 23/24/32–36 + M16/M17 (audited 2026-07-08), the current Prisma schema, and the `SetupService` OCP pattern (`profileId`-first, singleton-backed).*

> **Implementation status (updated 2026-07-08).** This began as a design-only report; parts are now **built**:
> - **Schema — migrations `settings_schema_p1` + `add_vat_in_invoices` applied:** `Technician.name` and `BusinessSettings.{paymentRule, debtHoldEnabled, vatInInvoices, gocardlessConnected, stripeConnected}` + enum `PaymentTiming` are **live**.
> - **Setup wizard step 2 is real** (`getPaymentSetup`/`savePaymentSetup`; `GET`/`POST /setup/step/2`) — persists the 5 payment fields; connect toggles are Phase-1 boolean stubs. (This **reversed** the original "step-2 deferred" stance — Decision 3.) **`completeSetup` now requires steps 1, 2, 3, 4, 6, 7, 8** (step-2 completeness = `paymentRule != null`) — step 2 is no longer skipped in the completion check; only step 5 stays deferred.
> - **Technician `name`** is accepted by `saveTechnicians` (Setup step 6) and stored on `Technician.name`.
> - **`handle_new_user` v2 trigger** now seeds `BusinessSettings.businessName` from the signup `company_name` metadata (only if unset) — see `docs/sql/handle_new_user_v2.sql`.
>
> The **`/settings/*` endpoints themselves are not built yet** — §2 remains the design for the Settings surface. Fields marked **✅ APPLIED** in §3 are live; everything else is still design/deferred.

**Governing principle:** Settings is the **post-completion editing surface** for the very same data the Setup Wizard seeds. So the same `profileId`-first service methods should back **both** trees; the only structural difference is that Settings mutations are **not** guarded by `assertSetupIncomplete` (the wizard 403s after `setupCompleted`; Settings keeps working). Where the wizard uses coarse full-replace, Settings needs finer per-item operations to match the Edit/Delete/Add UI.

---

## 1. Scope & overlap with the Setup Wizard

| Settings screen | Underlying data | Reuses setup service? | New surface required |
|---|---|---|---|
| **23** Business Profile | `BusinessSettings` (profile fields) | ✅ step 1 `saveBusinessProfile` | none (add open-after-completion GET/PATCH) |
| **33** Round Settings | `BusinessSettings` (round fields) | ⚠️ partial — step 4 covers cycle + working days | clean-method, auto-gen, reminder-timing fields |
| **24** Service Catalogue | `Service[]` | ⚠️ partial — step 3 is full-replace; UI is per-item | per-item CRUD (M16/M17) + `isDefault` |
| **36** Service Areas | `ServiceArea[]` | ⚠️ partial — step 7 is full-replace | per-item CRUD + `description` |
| **35** Technician Mgmt | `Technician[]` | ⚠️ partial — step 6 creates invite-pending (**`name` now accepted + stored**) | `email` / `defaultServiceAreaId` still pending (§6.4) |
| **32** Payment Setup | `BusinessSettings` payment fields | ✅ **built** — reuses `savePaymentSetup`/`getPaymentSetup` (Setup step 2 is real; fields live) | connect actions = Phase-1 boolean stubs (§6.1) |
| **34** SMS Templates | *(new)* message templates | ❌ deferred (like step 5) | stub only (see §6) |

**Recommendation:** introduce a thin `SettingsService` (or extend the domain services) mirroring `SetupService` — same `profileId`-first signatures, same singleton seam, minus the incomplete-guard. This avoids duplicating logic across `/setup/*` and `/settings/*`.

---

## 2. Per-screen endpoint design

### 23 — Business Profile
- `GET /settings/business-profile` → `BusinessSettings` singleton *(reuses `getBusinessSettings`)*.
- `PATCH /settings/business-profile` → **partial upsert**, step-1 fields only *(reuses `saveBusinessProfile`)*.
- Writes disjoint fields from Round Settings — no clobber (same guarantee as wizard steps 1↔4).
- **Note (2026-07-08):** `businessName` can also be **seeded at signup** — the `handle_new_user` v2 trigger writes it from the `company_name` signup metadata **only if currently null**, so it never overwrites a value set here or in Setup step 1 (see §6.3 / `docs/sql/handle_new_user_v2.sql`).

### 33 — Round Settings
- `GET /settings/round-settings` → `BusinessSettings` (round-field subset).
- `PATCH /settings/round-settings` → **partial upsert**. Existing: `defaultCycleLength`, `defaultWorkingDays`. **New:** `defaultCleanMethod`, `autoGenerateVisits`, `preCleanReminderTime`, `preCleanReminderOffset`.
- **Gap → Resolved (Decision 1):** the screen shows cycle as *Week / 2-week / 3-week / 4-week* but the schema stores `defaultCycleLength` as **Int days**. **Keep `Int` days; the UI maps weeks to days (7/14/21/28).**

### 24 — Service Catalogue *(per-item — matches M16/M17)*
- `GET /settings/services` → `Service[]`.
- `POST /settings/services` → create one *(M16 Add New Service)*.
- `PATCH /settings/services/:id` → update one *(M17 Edit Service)*.
- `DELETE /settings/services/:id` → remove one.
- **Coexists** with the wizard's full-replace `saveServices` (wizard bulk-seeds; Settings edits individually). **New field:** `isDefault` (M16/M17 "Default — pre-selected on new jobs" toggle). **Delete guard:** once `ServicePlan`/`Visit` reference services (post-M3), block with `409` (Decision 5 — no soft-delete).

### 36 — Service Areas *(per-item)*
- `GET /settings/service-areas` → `ServiceArea[]` **+ derived `linkedRounds`** (from `Round.serviceAreaId`, read-only).
- `POST` / `PATCH /:id` / `DELETE /:id`.
- **New field:** `description`. **Delete guard:** block with `409` if a `Round`/`Property` references the area (Decision 5 — no reassign).

### 35 — Technician Management *(per-item — see §6.4 for the identity model)*
> ✅ **Partly built (2026-07-08):** `Technician.name` is live and `saveTechnicians` (Setup step 6) accepts it. `email` / `defaultServiceAreaId` and the per-item Settings CRUD below are still design.
- `GET /settings/technicians` → `Technician[]` with a **derived display name/status** (`profile?.name ?? technician.name`; App Status from `profileId` + `active`).
- `POST /settings/technicians` → invite-pending create with admin-entered `name` + `phone` + optional `defaultServiceAreaId`.
- `PATCH /:id`, `DELETE /:id`.

### 32 — Payment Setup
> ✅ **Built, wizard side (2026-07-08):** `GET`/`POST /setup/step/2` back this with `getPaymentSetup`/`savePaymentSetup` on the singleton (`paymentRule`, `debtHoldEnabled`, `vatInInvoices`, `gocardlessConnected`, `stripeConnected` — all live). The Settings endpoints below are the post-completion mirror — same singleton, same fields, minus the incomplete-guard.
- `GET /settings/payment` → `{ providers: { gocardless: {status}, stripe: {status} }, rules: {...} }`.
- `PATCH /settings/payment` → default **rules** only (`paymentRule`, `vatInInvoices`, `debtHoldEnabled`).
- `POST /settings/payment/:provider/connect` → **provider-agnostic** `{ status, connectUrl? }` (Phase-1: flips the `*Connected` boolean; see §6.1).

### 34 — SMS Templates
- `GET /settings/message-templates` → `{ status: "deferred", source: "ghl", templates: [...read-only defaults] }` (see §6).
- `PATCH` → deferred no-op in Phase 1, or local-store behind a service interface (see §6).

---

## 3. New schema needs — with Phase classification

Legend: **✅ APPLIED** = live in the DB (migration named) · **[P1-nice]** Phase 1 if time permits · **[P2]** defer to Phase 2.

| Target | New field / model | Type | Phase / Status | Rationale |
|---|---|---|---|---|
| `Technician` | `name` | `String?` **nullable** | ✅ **APPLIED** (`settings_schema_p1`) | Screen 35 Full Name; nullable so it never blocks the invite/accept path (§6.4). |
| `Technician` | `email` | `String?` | **[P1-nice]** | Invite target; could live on the invite entity instead. |
| `Technician` | `defaultServiceAreaId` | `String?` FK | **[P1-nice]** | Screen 35 "Default Area"; not required to complete a cycle. |
| `Service` | `isDefault` | `Boolean @default(false)` | **[P1-nice]** | M16/M17 "pre-selected on new jobs"; UX sugar. |
| `ServiceArea` | `description` | `String?` | **[P1-nice]** | Screen 36 area-card copy. |
| `BusinessSettings` | `debtHoldEnabled` | `Boolean @default(false)` | ✅ **APPLIED** (`settings_schema_p1`) | Gates payment-hold visit generation (FR-VISIT-1) — behavioural. |
| `BusinessSettings` | `paymentRule` | enum `PaymentTiming` (`COLLECT_AFTER_VISIT`…) | ✅ **APPLIED** (`settings_schema_p1`) | Drives the M6 collection trigger; the **step-2 completeness key**. |
| `BusinessSettings` | `gocardlessConnected` | `Boolean @default(false)` | ✅ **APPLIED** (`settings_schema_p1`) | Phase-1 connect stub — boolean flip, no OAuth (Decision 2 / §6.1). |
| `BusinessSettings` | `stripeConnected` | `Boolean @default(false)` | ✅ **APPLIED** (`settings_schema_p1`) | Phase-1 connect stub — boolean flip, no OAuth (Decision 2 / §6.1). |
| `BusinessSettings` | `vatInInvoices` | `Boolean @default(false)` | ✅ **APPLIED** (`add_vat_in_invoices`) | Step 2 "VAT Applicable"; **promoted from P1-nice** once step 2 became real and collects it. |
| `BusinessSettings` | `autoGenerateVisits` | `Boolean @default(true)` | **[P1-nice]** | Default-on works without the field; add when the toggle matters. |
| `BusinessSettings` | `defaultCleanMethod` | clean-method enum (`TRADITIONAL`/`WATER_FED_POLE`) | **[P1-nice]** | Default for new plans; not blocking. |
| `BusinessSettings` | `preCleanReminderTime` / `preCleanReminderOffset` | `String?` / `Int?` | **[P2]** | Reminder **sending** is GHL messaging (Phase 2); config can wait. |
| *(new)* `PaymentProviderConnection` | `provider, status, externalRef` | model | **[P1-nice]** — deferred | Phase 1 uses the two `*Connected` booleans instead (Decision 2 / §6.1). |
| *(new)* `TechnicianInvite` | invite token | model | **[P1-req]** (M5) | Required for mobile onboarding, not for Settings alone. |
| *(new)* `MessageTemplate` | `key, channel, body` | model | **[P2]** | GHL owns messaging in Phase 2 — **do not** create a local table now (§6.2). |

**Applied migrations (2026-07-08):** `20260707223107_settings_schema_p1` (`Technician.name`; `BusinessSettings.debtHoldEnabled` / `paymentRule` / `gocardlessConnected` / `stripeConnected`; enum `PaymentTiming`) and `20260707225445_add_vat_in_invoices` (`BusinessSettings.vatInInvoices`). Everything still marked **P1-nice / P2** is unbuilt. `TechnicianInvite` lands with M5.

---

## 4. Post-completion behaviour (Settings vs. the locked wizard)

- After `POST /setup/complete`, **wizard step POSTs 403**; **Settings mutations stay open** and are the ongoing edit path.
- **GET endpoints are identical/shared** — the wizard's `GET /setup/step/N` and Settings' `GET /settings/*` read the same rows; a single service method backs both.
- Settings routes **do not** call `assertSetupIncomplete`. I do **not** recommend an inverse "must be complete" guard on Settings — let the frontend gate visibility by `setupCompleted`; the API stays simple.
- **Anti-duplication rule:** never let a route (or a second service) query `BusinessSettings`/`Service`/etc. directly. Both trees call the same `profileId`-first service methods. This is what makes the Phase-2 swap a one-place change (§6).

---

## 5. Open questions — RESOLVED (see Decisions)

*All six were resolved on 2026-07-08 (Decisions 1–6). Kept for traceability; status noted.*

1. **Cycle representation** → **Resolved** (Decision 1): keep `Int` days; the UI maps weeks (7/14/21/28).
2. **Payment provider connect** → **Resolved + applied** (Decision 2): two `*Connected` booleans; no OAuth in Phase 1.
3. **Payment Setup vs. wizard step 2** → **Resolved + built** (Decision 3, *reversed*): **step 2 is real** (`savePaymentSetup`); payment config lives in both the wizard and Settings.
4. **SMS Templates** → **Resolved** (Decision 4): pure deferral, no `MessageTemplate` table.
5. **Service/Area delete guards** → **Resolved** (Decision 5): block with `409`; no soft-delete in Phase 1.
6. **Technician identity** → **Resolved + built** (Decision 6): `Technician.name` nullable label — live and accepted by `saveTechnicians`.

---

## 6. GHL / Phase 2 coupling risks

**Recap of the seam we're protecting:** every service method takes `profileId` first. Phase 1 is single-tenant, so the singleton lookup ignores it; Phase 2 swaps the implementation to resolve a tenant from `profileId` and scope every query — **and** routes payments/messaging through GHL. The risk in each Settings sub-section is baking a single-tenant or non-GHL assumption into the **API contract or schema** such that the Phase-2 swap becomes a *breaking* change rather than an *internal* one. Contracts and DTOs must stay swap-neutral; the "how" lives inside services.

### 6.1 Payment Setup (GoCardless/Stripe → GHL-triggered later)
**Risk:** if the Phase-1 endpoint returns raw GoCardless/Stripe OAuth URLs and stores provider tokens as columns on the singleton, then Phase 2 (payments mediated by GHL, per-tenant connections) forces a contract + schema break.
**Design today so GHL slots in without a breaking change:**
- **Provider-agnostic connect contract:** `POST /settings/payment/:provider/connect → { status, connectUrl? }`. The *shape* is identical whether `connectUrl` comes from a direct provider OAuth (Phase 1) or from a GHL-mediated flow (Phase 2). No caller change.
- **Connection state behind an abstraction, not token columns:** model it as `PaymentProviderConnection { provider, status, externalRef }` (or, minimally, `gocardlessConnected`/`stripeConnected` booleans + an opaque `externalRef`) — **never** `gocardlessAccessToken` on `BusinessSettings`. Phase 2 re-backs `externalRef` per-tenant / via GHL with no schema-breaking rename.
- **Collection is a service call, never inline:** `paymentService.collectForVisit(profileId, visitId)`. Phase 2 swaps that method's body to route through GHL. The route, the debt board, and the visit flow are untouched → **non-breaking**.
- **Rules stay as tenant config** (`paymentRule`, `vatInInvoices`, `debtHoldEnabled`) on the singleton — they migrate cleanly through the singleton→tenant seam (§6.3).

> ✅ **Now built:** the two `*Connected` booleans + `paymentRule` / `vatInInvoices` / `debtHoldEnabled` are live on the singleton and persisted by Setup step 2 (`savePaymentSetup`). Still to build (M6): the provider-agnostic **connect contract** and the **`collectForVisit` service call** — keep them swap-neutral as above.

### 6.2 SMS Templates (GHL-owned in Phase 2)
**Risk:** building a full local `MessageTemplate` CRUD now, then GHL owns templates in Phase 2 → table migration + endpoint removal (breaking) + every reader rewired.
**Right stub shape today:**
- **Match the wizard's deferred stub:** `GET /settings/message-templates → { status:"deferred", source:"ghl", templates:[…read-only defaults] }`. **Do not create a `MessageTemplate` table** in the Phase-1 migration.
- **If the design demands editing now,** put it behind a `messageTemplateService` interface whose Phase-1 impl is a minimal local store and Phase-2 impl proxies GHL — **identical DTO** `{ key, channel, body }` (which is already GHL-compatible). Swapping the backing store is then internal.
- **Hard rule:** no other feature (reminders, payment-failed messages) reads templates from the DB directly — all go through the service, so Phase 2 redirects them to GHL in one place. This is the same discipline as §6.1's collection call.

### 6.3 BusinessSettings singleton → per-tenant in Phase 2
**Risk:** `where: { uniqueId: "singleton" }` leaks into many call sites; every field becomes per-tenant later.
**Seam (largely already correct):**
- All access already funnels through the private `getSettings()` / `profileId`-first methods — the singleton `where` clause lives in **exactly one place**. Phase 2 changes that one method to `where: { tenantId: resolveTenant(profileId) }`. Keep it that way: the `SettingsService` must reuse the **same** private seam, not re-issue its own `businessSettings.findUnique`.
- **DTO hygiene:** `uniqueId` is an internal key — never expose it as meaningful in responses, never accept it in requests. The frontend addresses "the business," not "the singleton."
- **Net:** as long as the singleton key stays encapsulated and Settings routes go through the service, adding Settings introduces **zero new coupling** — the Phase-2 migration is still a one-method change.

> **Note (v2 trigger, 2026-07-08):** the `handle_new_user` Postgres trigger now writes `BusinessSettings.businessName` **directly** (from `company_name` signup metadata, guarded by `businessName is null`). This is the one deliberate exception to "never touch the singleton outside the service" — it's DB infrastructure, single-tenant; Phase 2 would move it into per-tenant provisioning. It doesn't change the encapsulation rule for application code.

### 6.4 Technician name conflict (Screen 35 Full Name vs. invite-pending, no name)
**The conflict:** Screen 35 collects **Full Name + Mobile at add-time**, but the schema's `Technician` is invite-pending (`profileId = null`, no name) — the real name arrives when the technician onboards on the **mobile app** and gets a `Profile`. Making `name` required and authoritative now would collide with the mobile onboarding identity in Phase 2 (two names that can diverge; a NOT-NULL that the invite flow can't always satisfy).
**Resolution that doesn't break the invite flow:**
- Add **`Technician.name String?` (nullable)** as the admin's **display label** ("invited as…"), plus `phone` (already present). **Never NOT-NULL, never an identity key.**
- **Identity stays `id` + (eventually) `profileId`.** Name is cosmetic.
- **Source-of-truth precedence:** once the invite is accepted, the **`Profile` name wins**; expose a derived `displayName = profile?.name ?? technician.name`. The admin's label is a fallback, not a competitor.
- **Invite flow unchanged:** `technicianService.invite(profileId, { name, phone, defaultServiceAreaId })` creates the invite-pending row; a `TechnicianInvite` token (lands with M5) carries the email; mobile acceptance links a `Profile` to the **same** `Technician` by token. Nothing in that path requires a field only the mobile flow can produce → **no breakage**.
- **`profileId`-first:** the invite create and the mobile accept both scope by `profileId`/tenant through the service, so Phase 2 multi-tenancy + mobile onboarding compose without a contract change.
**One-line rule:** *nullable name as a label, Profile as truth, identity by id — never make the admin-entered name required or authoritative.*

> ✅ **Now built:** `Technician.name String?` is live (`settings_schema_p1`) and `saveTechnicians` accepts it; `Profile.name` still wins as the display source once the invite is accepted. `TechnicianInvite` + `email` / `defaultServiceAreaId` remain for M5.

---

## Summary of recommendations
- Back `/settings/*` with the **same `profileId`-first services** as `/setup/*`, minus the incomplete-guard; add **per-item** CRUD where the UI needs it (Services, Areas, Technicians).
- **P1-req schema — ✅ applied** (`settings_schema_p1` + `add_vat_in_invoices`): `Technician.name?`, `BusinessSettings.{debtHoldEnabled, paymentRule, vatInInvoices, gocardlessConnected, stripeConnected}` (+ enum `PaymentTiming`). P1-nice / P2 fields deferred.
- **Keep three things swap-neutral now** so Phase 2/GHL is internal, not breaking: provider-agnostic **payment connect contract** + service-level **collection call**; **deferred SMS-template stub** (no table); **encapsulated singleton seam**. And resolve the **technician name** as a nullable label.

---

## Decisions

*Resolutions to the §5 open questions (approved 2026-07-08). These governed the `settings_schema_p1` + `add_vat_in_invoices` migrations — **both now applied** — and Phase-1 scope.*

1. **Cycle representation** — Keep `defaultCycleLength` as **`Int` days**. The UI maps the week options to days (Week → 7, 2-week → 14, 3-week → 21, 4-week → 28). **No new field.**
2. **Payment provider connect** — **Stub for Phase 1.** Add `gocardlessConnected Boolean @default(false)` and `stripeConnected Boolean @default(false)` to `BusinessSettings`. **No `PaymentProviderConnection` model yet.** Real OAuth is deferred to Phase 2 / GHL.
3. **Payment Setup — real in both the wizard (step 2) and Settings.** *(Reversed 2026-07-08 after the Setup wizard re-audit: step 2 in Figma — frame `936:44953` — is a full screen identical to Settings Screen 32, not a stub, and its Review checklist gates on "GoCardless connected".)* The **connect actions** (GoCardless / Stripe) remain **Phase-1 stubs** (boolean flip, no real OAuth). **Step 2 persists:** `paymentRule`, `debtHoldEnabled`, `vatInInvoices`, `gocardlessConnected`, `stripeConnected`.
4. **SMS Templates** — **Pure deferral.** No `MessageTemplate` table is created. `GET /settings/message-templates` returns `{ status: "deferred", source: "ghl" }`. Build when GHL integration begins.
5. **Delete guards** — **Block with `409` if referenced. No soft-delete in Phase 1.**
   - `DELETE /settings/services/:id` → **409** if any `ServicePlan` or `Visit` references the service.
   - `DELETE /settings/service-areas/:id` → **409** if any `Round` or `Property` references the area.
6. **Technician identity** — Confirmed per §6.4: `Technician.name` is a **nullable admin label**, `Profile.name` wins once the invite is accepted, identity is by `id`/`profileId`.

**Migration impact — ✅ APPLIED (2026-07-08).** `20260707223107_settings_schema_p1`: `Technician.name String?`; `BusinessSettings.debtHoldEnabled`; `BusinessSettings.paymentRule PaymentTiming?`; `BusinessSettings.gocardlessConnected`; `BusinessSettings.stripeConnected`; new enum `PaymentTiming { COLLECT_AFTER_VISIT, COLLECT_BEFORE_VISIT, COLLECT_ON_DATE }`. Then `20260707225445_add_vat_in_invoices`: `BusinessSettings.vatInInvoices` — added once **Decision 3 was reversed** and step 2 became real (it collects the VAT Applicable toggle). Decisions 1 & 4 add no schema; Decision 5 is enforced in the **service layer**. The `businessName`-from-`company_name` seeding is a **Supabase trigger** step (`docs/sql/handle_new_user_v2.sql`), not a Prisma migration.
