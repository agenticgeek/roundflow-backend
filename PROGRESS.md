# RoundFlow Backend — Progress Log

> Living document. Last updated: 2026-07-08 · Branch: `dev` · HEAD: `2abb18d`
> Written by reading the codebase directly. If a claim isn't backed by code or a
> run, it's flagged as unverified. Update this file as the backend grows.
> **2026-07-07:** `docs/designFindings.md` re-audited (admin design update + new
> RoundFlow Technician mobile app). See **Schema Decisions & Implications
> (2026-07-07 Design Update)** below. **Decision 2 (remove `Round.technicianId`)
> is implemented** — migration `20260706211550_remove-round-technician-id`; other
> schema items remain Pending/Deferred.
> **2026-07-08:** Verified/updated the doc set for the two assignment rules —
> **multi-technician rounds** and **per-occurrence manual assignment** (each new
> recurrence starts unassigned, not auto-inherited). Added explicit **Rule:** lines
> to `docs/designFindings.md` (Screen 30 + M14 + Design Update Log), FR-ROUND-9/10
> to `docs/SRS.md`, and §3.4 (Technician Assignment Model) to `docs/SDS.md`; rewrote
> `docs/ROADMAP.md` into a Linear-ready backend+frontend ticket structure. Schema
> re-verified to support both rules (no `Round.technicianId`; `Visit.technicianId`
> per-job; no `defaultTechnicianId`/auto-assignment field anywhere).
> **2026-07-08:** Audited the full `/Settings` section in Figma (7 sub-screens, not
> 2) → expanded `docs/designFindings.md` (Screens 23/24 + new 32–36, modals M16/M17).
> Wrote **`docs/SETTINGS_API_DESIGN.md`** (Settings API design + Phase-classified
> schema needs + GHL/Phase-2 coupling risks + 6 approved Decisions). Applied the
> **P1-req migration `20260707223107_settings_schema_p1`** — `Technician.name`
> (nullable admin label), `BusinessSettings.debtHoldEnabled` / `paymentRule`
> (`PaymentTiming?`) / `gocardlessConnected` / `stripeConnected`, and new enum
> `PaymentTiming { COLLECT_AFTER_VISIT, COLLECT_BEFORE_VISIT, COLLECT_ON_DATE }`.
> Additive only; seed unchanged (all new fields nullable/defaulted); `tsc` + seed clean.
> **2026-07-08 (Setup re-audit):** Full re-audit of the Figma `/Setup` section (34
> frames) found the wizard has grown to a **12-step** flow (an older 7-step cut and a
> newer 12-step cut coexist; we build against 12) — `docs/designFindings.md` Screen 6
> rewritten with real frame IDs. **Key finding: step 2 (Payment Setup) is a full
> screen, not a stub** — it collects `paymentRule`, `debtHoldEnabled`, `vatInInvoices`,
> `gocardlessConnected`, `stripeConnected` at first-run; and step 6 collects
> Technician **Full Name**. **Reversed Settings Decision 3** (step 2 now real).
> **Tier 1 fixes applied:** real `GET/POST /setup/step/2` (`savePaymentSetup`/
> `getPaymentSetup`; step-2 completeness = `paymentRule != null`; connect toggles
> stay Phase-1 stubs), and `name` added to `TechnicianInput`/`saveTechnicians`.
> **Tier 2 (wizard steps 9–11: Add Property, Assign Technicians, Activate/Generate
> Visits) deferred to milestones M2/M3/M4 — no endpoints built.**
> **2026-07-08 (Auth re-audit):** Re-audited the Figma `Login/signup` section — the
> 5 auth screens were rebuilt on Page 1; updated `docs/designFindings.md` Screens 1–5
> node IDs (old `658/681:xxxx` → `936:617xx/620xx`) + fields, and added an **Auth Flows**
> section. **Magic-link flow confirmed** for both signup confirmation and password
> reset → **OTP (Screen 4) deferred** (not built in Phase 1). Signup now collects
> **Full name** (`raw_user_meta_data.full_name` → `Profile.name`) and **Company name**
> (`raw_user_meta_data.company_name` → `BusinessSettings.businessName`). Wrote
> **`docs/sql/handle_new_user_v2.sql`** (trigger v2 — seeds `businessName` from
> `company_name` on first signup, only if unset) — **run in Supabase and verified
> live 2026-07-08** (`pg_get_functiondef` confirms the v2 body; `on_auth_user_created`
> bound to `auth.users`). ROADMAP M0 updated (FE-M0-02/03 magic-link; new FE-M0-06 Google OAuth +
> `/auth/callback`, FE-M0-07 signup email UX, FE-M0-08 auth guards, BE-M0-08 run
> trigger v2). No `/auth/callback` yet — it's a **frontend** route.
> **2026-07-08:** Settings API built (7 sub-sections, 21 endpoints, `SettingsService`
> OCP seam). Setup-completion guard added — mutations blocked until `setupCompleted = true`.

## Project Overview

RoundFlow is a field service management (FSM) SaaS for a UK window-cleaning
business (Phase 1: single client), built around a recurring round-based
operating loop. **This repository is the backend only** — a Node/Express +
TypeScript API with a Prisma-managed Supabase Postgres database that is the
system of record for all operational data (customers, properties, service
plans, rounds, visits, payments, complaints, technicians). A **separate frontend
repo** (React web app) owns all UI, and — importantly — owns the entire auth UX:
login, signup, forgot-password, OTP, and reset are handled by Supabase Auth on
the frontend; this backend has no login/signup endpoints and only *verifies*
Supabase-issued JWTs on protected routes.

## Architecture Decisions (locked)

