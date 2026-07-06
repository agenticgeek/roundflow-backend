# RoundFlow Backend — Progress Log

> Living document. Last updated: 2026-07-03 · Branch: `dev` · HEAD: `2abb18d`
> Written by reading the codebase directly. If a claim isn't backed by code or a
> run, it's flagged as unverified. Update this file as the backend grows.

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
├── package.json                   # Deps + scripts (dev/start/seed/prisma:*). Prisma seed config.
├── package-lock.json              # Lockfile.
├── tsconfig.json                  # TS config: Node16 module/resolution, strict, noEmit-style typecheck.
├── prisma/
│   ├── schema.prisma              # 19 models + enums; datasource (url + directUrl); prisma-client-js generator.
│   ├── seed.ts                    # Idempotent dev seed (BusinessSettings, admin Profile, Technician, 2 areas, 1 round).
│   └── migrations/
│       ├── 20260701220655_init/migration.sql   # Single migration: full schema (all tables/enums).
│       └── migration_lock.toml    # Prisma migration provider lock (postgresql).
└── src/
    ├── index.ts                   # Express app: cors + json, GET /health, GET /auth/me, error handler, listen.
    ├── lib/
    │   └── prisma.ts              # Shared PrismaClient singleton (globalThis-cached for dev hot-reload).
    └── middleware/
        └── requireAuth.ts         # JWKS/ES256 Bearer-token verification; attaches req.user; 401 on failure.
```

Note: there is **no compiled build step yet** — the app runs TypeScript directly
via `tsx` (`npm run dev` / `npm start`). `tsc` is used only for typechecking
(`tsc --noEmit`). `tsconfig.json` sets `outDir: dist` but no `build` script emits.

## What's Built

### Database & Schema

Locked Prisma schema (`prisma/schema.prisma`), 19 models. One migration applied
(`20260701220655_init`).

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
  `frequency`, `status` (DRAFT/ACTIVE/ARCHIVED); optional ServiceArea + Technician.
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
  currency, bank details (Json).

**Open question status:** All 12 wireframe open questions from `designFindings.md`
are resolved. OQ#8 ("Assign Property Now?" decline path) was resolved as
**`Property.roundId` nullable** — declining assignment still creates/saves the
property in an unassigned state (no round), assignable later; not auto-queued.

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

**Not yet verified (do not assume working):**

- [ ] `GET /auth/me` with a **real valid ES256 token** (full positive auth path:
  token → verified claims → Profile returned). Needs a Supabase-issued JWT from
  the frontend.
- [ ] The `handle_new_user` **trigger actually creating a Profile on a real
  signup** (no real signup has been exercised end-to-end here).
- [ ] Any behavior of the trigger's `name`/`role` logic (SQL not in repo).

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
- **No production build/runtime** — runs via `tsx` (dev). No `dist` build,
  process manager, health/readiness for a real deploy, or structured logging yet.
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