- **Prisma 6.19.3 (not 7).** Prisma 7 was set up and then deliberately rolled
  back. Prisma 7 requires a driver adapter (`@prisma/adapter-pg`), moves the
  datasource URL into `prisma.config.ts`, drops `directUrl` from the datasource,
  and its CLI `migrate dev` bailed in this non-TTY environment. Prisma 6 keeps
  the classic schema-based datasource (`url` + `directUrl`), the
  `prisma-client-js` generator, plain `new PrismaClient()`, and `migrate dev`
  that runs non-interactively — simpler and friction-free. Chosen for stability.
- **Database: Supabase-hosted Postgres.** Managed Postgres so we don't run our
  own DB. Region `ap-northeast-1` (Tokyo). Considered/were on local Homebrew
  Postgres during early bring-up; moved to Supabase to also get Supabase Auth.
- **Auth: Supabase Auth + ES256 JWKS verification (not the HS256 legacy secret).**
  The frontend authenticates users via Supabase; the backend verifies the Bearer
  JWT. The project signs tokens with **ES256 (asymmetric, ECC P-256)**, so the
  backend fetches public keys from the project's **JWKS endpoint** and verifies
  with `jsonwebtoken` + `jwks-rsa`. An earlier HS256 + shared-secret
  (`SUPABASE_JWT_SECRET`) implementation was removed because it rejected every
  real ES256 token. No auth secret is stored on the backend anymore.
- **Profile auto-creation: Postgres trigger in Supabase (not an HTTP webhook).**
  A new Supabase signup must create a matching `Profile` row (public-schema
  mirror of `auth.users`). This is done by a **database trigger** on
  `auth.users` inside Supabase, chosen over an Express webhook endpoint because
  the trigger is transactional with the user insert, needs no shared webhook
  secret, no network round-trip, and no publicly exposed unauthenticated route.
  An earlier `POST /auth/webhook` endpoint was built and then deleted.
  ⚠️ The trigger's SQL is **not in this repo** (it lives in Supabase) — see
  Infrastructure for what is/isn't confirmed.
- **GHL's role: messaging/payments utility only, not the platform.** GoHighLevel
  is used (Phase 1) as an external utility for SMS/WhatsApp/Email and to assist
  Stripe/GoCardless payment flows against a single GHL account. It is **not** the
  data layer, business-logic engine, delivery mechanism, or auth — that GHL-native
  architecture was retired (see `docs/RoundFlow_Context_and_Roadmap_v1.md`).
  `Customer.ghlContactId` exists as the join point from day one, but no GHL
  integration code exists yet.
- **Connection strings: two URLs.** `DATABASE_URL` → transaction-mode pooler
  (port 6543, `?pgbouncer=true`) for the app runtime; `DIRECT_URL` → direct/
  session connection (port 5432) for Prisma migrations, because PgBouncer
  transaction mode can't run migration DDL/advisory locks. Both are declared in
  `schema.prisma`'s datasource block (`url` + `directUrl`).
- **Google OAuth: configured in Supabase + Google Cloud Console, backend
  uninvolved.** Google sign-in is a Supabase Auth provider; the backend plays no
  part. (`GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` are present in local `.env`
  but **not read by any backend code** — no code references them.)
- **Password reset: entirely Supabase, backend uninvolved.** Forgot/OTP/reset
  are Supabase Auth flows on the frontend. No backend routes or code.

## Current File Structure

Annotated tree (excludes `node_modules/`, `.git/`):

```
.
├── PROGRESS.md                    # This document.
├── .env                           # Real secrets (gitignored): DATABASE_URL, DIRECT_URL, GOOGLE_* creds.
├── .env.example                   # Committed template: DATABASE_URL/DIRECT_URL shapes + auth note (no secrets).
├── .gitignore                     # Ignores node_modules/, generated/, dist/, .env*, .claude/settings.local.json.
├── .vscode/
│   └── settings.json              # Pins the VS Code Prisma extension to v6 (matches our Prisma choice).
├── .claude/
│   └── settings.local.json        # Machine-local Claude Code permissions (gitignored).
├── docs/
│   ├── RoundFlow_Context_and_Roadmap_v1.md   # Active project brief: what RoundFlow is, phased roadmap.
│   └── designFindings.md          # Source of truth for screens/flows (Figma wireframe audit).
├── package.json                   # Deps + scripts (dev/start/build/typecheck/clean/start:prod/seed/prisma:*).
├── package-lock.json              # Lockfile.
├── tsconfig.json                  # Base TS config (Node16, strict); drives typecheck over src/ + prisma/.
├── tsconfig.build.json            # Production build config: emits only src/ → dist/ (rootDir src, entry dist/index.js).
├── prisma/
│   ├── schema.prisma              # 19 models + enums; datasource (url + directUrl); prisma-client-js generator.
│   ├── seed.ts                    # Idempotent dev seed (BusinessSettings, admin Profile, Technician, 2 areas, 1 round).
│   └── migrations/
│       ├── 20260701220655_init/migration.sql   # Single migration: full schema (all tables/enums).
│       └── migration_lock.toml    # Prisma migration provider lock (postgresql).
└── src/
    ├── index.ts                   # Express app: cors + json, /health, /auth/me, /setup router, AppError-aware error handler, listen.
    ├── lib/
    │   ├── prisma.ts              # Shared PrismaClient singleton (globalThis-cached for dev hot-reload).
    │   └── app-error.ts           # Typed AppError (statusCode + message) mapped by the error handler.
    ├── middleware/
    │   └── requireAuth.ts         # JWKS/ES256 Bearer-token verification; attaches req.user; 401 on failure.
    ├── services/
    │   └── setup.service.ts       # Setup Wizard business logic + all DB access (behind ISetupService — Phase 2 OCP seam).
    └── routes/
        └── setup.ts               # Thin /setup routes: validate → call SetupService → respond; all requireAuth.
```

Build & run: dev runs TypeScript directly via `tsx` (`npm run dev` / `npm start`).
A production **build pipeline** now exists: `npm run build` = `clean` (`rm -rf
dist`) → `typecheck` (`tsc --noEmit`, covers `src/` + `prisma/`) → emit `src/` to
`dist/` via `tsconfig.build.json` (`rootDir: src`, so the entry is `dist/index.js`;
the seed is not compiled into the build). `npm run start:prod` runs
`node dist/index.js`. `npm run typecheck` / `npm run clean` are available
standalone. `dist/` is gitignored.

## What's Built

### Database & Schema

Locked Prisma schema (`prisma/schema.prisma`), 19 models. Three migrations applied
(`20260701220655_init`, `20260706211550_remove-round-technician-id`,
`20260706220349_add_setup_completed`).

- **Profile** — public-schema mirror of Supabase `auth.users`; `supabaseUserId`
  (unique) is the join key; `role` (ADMIN/MANAGER/TECHNICIAN, required); `name`.
- **Customer** — a customer/contact; can own many Properties; holds
  `ghlContactId` (GHL join), `paymentMethod`, `badDebt` flag.
- **Property** — a physical site to clean; belongs to a Customer; `roundId`
  **nullable** (unassigned state); access/risk notes, type, status.
- **ServicePlan** — recurring service agreement for a Property; `price`,
  `cleanMethod`, `paymentMethod`, `nextDueDate`, `lastCompleted` (frequency lives
  on Round, not here).
- **Round** — geographic cluster + cadence unit; `name`, `defaultDay`,
  `frequency`, `status` (DRAFT/ACTIVE/ARCHIVED); optional ServiceArea. **No
  technician FK** — "who does this round" is derived from per-`Visit.technicianId`
  (Decision 2, migration `20260706211550`).
- **Technician** — field operative; `profileId` **nullable** (null = invited, not
  yet accepted); operational `role` (e.g. Senior/Trainee — not the auth role),
  `phone`, `active`.
- **TechnicianServiceArea** — explicit many-to-many join (Technician ↔ ServiceArea).
- **Visit** — one clean of one property on one date; the operational spine;
  `status`, `price`, `paymentHold`, `isOneOff`, photos/issues relations.
- **Complaint** — customer quality complaint with a workflow: `status`,
  `severity`, `revisitDate`, two-way `messages` thread, `photos`.
- **Issue** — lightweight operational exception tied to a Visit (e.g. gate
  locked, access problem); feeds "Issues" KPIs.
- **Invoice** — a bill for a Visit; `invoiceNumber` (unique), `amount`, `status`,
  `sentToCustomer`.
- **Payment** — a payment record; `method`, `status`, `gocardlessId`/`stripeId`;
  drives Debt Board buckets.
- **Message** — outbound/inbound message (SMS/WhatsApp/Email) to a Customer or
  Technician; optional Complaint-thread link and MessageTemplate.
- **MessageTemplate** — reusable message template (e.g. "Gentle Reminder").
- **Service** — service-catalogue entry (`name`, `category`, `defaultPrice`,
  `active`).
- **ServiceArea** — geographic area (`name`, `postcodeSector`, `isDefault`).
- **Photo** — a photo linked to Property/Visit/Complaint; `type`
  (PROPERTY/BEFORE/AFTER).
- **ActivityLog** — timestamped audit-log entries (System Activity Log).
- **BusinessSettings** — single config row, DB-guarded singleton via
  `uniqueId @unique @default("singleton")`; business profile, working days,
  currency, bank details (Json), `setupCompleted` flag (Setup Wizard).

**Open question status:** OQ#1–#12 from the original `designFindings.md` audit are
resolved (OQ#8 → **`Property.roundId` nullable**: declining assignment still
creates/saves the property unassigned, assignable later, not auto-queued). The
**2026-07-07 design update** adds **OQ#13** (technician "unable to attend"
self-mark trigger — unresolved) plus mobile OQs MOB-1/2/3. See **Schema Decisions
& Implications (2026-07-07 Design Update)** below.

**Note:** the 2026-07-07 update's **Decision 2 (remove `Round.technicianId`) is
applied** (migration `20260706211550`). Other schema items from that update remain
Pending/Deferred — see below.

### Infrastructure

- **Supabase project.** Ref `cixtfdnuwbmxvilkvihv`, region `ap-northeast-1`.
  - Runtime → pooler: `...pooler.supabase.com:6543/postgres?pgbouncer=true`
    (`DATABASE_URL`).
  - Migrations → direct: `...pooler.supabase.com:5432/postgres` (`DIRECT_URL`).
  - JWKS → `https://cixtfdnuwbmxvilkvihv.supabase.co/auth/v1/.well-known/jwks.json`
    (serves an ES256 / EC P-256 key with a `kid`).
- **Postgres trigger (`handle_new_user`) — created in Supabase, NOT in this repo.**
  Intended behavior: fire on new-user signup (AFTER INSERT on `auth.users`) and
  insert a matching `Profile` row so every authenticated user has a public-schema
  profile. ⚠️ **Unconfirmed from the codebase:** the trigger's exact SQL — its
  name is assumed (`handle_new_user`), and how it derives `Profile.name` and which
  `role` it assigns are **not verified here** (the definition lives in Supabase,
  not version-controlled). Before relying on it, dump the trigger/function from
  Supabase and, ideally, commit it as a SQL migration so it's reproducible.
- **Seed file (`prisma/seed.ts`) — dev-only.** Idempotent (fixed IDs + upserts).
  Creates: 1 `BusinessSettings` ("RoundFlow Demo Co"), 1 admin `Profile` with a
  **placeholder** `supabaseUserId` (`dev-placeholder-admin-no-supabase-user` — no
  real auth.users row), 1 `Technician` linked to that admin Profile (boot
  convenience, not a real technician), 2 `ServiceArea` (Alnwick, Morpeth), 1
  DRAFT `Round` ("Alnwick Monday"). Purpose: boot the app / render the Round
  Planner without empty-state errors. Not for production.

### Backend

- **Express server (`src/index.ts`).** Middleware: `cors()` (all origins for now)
  and `express.json()`. Routes: `GET /health`, `GET /auth/me`. A centralised
  4-arg error handler (logs, returns 500 `{ error: "Internal Server Error" }`) is
  registered last. Listens on `PORT` env or 3000. Exports `app`.
- **`requireAuth` middleware (`src/middleware/requireAuth.ts`).** Reads
  `Authorization: Bearer <token>`. Verifies via the Supabase **JWKS** endpoint
  using `jwks-rsa` as the key provider (resolves the public key by the token's
  `kid`) and `jwt.verify(..., { algorithms: ["ES256"] })`. On success attaches
  `req.user = { supabaseUserId (from sub), email, role }` and calls `next()`; on
  missing/invalid token returns 401 `{ error: "Unauthorized" }`. Keys cached 10h,
  rate-limited. Verifies signature + algorithm + expiry (no audience/issuer check
  currently).
- **`GET /health`** — liveness check. Returns 200
  `{ status: "ok", timestamp: <ISO> }`. Unprotected.
- **`GET /auth/me`** — protected by `requireAuth`. Looks up the `Profile` by
  `req.user.supabaseUserId` and returns it (404 if none). **Temporary** route to
  verify the end-to-end auth chain; to be replaced by real domain routes.
- **Setup Wizard (`/setup/*`, all `requireAuth`)** — first real domain surface,
  implementing Screen 6 (8-step wizard). Architecture (OCP/SOLID): **all logic +
  DB access live in `src/services/setup.service.ts`** behind the `ISetupService`
  interface; routes (`src/routes/setup.ts`) are thin (validate → call service →
  respond). Every service method takes `profileId` first — the **Phase 2
  multi-tenancy seam** (unused for scoping in Phase 1's single tenant). Endpoints:
  - `GET /setup/status` → per-step completion (**derived**, not stored) +
    `setupCompleted` + `allRequiredComplete`. Step 1 = `businessName` set; 3 =
    ≥1 Service; 4 = `defaultCycleLength` set; 6 = ≥1 Technician; 7 = ≥1
    ServiceArea; 8 = ≥1 `ACTIVE` Round. Steps 2 & 5 are always `{deferred:true}`.
  - `POST /setup/step/1` (Business Profile → **upsert** singleton), `step/3`
    (Service catalogue → **replace**: delete-then-recreate in a `$transaction`),
    `step/4` (Round Settings → **upsert** singleton), `step/6` (invite-pending
    Technicians, `profileId=null` → **replace invite-pending only**: deletes
    `profileId IS NULL` then recreates in a `$transaction` — accepted technicians
    are never touched), `step/7` (ServiceAreas → **replace**: delete-then-recreate
    in a `$transaction`), `step/8` (first Round, `status=ACTIVE` → **upsert** the
    single ACTIVE round). Every step POST is **idempotent / re-edit safe** — a
    second POST replaces or updates, never appends. Service methods renamed to
    match: `saveTechnicians` (was `createTechnicians`), `saveServiceAreas` (was
    `createServiceAreas`), `saveFirstRound` (was `createFirstRound`). `GET`
    variants return existing rows.
  - `GET/POST /setup/step/2` & `/step/5` → deferred stubs (Payment / SMS), no DB.
  - `POST /setup/complete` → `SetupService.completeSetup()`: **409** if already
    complete, **400** listing missing required steps, else sets
    `setupCompleted=true` and returns the status.
  - Every mutating step route calls `assertSetupIncomplete` first (throws typed
    **`AppError` 403** once setup is complete). `AppError` (`src/lib/app-error.ts`)
    is mapped to `{ error, statusCode }` by the centralised error handler.
- **Settings API (`/settings/*`, all `requireAuth`)** — the **post-completion
  editing surface** for the same data the Setup Wizard seeds (design:
  `docs/SETTINGS_API_DESIGN.md`). Built as a **separate service**
  (`src/services/settings.service.ts`, `ISettingsService` interface) — does **not**
  extend or modify `SetupService`. Same OCP discipline: **`profileId`-first** on every
  method; the singleton `where: { uniqueId: "singleton" }` lives in **exactly one place**
  (the `SINGLETON` const, touched only by two private seam methods `getSettings()` (read)
  / `writeSettings()` (write) — never a business method or route). Routes
  (`src/routes/settings.ts`) are thin (validate → call service → respond); **no
  `assertSetupIncomplete`**. Instead, all mutating endpoints (PATCH, POST, DELETE)
  call `assertSetupComplete` first — throws `AppError(403, "Setup must be completed
  before editing settings. Complete the Setup Wizard first.")` if `setupCompleted =
  false` or the singleton does not exist. GET endpoints are **not** guarded (stay open
  so the Setup Wizard can read back saved values). This creates a clean **mutual
  exclusivity**: `/setup/*` mutations require setup to be *incomplete*; `/settings/*`
  mutations require setup to be *complete*. 21 endpoints across 7 sections:
  - **Business Profile** — `GET`/`PATCH /settings/business-profile` (partial upsert of
    step-1 fields only; omitted = untouched, null clears; never touches round fields).
  - **Round Settings** — `GET`/`PATCH /settings/round-settings` (partial upsert of
    `defaultCycleLength` + `defaultWorkingDays`; `defaultCleanMethod`/`autoGenerateVisits`
    P1-nice and reminder timing P2 are **not** in the schema, deliberately omitted).
  - **Service Catalogue** — `GET` · `POST` (create, 201) · `PATCH /:id` · `DELETE /:id`.
    **Delete guard:** `409` if any `ServicePlan`/`Visit` references the service; `404` if
    not found.
  - **Service Areas** — `GET` (each with derived read-only `linkedRounds` {count, names}
    from `Round.serviceAreaId`) · `POST` · `PATCH /:id` · `DELETE /:id`. **Delete guard:**
    `409` if any `Round`/`Property` references the area; `404` if not found.
  - **Technicians** — `GET` (each with derived `displayName` = `profile?.name ?? name`
    and `appStatus` ∈ `PENDING_INVITE`/`ACTIVE`/`INACTIVE`) · `POST` (single invite-pending
    create, `profileId=null`) · `PATCH /:id` · `DELETE /:id`. **Delete guard:** only
    invite-pending (`profileId=null`) deletable; `409` if the invite was accepted; `404`
    if not found.
  - **Payment Setup** — `GET` (singleton payment fields) · `PATCH` (rules only:
    `paymentRule`/`vatInInvoices`/`debtHoldEnabled` — does **not** touch connect flags) ·
    `POST /:provider/connect` (Phase-1 **stub**: flips `gocardlessConnected`/`stripeConnected`
    true, returns `{ status: "connected" }`; provider-agnostic + swap-neutral for Phase-2 GHL).
  - **SMS Templates** — `GET`/`PATCH /settings/message-templates` → deferred stub
    `{ status: "deferred", source: "ghl" }`, no DB access (GHL owns messaging in Phase 2).
  - Mounted in `src/index.ts` (`app.use("/settings", settingsRouter)`); all 21 operations
    documented under the **Settings** tag in `src/swagger.ts` (+ `PaymentTiming` enum,
    `404`/`NotFound` response, and derived-response schemas).

### Security Hardening (PR review — 2026-07-09)

A senior-engineer PR review flagged that the codebase had **authentication but no
authorization**, plus several input-validation gaps. The 🔴 Critical items were
fixed in this pass (🟡/🟠 items are deferred to a later pass):

- **Authorization layer added (`src/middleware/requireRole.ts`).** `requireAuth`
  proves *who* the caller is; it never proved *what they may do*. New
  `requireRole(...roles)` loads the caller's `Profile` by `supabaseUserId` and
  checks the **app role** (`Profile.role`) — not the raw JWT `role` claim, which
  for Supabase is always `"authenticated"`. It attaches `req.profile`, returns
  **403 `{ error: "Insufficient permissions" }`** when the role is not allowed or
  no Profile exists, and **401** if `requireAuth` did not run first. A
  `requireBusinessAccess()` convenience guard is applied once per router
  (`/setup`, `/settings`): **GETs** allow `ADMIN`/`MANAGER`/`TECHNICIAN`;
  **mutations (POST/PATCH/DELETE)** require `ADMIN`/`MANAGER`. `req.profile` was
  added to the Express `Request` type alongside `req.user`.
  *Why:* previously any authenticated Supabase user (and the signup trigger makes
  every signup `ADMIN`) could wipe the service catalogue, delete technicians, or
  complete setup — anonymous-to-admin data destruction if signup is open.
- **`defaultWorkingDays` element validation (`src/lib/validation.ts`
  `validateWorkingDays`).** Both routers now reject any array element that isn't a
  valid `DayOfWeek` with a **400** (previously `["FUNDAY"]` / non-strings were
  persisted or 500'd at the driver). One shared validator, called in both
  `/setup` and `/settings`.
- **`defaultCycleLength` validation (`assertPositiveInt`).** Both routers now
  require a **positive integer** (was: any finite number — `3.5`/`-7`/`0` slipped
  past route validation and either 500'd against the `Int` column or stored
  nonsense).
- **Swagger required-steps corrected.** Three locations in `src/swagger.ts` said
  required steps were `1,3,4,6,7,8` / that step 2 is deferred — contradicting the
  code, which requires step 2 (`paymentRule != null`). Now consistently
  **`1,2,3,4,6,7,8`; only step 5 is deferred.**
- **`requireAuth` rejects tokens with no `sub`.** A token whose subject is missing
  or empty now returns **401** instead of continuing with an empty-string user id.

Typecheck (`tsc --noEmit`) clean after the changes. **Deferred (not yet fixed):**
FK indexes, the incomplete Phase-2 tenant seam / `profileId` naming, PgBouncer
interactive-transaction verification, `@db.Money`, and the duplicated route
helpers — tracked from the same review.

**Known performance consideration (Phase 2 planning).** `requireRole` calls
`prisma.profile.findUnique()` on every authenticated request to load the caller's
app role. This is correct and safe for Phase 1 (single-tenant, low traffic).
Before Phase 2 or any significant load, consider caching the Profile lookup (e.g.
a short-lived in-memory cache keyed by `supabaseUserId`, or attaching the role to
a custom JWT claim set at login so no DB lookup is needed). **Do not optimise
now** — noted for Phase 2 planning.

### Code quality pass (PR review — 🟡/🟠, 2026-07-11)

Follow-up pass addressing the non-critical review findings. **No schema changes,
no migrations** — code-only. `tsc --noEmit` clean; `prisma db seed` clean.

- **Phase 2 seam comments corrected (🟡/🔵).** The comment blocks in
  `setup.service.ts` and `settings.service.ts` claimed Phase 2 multi-tenancy was a
  "swap of two methods" / "nothing else changes." That was false for everything
  except `BusinessSettings`. Both now carry an **honest `PHASE 2 TENANT SEAM`
  assessment**: the seam genuinely covers `BusinessSettings` (one-place
  `getSettings`/`writeSettings` change), but Phase 2 also requires a tenant FK on
  every operational table (migration + backfill), scoping ~30 unscoped queries,
  making `BusinessSettings.uniqueId` and `Invoice.invoiceNumber` per-tenant, and a
  separate `tenantId` resolver (the current actor id is the wrong grain — tenancy
  resolves from the GHL install/location, not the acting user). The interface
  boundary and thin routes are correct and unaffected.
- **`profileIdOf` → `actorIdOf` (🟡).** The route helper returned
  `supabaseUserId`, not `Profile.id` (a cuid) — the name was misleading and
  conflated the identifier with the future Phase-2 `tenantId`. Renamed in both
  routers with a comment documenting the distinction. No `profileIdOf` references
  remain in code (only in the explanatory comment).
- **Shared route helpers extracted to `src/lib/http.ts` (🟠).** The generic
  request plumbing (`asObject`, `asArray`, `Handler`, `h`, `requireString`,
  `requireNumber`, and the `opt*` validators) was duplicated across the two
  routers with divergent names (`reqString`/`reqNumber` vs `requireString`/
  `requireNumber`). Now defined **once** in `src/lib/http.ts` and imported by both;
  the settings router's `reqString`/`reqNumber` call sites were unified to the
  canonical names. Domain-specific validators (`validateWorkingDays`,
  `assertPositiveInt`, `optWorkingDays`, `optCycleLength`, `optCategory`,
  `optPaymentTiming`, `actorIdOf`) deliberately **stay** in their routers / in
  `src/lib/validation.ts`.
- **Single-default `ServiceArea` enforced (🟠).** Nothing prevented multiple areas
  flagged `isDefault: true`. `settings.service.ts` `createServiceArea` /
  `updateServiceArea` now clear other defaults in an **array-form `$transaction`**
  before writing (create clears all; update clears all *other* rows via
  `id: { not: id }`). `setup.service.ts` `saveServiceAreas` rejects an input array
  with more than one default via **`AppError(400, "Only one service area can be
  marked as default.")`** before any DB write. *(Application-level invariant, not a
  DB constraint — a partial unique index would make it race-proof but requires a
  migration, deferred.)*

**Schema migrations (PR review — 🟡/🟠, 2026-07-14).** The three schema-level
review findings were addressed as three ordered migrations (tables hold only seed
data, so all are safe; `tsc --noEmit` clean, `prisma db seed` clean,
`prisma migrate status` → "up to date"):

- **`20260714010004_add_fk_indexes` (🟡 #8).** Added `@@index` to all 26 unindexed
  foreign-key scalar columns across Property (customerId/serviceAreaId/roundId),
  ServicePlan (propertyId/serviceId), Round (serviceAreaId), TechnicianServiceArea
  (serviceAreaId — the composite-PK *trailing* column, not covered by the PK's
  leading `technicianId`), Visit (serviceId/propertyId/roundId/servicePlanId/
  technicianId), Complaint (customerId/propertyId/technicianId), Issue
  (visitId/propertyId), Invoice (customerId), Payment (customerId), Message
  (customerId/technicianId/complaintId/templateId), and Photo
  (propertyId/visitId/complaintId). `@unique` FKs (`Technician.profileId`,
  `Invoice.visitId`, `Payment.visitId`) were skipped — already indexed. *Why:*
  Postgres does not auto-index FK columns; every join and delete-guard `count()`
  was a sequential scan that degrades as Visits/Payments grow.
- **`20260714010107_service_area_updated_at` (🟠 #11).** Added
  `updatedAt DateTime @updatedAt` to `ServiceArea` — the only mutable model lacking
  a modification timestamp. Hand-edited the generated SQL to backfill existing rows
  (`DEFAULT CURRENT_TIMESTAMP`) then `DROP DEFAULT`, since a bare `ADD COLUMN … NOT
  NULL` fails on the non-empty (seeded) table; the dropped default matches how
  Prisma manages `@updatedAt` at the app layer.
- **`20260714010321_money_to_decimal` (🟠 #12).** Replaced every `@db.Money` with
  `@db.Decimal(10, 2)` (Service.defaultPrice, ServicePlan.price, Visit.price,
  Invoice.amount, Payment.amount). Postgres has no implicit `money → numeric`
  assignment cast, so the generated `SET DATA TYPE` SQL was hand-edited to add an
  explicit `USING "col"::numeric` per column (verified via `--create-only` before
  applying). *Why:* `money` is locale-dependent and a poor fit for a
  currency-configurable product.

**Auth hardening (PR review, 2026-07-16).** `requireAuth`'s `jwt.verify` now also
enforces **`audience: "authenticated"`** and **`issuer: SUPABASE_ISSUER`** (the
project auth URL, extracted as a top-of-file constant and reused for the JWKS
URI) — previously only `algorithms: ["ES256"]` was checked, so a validly-signed
token from another Supabase project could be replayed against this API. Closes the
remaining auth-hardening note.

**Review status:** all 🔴/🟡/🟠 findings from the PR review are now resolved. The
PgBouncer interactive-transaction concern (🟡 #7) was **verified**, not deferred —
see the confirmed item under *Verified Working*.

## Verified Working

Each item was actually run and observed:

- [x] **`tsc --noEmit`** → exit 0 (typecheck clean). Method: `npx tsc --noEmit`.
- [x] **`npm install`** → 0 vulnerabilities. Method: `npm install` / `npm audit`.
- [x] **Migration applied to Supabase** (`20260701220655_init`). Method:
  `prisma migrate dev --name init` against `DIRECT_URL`.
- [x] **Seed rows exist in Supabase.** Method: Prisma `count()` queries against
  the live DB → `Profile 1, Technician 1, ServiceArea 2, Round 1,
  BusinessSettings 1`, all operational tables `0`.
- [x] **`GET /health` → 200** with `{status,timestamp}`. Method: `curl`.
- [x] **`GET /auth/me` with no token → 401** `{ error: "Unauthorized" }`.
  Method: `curl` (no Authorization header).
- [x] **JWKS endpoint reachable & ES256.** Method: `curl` the well-known URL →
  returns an `alg: ES256`, `kty: EC`, P-256 key with a `kid`.
- [x] **Setup Wizard: `tsc --noEmit` → 0 and `prisma db seed` → clean** (with the
  new `setupCompleted` column / migration `20260706220349`).
- [x] **`/setup/*` mounted + auth-protected.** Method: `curl` with no token →
  `GET /setup/status` and `POST /setup/step/1` both `401 {error:"Unauthorized"}`.
- [x] **SetupService logic (driven directly against the live DB — no JWT).** On a
  simulated fresh tenant: `getStatus` → all required steps incomplete (2/5
  deferred); `saveBusinessProfile` → step 1 flips `complete`; `completeSetup` with
  only step 1 → `AppError 400` listing missing steps (3,4,6,7,8). DB restored via
  re-seed afterwards.
- [x] **`GET /auth/me` with a real ES256 token → 200 + Profile.** Method: Supabase
  password-grant token → `curl /auth/me -H "Authorization: Bearer <token>"` →
  returned `{ supabaseUserId, role: "ADMIN", name, ... }`. Confirms the full
  positive auth path: token → JWKS/ES256 verify → `req.user` → Profile lookup.
- [x] **`handle_new_user` trigger creates the Profile on signup — behaviour
  confirmed.** The real user's Profile exists with **`role = ADMIN`** and **`name`
  = the email local-part** (`maazk101103` from `maazk101103@gmail.com`). So the
  trigger assigns role ADMIN and derives the name from the email prefix. *(The
  trigger SQL itself is still not version-controlled — see Known Placeholders /
  Decisions Pending.)*
- [x] **Production build works.** `npm run build` (clean → typecheck → emit) →
  `dist/index.js` (+ `lib`/`middleware`/`routes`/`services`); `node dist/index.js`
  boots and `GET /health` → 200. Method: `npm run build`, then `node dist/index.js`
  + `curl`.
- [x] **Setup steps 6/7/8 re-edit safety.** Driven directly against the live DB: a
  second `saveTechnicians` / `saveServiceAreas` / `saveFirstRound` **replaces (6/7)
  or updates (8)**, never appends — save techs `[A,B]` then `[C]` → accepted + `[C]`
  (total 2, not 4); save areas `[X,Y]` then `[Z]` → `[Z]` only; two `saveFirstRound`
  calls keep a **single ACTIVE round** (same id, fields updated). Accepted
  technicians (real `profileId`) preserved. DB restored via re-seed afterwards.
- [x] **Settings completion guard verified.** `assertSetupComplete` throws
  `AppError(403)` with the correct message when `setupCompleted = false`; passes when
  `setupCompleted = true`. Confirmed **14 mutating ops carry 403** in the OpenAPI spec;
  **0 GET ops** do. Direct-service test run against the live DB.
- [x] **Interactive `$transaction` (callback form) commits and rolls back
  atomically under the PgBouncer transaction-mode pooler** — confirmed by a
  deliberate-rollback test against the live Supabase DB. (A temporary `_tx_test.ts`
  created a `ServiceArea` inside a transaction, proved it visible inside, threw to
  force rollback, and confirmed the row was absent outside; script deleted after
  passing.) Resolves the last remaining PR-review item (🟡 #7).

**Not yet verified (do not assume working):**

- [ ] `/setup/*` **over HTTP with a real token** — the shared `requireAuth` layer
  is now proven with a real token (via `/auth/me`), but the specific setup
  endpoints haven't yet been exercised over HTTP with a token (their service logic
  is proven directly against the DB). See `docs/API_SETUP.md` for the contract to
  test against.

## Known Placeholders / Dev-Only Items

- **Seed `supabaseUserId` is a placeholder** (`dev-placeholder-admin-no-supabase-user`)
  with no matching `auth.users` row — `GET /auth/me` will not find this Profile
  from a real token. Replace once a real admin signs up.
- **Seed Technician is linked to the admin Profile** for boot convenience; real
  technicians get their own TECHNICIAN-role Profile.
- **CORS allows all origins** (`app.use(cors())`) — tighten to the frontend
  origin(s) before production.
- **`handle_new_user` trigger is not version-controlled** — capture it as a SQL
  migration so it's reproducible across environments.
- **No production runtime hardening** — a `dist/` build now exists (`npm run
  build` → `npm run start:prod`), but there's still no process manager,
  deploy-grade health/readiness, or structured logging yet.
- **Error handler returns generic 500s** — fine for now; no error typing/logging
  strategy.
- **`.env` contains `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`** that no backend
  code consumes (Google OAuth is Supabase-side) — present for reference only.

## What's Next

Ordered by the core operational loop
(Property → Service Plan → Visit Generation → Round Planner → Today's Work →
Mobile Completion → Payments):

1. **Property + Customer CRUD** — create/read/update properties and customers
   (incl. the Add Property flow that also creates the customer). First real
   domain routes; replaces the temporary `/auth/me` as the "does the stack work"
   proof.
2. **Service Plans** — attach recurring plans (price, clean method, payment
   method, next-due) to properties.
3. **Rounds + assignment** — Add Round wizard data (area, day, frequency,
   technician, properties), including unassigned-property handling.
4. **Visit generation** — the backend cron (`node-cron` or equiv.) that creates
   Visits from Service Plans on their due dates, honoring payment holds.
5. **Round Planner reads** — calendar/map/list endpoints over rounds + visits.
6. **Today's Work** — live day view (in-progress rounds, per-visit status).
7. **Mobile completion** — technician actions (start/complete/skip/access issue),
   once the native-vs-mobile-web decision is made.
8. **Payments + Debt Board** — Stripe/GoCardless collection post-completion,
   invoice generation, debt bucket computation.
9. Cross-cutting: Complaints workflow, Messaging (GHL), Reports/ActivityLog,
   Settings.

## Schema Decisions & Implications — 2026-07-07 Design Update

Context: `docs/designFindings.md` was re-audited after a design update — five admin
changes (multi-technician rounds, technician job-status, technician reassignment,
Add Round quick action, add-properties-to-existing-rounds) plus a **new mobile app**
(RoundFlow Technician / "B2C"). **Nothing in `prisma/schema.prisma` or
`prisma/seed.ts` has changed yet** — this records decisions + the review queue
before we touch the schema.

### Decisions made (Approved)

1. **Per-occurrence assignment → Option A (derived; no new model).** *(No schema
   change — applies at visit-generation build time.)* An "occurrence" is simply the
   group of `Visit`s sharing a `Round` + cycle date. The 3-step assignment wizard
   (Select Technicians → Allocate Jobs → Review) sets **`Visit.technicianId` per job
   when visits are generated**. **No `RoundOccurrence` model for Phase 1.**
   Rationale: `Visit`s already are the per-date instances, and per-job technician is
   exactly what "manually divide the N jobs between them" needs.
2. **Remove `Round.technicianId` (single FK).** ✅ **IMPLEMENTED 2026-07-07** —
   migration `20260706211550_remove-round-technician-id` drops the column + FK
   constraint. With assignment now per-`Visit`, a round's "assigned technicians" is
   **derived** from the distinct `Visit.technicianId` values across its current
   occurrence. Also removed the now-dangling `Technician.rounds` back-relation; the
   seed's `Round` upsert no longer sets `technicianId`.

### Schema implication review queue (from Step 4)

| # | Implication | Status | Note |
|---|-------------|--------|------|
| 1 | `Round.technicianId` single FK → many-to-many join table | **Rejected** | m2m superseded by Decision 2. ✅ Column + FK **removed** (migration `20260706211550`); `Technician.rounds` back-relation dropped; seed updated. |
| 2 | `RoundOccurrence` entity (per-occurrence assignment) | **Deferred** | Decision 1: derived (Option A) for Phase 1. Revisit only if per-occurrence divergence later needs first-class modelling. |
| 3 | Manual job division via existing `Visit.technicianId` | **Approved (no change)** | Mechanism already exists; set at visit generation. Add app-level rule: a visit's technician ∈ the round's assigned set. |
| 4 | Technician **availability** status (Available / Unavailable / On-leave + date) | **Pending** | `Technician` has only `active: Boolean`. Needs an availability enum + leave date/range. Drives reassignment; ties to OQ#13. |
| 5 | Technician **invite/onboarding** entity (invite code) | **Pending** | Mobile invite-code + Complete Profile. `Technician.profileId` nullable models "invited"; no invite-token entity. Decide: `Invitation` model vs. Supabase invite flow. |
| 6 | **Notifications** feed entity | **Pending** | Mobile Notifications screen (schedule / round / payment). No notification entity (`ActivityLog` is an admin audit log). Likely lands with the mobile build. |
| 7 | **Skip reason** enum | **Pending** | Mobile SkipSheet: Not home / No access / Customer refused / Unsafe conditions / Other. Currently `Visit.skipReason` is a free `String`. |
| 8 | Access-issue description → `Issue.note` | **Approved (no change)** | Mobile AccessIssueSheet maps to existing `Issue` (type `ACCESS_PROBLEM` + `note`). Confirm the action creates an `Issue`. |
| 9 | Per-round **assignment history** | **Pending** | Screen 30 "Recent Activity / Assignment History". `ActivityLog` exists but is unlinked. Decide extend vs. dedicated table. |
| 10 | Cash payment → `Payment.method = CASH` | **Approved (no change)** | Already supported. |

**Sequencing when we build:** apply Decision 2 (remove `Round.technicianId`) + the
seed fix first; then resolve Pending #4 (availability), since it drives the
reassignment flow. Items #5 / #6 / #9 likely land with the mobile + notifications
work; #7 is a cheap enum swap.

## Decisions Pending

- **GHL automation trigger mechanism** — how the backend fires GHL
  messaging/payments: write to a synced GHL Contact's custom fields and let a GHL
  Workflow watch for the change, vs. call the GHL API directly. Not decided;
  resolve before building visit-generation/payment logic against it.
- **Mobile completion delivery** — native app (React Native/Expo) vs. mobile
  web. Not decided; blocks the mobile completion flow.
- **`handle_new_user` trigger provenance** — decide to commit the trigger SQL as
  a migration (recommended) vs. leave it Supabase-managed out of band.
- **Auth hardening** — whether to add `audience`/`issuer` checks (and possibly
  role/claims validation) to `requireAuth` before production.
- **Custom app roles in JWT** — currently `req.user.role` is the raw Supabase JWT
  claim (`authenticated`), not the app role (ADMIN/MANAGER/TECHNICIAN, which
  lives on `Profile`). Decide whether protected routes read the app role from
  `Profile` per request (current implicit approach) or via custom JWT claims.
- **Schema items from the 2026-07-07 design update** — technician availability
  status (#4), invite entity (#5), notifications feed (#6), skip-reason enum (#7),
  assignment history (#9). Full status table in **Schema Decisions & Implications
  — 2026-07-07 Design Update** above.
