# RoundFlow Phase 1 — Software Design Specification

> Derived from `PROGRESS.md`, `prisma/schema.prisma`, `docs/designFindings.md`,
> and `docs/RoundFlow_Context_and_Roadmap_v1.md`. **Built** items reflect the
> current codebase (per PROGRESS.md); **Planned** items are proposals derived
> from the screen set and roadmap — proposed route paths are *not yet in code*.

---

## 1. Architecture Overview

### 1.1 Components
- **React web admin app** — separate repo; the admin screen set (Dashboard,
  Round Planner, Today's Work, Customers & Properties, Debt/Payment,
  Reports/History, Complaints, Settings, Technicians). Owns all admin UI + auth UX.
- **Mobile technician app** ("RoundFlow Technician") — field job execution;
  delivery form (native vs mobile web) TBD.
- **Express backend** (Node + TypeScript) — REST API; system of record access;
  all business logic. Runs via `tsx` (no compiled build step yet).
- **Supabase Postgres** — managed database (Prisma ORM 6.19.3), region
  `ap-northeast-1`.
- **Supabase Auth** — identity provider; issues ES256 JWTs; `handle_new_user`
  Postgres trigger creates the `Profile` mirror.
- **GHL (utility, deferred)** — messaging + payment assistance; single account.

### 1.2 Component Interaction (text diagram)
```
   ┌───────────────────┐         ┌──────────────────────┐
   │  Web Admin (React)│         │ Mobile Technician App │
   └─────────┬─────────┘         └───────────┬──────────┘
             │  Supabase JS (auth)           │
             │  + Bearer JWT (ES256)         │
             ▼                               ▼
        ┌──────────────────────────────────────────┐
        │        Express Backend (REST API)         │
        │  requireAuth (JWKS/ES256) → routes → svc  │
        │  services (all logic + DB access)         │
        └───────┬───────────────────────┬──────────┘
                │ Prisma (pooler 6543)    │ (deferred)
                ▼                         ▼
        ┌───────────────┐        ┌──────────────────┐
        │ Supabase      │        │  GHL utility     │
        │ Postgres      │        │  (SMS/WhatsApp/   │
        │ (system of    │        │   Email, payments│
        │  record)      │        │   assist)        │
        └──────┬────────┘        └──────────────────┘
               │ trigger (handle_new_user) on auth.users insert
               ▼
        ┌───────────────┐
        │ Supabase Auth │  ← verifies JWTs via JWKS (well-known endpoint)
        └───────────────┘
```
Auth token flow: frontend authenticates with Supabase → receives ES256 JWT →
sends `Authorization: Bearer <jwt>` to the backend → `requireAuth` verifies it
against Supabase's JWKS endpoint (public key by `kid`).

### 1.3 Why each component (from PROGRESS Architecture Decisions)
- **Prisma 6.19.3 (not 7):** Prisma 7 needs a driver adapter, moves the datasource
  URL into `prisma.config.ts`, drops `directUrl`, and its `migrate dev` bailed in
  the non-TTY environment. Prisma 6 keeps schema-based datasource, the
  `prisma-client-js` generator, and non-interactive `migrate dev`. Chosen for
  stability. *(Note: PROGRESS also records that destructive `migrate dev` prompts
  can't be answered non-interactively — see §3.3.)*
- **Supabase Postgres:** managed DB; also provides Supabase Auth. (Early bring-up
  used local Homebrew Postgres, then moved.)
- **Supabase Auth + ES256 JWKS:** the project signs with ES256 (asymmetric), so
  the backend verifies via JWKS public keys — no shared secret stored. An earlier
  HS256 shared-secret approach rejected real tokens and was removed.
- **Profile via Postgres trigger (not HTTP webhook):** transactional with the user
  insert, no shared secret, no network round-trip, no public unauthenticated
  route. (An earlier `POST /auth/webhook` was built then deleted.)
- **GHL as utility, not platform:** avoids building messaging/payments infra;
  keeps RoundFlow's Postgres as the system of record.

---

## 2. Backend Design

### 2.1 Technology Stack
| Layer | Choice |
|-------|--------|
| Runtime | Node.js + TypeScript, run via `tsx` (dev; no `dist` build yet) |
| Web framework | Express 4 |
| ORM | Prisma 6.19.3 (`prisma-client-js` generator) |
| Database | Supabase Postgres (`ap-northeast-1`) |
| Auth verify | `jsonwebtoken` + `jwks-rsa` (ES256, JWKS) |
| Config | `dotenv` (`.env`) |
| Typecheck | `tsc --noEmit` (Node16 module/resolution, strict) |

### 2.2 Project Structure
Current `src/` layout (per PROGRESS "Current File Structure"):
```
src/
├── index.ts                # Express app: cors + json, /health, /auth/me, /setup router,
│                           #   AppError-aware error handler, listen
├── lib/
│   ├── prisma.ts           # Shared PrismaClient singleton (globalThis-cached)
│   └── app-error.ts        # Typed AppError (statusCode + message)
├── middleware/
│   └── requireAuth.ts      # JWKS/ES256 Bearer verification; attaches req.user; 401
├── services/
│   └── setup.service.ts    # Setup Wizard logic + all DB access (ISetupService — OCP seam)
└── routes/
    └── setup.ts            # Thin /setup routes: validate → call service → respond
```
**Intended layout** (as domains land): one `routes/<domain>.ts` + one
`services/<domain>.service.ts` per domain (Customers/Properties, Rounds, Visits,
Debt, Invoices, Complaints, Reports, Technicians, Settings, Mobile), following the
same thin-route / service-owns-logic pattern established by Setup.

### 2.3 API Design Principles
- **RESTful conventions:** resource-oriented paths; `GET` reads, `POST` creates/
  actions; JSON request/response bodies (`express.json()`). Setup uses
  step-scoped sub-resources (`/setup/step/N`) plus `/setup/status` and
  `/setup/complete`.
- **Auth pattern:** every protected route runs `requireAuth` — reads
  `Authorization: Bearer <token>`, verifies **ES256** against the Supabase **JWKS**
  endpoint (`jwks-rsa` resolves the public key by `kid`; keys cached 10h,
  rate-limited), attaches `req.user = { supabaseUserId, email, role }`, else 401.
- **Error handling:** typed **`AppError(statusCode, message)`** thrown by services;
  a centralised 4-arg Express error handler maps `AppError → { error, statusCode }`
  and everything else → `500 { error: "Internal Server Error" }` (internals logged,
  not leaked). Async route errors are forwarded to the handler.
- **Service layer (OCP seam):** routes are **thin** (validate input → call service
  → respond); **all business logic and DB access live in services**. Services are
  bound behind an interface (e.g. `ISetupService`) and every method takes
  `profileId` first, so a Phase 2 tenant-scoped implementation can be swapped in
  **without touching routes**.

### 2.4 Route Inventory
**Built** = present in code (PROGRESS). **Planned** = proposed from the screen set
(path not yet in code). All non-`/health` routes require a Bearer JWT.

| Method | Path | Auth | Service | Status |
|--------|------|------|---------|--------|
| GET | `/health` | No | — | **Built** |
| GET | `/auth/me` | Yes | (inline; Profile lookup) | **Built** (temporary) |
| GET | `/setup/status` | Yes | SetupService | **Built** |
| POST | `/setup/step/1` (Business Profile) | Yes | SetupService | **Built** |
| GET/POST | `/setup/step/2` (Payment — deferred stub) | Yes | — | **Built** |
| GET/POST | `/setup/step/3` (Service Catalogue) | Yes | SetupService | **Built** |
| POST | `/setup/step/4` (Round Settings) | Yes | SetupService | **Built** |
| GET/POST | `/setup/step/5` (SMS Templates — deferred stub) | Yes | — | **Built** |
| GET/POST | `/setup/step/6` (Technicians, invite-pending) | Yes | SetupService | **Built** |
| GET/POST | `/setup/step/7` (Service Areas) | Yes | SetupService | **Built** |
| GET/POST | `/setup/step/8` (first Round, ACTIVE) | Yes | SetupService | **Built** |
| POST | `/setup/complete` | Yes | SetupService | **Built** |
| — | Customers & Properties CRUD (Add Property flow, list, detail, tabs) | Yes | CustomerService (planned) | **Planned** |
| — | Service Plans | Yes | ServicePlanService (planned) | **Planned** |
| — | Rounds + assignment (Add Round wizard, multi-tech allocation) | Yes | RoundService (planned) | **Planned** |
| — | Visit generation (cron) + Visit reads | Yes / cron | VisitService (planned) | **Planned** |
| — | Round Planner reads (calendar/map/list) | Yes | RoundService (planned) | **Planned** |
| — | Today's Work + Reassign / Push Missed | Yes | VisitService (planned) | **Planned** |
| — | Debt / Payment Risk Board (+ reminders/links) | Yes | DebtService (planned) | **Planned** |
| — | Invoices (generate/preview/send) | Yes | InvoiceService (planned) | **Planned** |
| — | Complaints (log/review/revisit/resolve) | Yes | ComplaintService (planned) | **Planned** |
| — | Reports & History | Yes | ReportService (planned) | **Planned** |
| — | Technicians CRUD + messaging | Yes | TechnicianService (planned) | **Planned** |
| — | Settings sections | Yes | SettingsService (planned) | **Planned** |
| — | Mobile: job list, visit actions, notifications | Yes (JWT) | MobileService (planned) | **Planned** |

*Planned rows omit exact method/path deliberately — those are defined when each
domain is built; the screens indicate the surface, not the URL scheme.*

### 2.5 Data Access Pattern
- **Prisma 6.x** via a **single shared `PrismaClient` singleton** (`src/lib/prisma.ts`),
  cached on `globalThis` so dev hot-reload doesn't exhaust connections.
- **Two connection URLs:** runtime uses `DATABASE_URL` → Supabase **transaction-mode
  pooler** (port 6543, `?pgbouncer=true`); migrations use `DIRECT_URL` → **direct**
  connection (port 5432), because PgBouncer transaction mode can't run migration
  DDL / advisory locks. Both are declared in the `schema.prisma` datasource block.
- Services perform all reads/writes; the `BusinessSettings` singleton is looked up
  by `uniqueId = "singleton"`.

---

## 3. Database Design

### 3.1 Schema Overview
19 models + 16 enums (`schema.prisma`). Screen citations from `designFindings.md`.

**Auth / identity**
- **Profile** — public-schema mirror of Supabase `auth.users`. Key fields:
  `supabaseUserId` (unique join key), `role` (`UserRole`), `name`. Relations: 1:1
  `Technician?`. Source: Login/signup (Screens 1–5).

**Customers & properties**
- **Customer** — a customer/contact. Fields: `name`, `phone`, `email`, `status`
  (`LifecycleStatus`), `ghlContactId` (GHL join), `paymentMethod`, `badDebt`.
  Relations: many `Property`, `Invoice`, `Payment`, `Message`, `Complaint`.
  Source: Screens 14/15; created via Add Property (M6).
- **Property** — a physical site to clean. Fields: `addressLine`, `postcode`,
  `propertyName?`, `propertyType?`, `accessNotes?`, `riskNotes?`, `status`,
  `roundId?` (**nullable = unassigned**, OQ#8). Relations: `Customer`,
  `ServiceArea?`, `Round?`, many `ServicePlan`/`Visit`/`Photo`/`Issue`/`Complaint`.
  Source: Screens 14/15/31; M6.
- **ServicePlan** — recurring service agreement for a property. Fields: `price`
  (`Money`), `cleanMethod?`, `paymentMethod?`, `status`, `nextDueDate?`,
  `lastCompleted?`; `serviceId?` → catalogue. (Frequency lives on `Round`.)
  Source: Customer Detail Service Plan tab (Screen 15).

**Scheduling**
- **Round** — geographic cluster + cadence unit. Fields: `name`, `defaultDay?`
  (`DayOfWeek`), `frequency?` (`CleaningFrequency`), `description?`, `status`
  (`RoundStatus`), `serviceAreaId?`. **No technician FK** — "who does this round"
  is derived from per-`Visit.technicianId`. Source: Screens 8–11, 30; Add Round.
- **Visit** — one clean of one property on one date (the operational spine).
  Fields: `date`, `status` (`VisitStatus`), `price` (`Money`), `paymentHold`,
  `isOneOff`, `serviceId?`, `skipReason?`, `notes?`, `completedAt?`, `technicianId?`
  (per-job assignment). Relations: `Property`, `Round?`, `ServicePlan?`,
  `Technician?`, `Invoice?`, `Payment?`, `Photo[]`, `Issue[]`. Source: Screens
  12/13/10, M2.
- **Technician** — field operative. Fields: `profileId?` (**null = invited**,
  unique), `role?` (operational, not auth role), `phone?`, `active`, `avatarUrl?`.
  Relations: `Profile?`, `TechnicianServiceArea[]`, `Visit[]`, `Message[]`,
  `Complaint[]`. Source: Screens 25–29.
- **TechnicianServiceArea** — explicit m:n join Technician ↔ ServiceArea
  (`assignedAt`). Source: Technician card "service areas" (Screen 25).

**Exceptions**
- **Complaint** — customer quality complaint with workflow. Fields: `title`,
  `description?`, `issueType?`, `severity` (`Severity`), `status`
  (`ComplaintStatus`), `revisitDate?`. Relations: `Customer`, `Property?`,
  `Technician?`, `Message[]`, `Photo[]`. Source: Screens 20–22.
- **Issue** — lightweight operational exception on a visit. Fields: `type`
  (`IssueType`), `note?`. Relations: `Visit`, `Property?`. Source: Screen 13
  flags; Dashboard "Issues".

**Billing**
- **Invoice** — a bill for a visit. Fields: `invoiceNumber` (unique), `amount`
  (`Money`), `status` (`InvoiceStatus`), `notes?`, `sentToCustomer`, `sentAt?`.
  Relations: `Customer`, `Visit?` (unique). Source: M4/M5/M10.
- **Payment** — a payment record. Fields: `amount` (`Money`), `method`
  (`PaymentMethod`), `status` (`PaymentStatus`), `gocardlessId?`, `stripeId?`,
  `contactedAt?`, `paidAt?`. Relations: `Customer`, `Visit?` (unique). Source:
  Screens 15/16.

**Messaging**
- **Message** — SMS/WhatsApp/Email to a customer or technician. Fields: `channel`
  (`MessageChannel`), `direction` (`MessageDirection`), `body`, `scheduledFor?`,
  `sentAt?`, `creditCost?`. Relations: `Customer?`, `Technician?`, `Complaint?`,
  `MessageTemplate?`. Source: Screen 27, M1/M3.
- **MessageTemplate** — reusable template (`name`, `channel?`, `body`). Source:
  SMS Templates settings, D7.

**Catalogue / config**
- **Service** — service-catalogue entry. Fields: `name`, `category`
  (`ServiceCategory`), `description?`, `defaultPrice` (`Money`), `active`. Source:
  Settings Service Catalogue (Screen 24), Setup step 3.
- **ServiceArea** — geographic area. Fields: `name`, `postcodeSector?`,
  `isDefault`. Relations: `Property[]`, `Round[]`, `TechnicianServiceArea[]`.
  Source: Setup step 7, Add Round step 2.
- **Photo** — photo linked to Property/Visit/Complaint. Fields: `url`, `type`
  (`PhotoType`). Source: Customer Detail Photos tab; mobile before/after.
- **ActivityLog** — timestamped audit entries (`type`, `message`). Source:
  Reports System Activity Log (Screen 18).
- **BusinessSettings** — single config row, **DB-guarded singleton** via
  `uniqueId @unique @default("singleton")`. Fields: business profile,
  `defaultWorkingDays` (String[]), `timezone`, `currency`, `defaultCycleLength`,
  `bankDetails` (Json), **`setupCompleted`**. Source: Settings (Screen 23),
  Setup Wizard.

**Enums (16):** `UserRole`, `LifecycleStatus`, `RoundStatus`, `DayOfWeek`,
`CleaningFrequency`, `VisitStatus`, `PaymentStatus`, `PaymentMethod`,
`MessageChannel`, `MessageDirection`, `Severity`, `ComplaintStatus`,
`ServiceCategory`, `InvoiceStatus`, `IssueType`, `PhotoType`.

### 3.2 Schema Decisions
From PROGRESS "Schema Decisions & Implications (2026-07-07 Design Update)":

**Decided:**
- **Per-occurrence assignment → derived (Option A); no `RoundOccurrence` model.**
  An occurrence = Visits sharing a Round + cycle date; the 3-step wizard sets
  `Visit.technicianId` per job at visit generation.
- **Removed `Round.technicianId` (single FK)** — assignment is per-`Visit`; a
  round's assigned technicians are derived. (Also dropped the `Technician.rounds`
  back-relation.) Applied via migration `20260706211550`.

**Review queue (status):**
| # | Implication | Status |
|---|-------------|--------|
| 1 | `Round.technicianId` → m:n join table | **Rejected** (superseded by removal) |
| 2 | `RoundOccurrence` entity | **Deferred** (derived for Phase 1) |
| 3 | Manual job division via `Visit.technicianId` | **Approved (no change)** |
| 4 | Technician **availability** status (enum + leave date) | **Pending** |
| 5 | Technician **invite** entity (invite code) | **Pending** |
| 6 | **Notifications** feed entity | **Pending** |
| 7 | **Skip reason** enum (currently free `String`) | **Pending** |
| 8 | Access-issue description → `Issue.note` | **Approved (no change)** |
| 9 | Per-round **assignment history** | **Pending** |
| 10 | Cash payment → `Payment.method = CASH` | **Approved (no change)** |

### 3.3 Migration History
| Migration | Purpose |
|-----------|---------|
| `20260701220655_init` | Full initial schema — all tables + enums. |
| `20260706211550_remove-round-technician-id` | Drop `Round.technicianId` + FK (assignment moved to per-`Visit`; Decision 2). |
| `20260706220349_add_setup_completed` | Add `BusinessSettings.setupCompleted` (Setup Wizard completion flag). |

*Process note (PROGRESS): destructive `migrate dev` (dropping a column with data)
raises an interactive confirmation that the non-TTY environment can't answer, so
that migration was produced via `migrate diff` → `migrate deploy`. The
`handle_new_user` Supabase trigger is **not** in migration history (a known gap).*

### 3.4 Technician Assignment Model (multi-tech + per-occurrence)
Two assignment rules — **multi-technician rounds** and **per-occurrence manual
assignment** (`designFindings.md` Screen 30 **Rule** / M14 **Rule**; SRS
FR-ROUND-9/10) — are implemented **entirely at the `Visit` level**. No dedicated
occurrence entity exists.

**Why no `RoundOccurrence` model (Phase 1 decision — deferred).** An "occurrence"
is simply the set of `Visit`s that share a `Round` + a cycle date. `Visit`s are
already the per-date instances, so a separate occurrence entity would be
redundant in Phase 1. It is **deferred** (revisit only if per-occurrence
attributes ever need to diverge from the derived set). Consequently `Round` has
**no technician FK** — it was removed (migration `20260706211550`).

**How multi-technician assignment works (Visit level).** A round has no single
technician column; "who does this round" is **derived** from the distinct
`Visit.technicianId` values across the round's current occurrence. Assigning 2+
technicians = the admin setting `Visit.technicianId` **per job**, manually
dividing the jobs (the 3-step Select Technicians → Allocate Jobs → Review wizard,
Screen 30). There is no automatic split.

**How per-recurrence assignment is surfaced.** Visit generation creates each new
occurrence's `Visit`s with **`technicianId = null`** (the column default) — every
recurrence **starts unassigned**, and generation **does not copy** the previous
occurrence's technician forward. Unassigned upcoming recurrences are surfaced to
the admin via the **Upcoming Property Recurrences** modal (M14, reached from the
Round Planner alert banner); the admin then **explicitly assigns** technicians,
which **sets `Visit.technicianId` per job**. (An admin may deliberately roll a
prior assignment forward — still a manual action, shown with a review warning —
but generation never auto-inherits.)

**Enforcement note.** These are **business-logic rules** enforced by the
(not-yet-built) visit-generation and assignment code, **not DB constraints**. The
schema *supports* them (no `defaultTechnicianId` anywhere; new `Visit.technicianId`
defaults to null) but does not itself enforce "must be manually assigned" — that
lives in the service layer.

---

## 4. Auth Design
- **Supabase Auth flow:** email/password + **Google OAuth** (Google configured in
  Supabase + Google Cloud Console; backend uninvolved). Forgot/OTP/reset are
  entirely Supabase (Screens 3–5). The backend has **no login/signup endpoints**.
- **JWT verification:** tokens are **ES256** (asymmetric, ECC P-256). `requireAuth`
  fetches public keys from the project **JWKS endpoint**
  (`https://<ref>.supabase.co/auth/v1/.well-known/jwks.json`) via `jwks-rsa`,
  resolves by `kid`, and calls `jwt.verify(..., { algorithms: ["ES256"] })`.
  Verifies signature + algorithm + expiry (no audience/issuer check yet — see §8).
  Attaches `req.user = { supabaseUserId (from sub), email, role }`.
- **Profile auto-creation:** a Supabase **Postgres trigger `handle_new_user`** on
  `auth.users` inserts a matching `Profile` on signup. ⚠️ The trigger SQL is not
  version-controlled; its `name`/`role` derivation is unverified from the repo.
- **Technician invite flow:** technicians are **invited, not self-signup**. An
  invited technician is a `Technician` row with **`profileId = null`**; on
  accepting the invite (mobile: enter invite code → Complete Your Profile), a
  Supabase user + `Profile` (role TECHNICIAN) is created and linked. *(An invite
  token/entity is not yet modelled — Pending #5.)*
- **App role vs JWT role:** `req.user.role` is currently the raw Supabase claim
  (`authenticated`), **not** the app role (ADMIN/MANAGER/TECHNICIAN on `Profile`) —
  an open decision (DP-ROLES).

---

## 5. Integration Design

### 5.1 GHL (deferred — architecture only)
- **Role:** messaging (SMS/WhatsApp/Email) and assisting Stripe/GoCardless payment
  flows, against a **single GHL account**. Not the data layer, business-logic
  engine, delivery mechanism, or auth (that GHL-native architecture was retired).
- **Trigger mechanism — OPEN DECISION:** either (a) write to a synced GHL
  Contact's custom fields and let a GHL Workflow watch for the change, or (b) call
  the GHL API directly. To be resolved before visit-generation/payment logic
  depends on it.
- **Join point:** every `Customer`/`Property` carries `ghlContactId` from day one,
  regardless of which mechanism is chosen. No GHL integration code exists yet.

### 5.2 GoCardless / Stripe (deferred)
- **GoCardless** = primary (direct-debit-first) provider; **Stripe** = card
  fallback (payment links). Schema carries `Payment.gocardlessId` / `stripeId` and
  `PaymentMethod` includes `GOCARDLESS`/`STRIPE`/`CASH`/`CHEQUE`/`BACS`. No
  provider integration code yet; payments must trigger automatically post-
  completion (a Phase 1 success criterion).

### 5.3 Supabase Auth (live)
- Live and depended upon: JWT issuance (ES256), JWKS endpoint for verification,
  and the `handle_new_user` trigger. The backend verifies tokens on every
  protected route.

---

## 6. Frontend Design (high level — separate repo)
- **Stack (intended):** Vite + React + TypeScript with the **Supabase JS client**
  for auth. *(The roadmap/PROGRESS specify React + TypeScript + Supabase Auth;
  Vite is the conventional toolchain — confirm in the frontend repo.)*
- **Auth screens** (Login, Sign Up, Forgot Password, OTP, Reset — Screens 1–5)
  are handled **entirely by Supabase**; the frontend obtains an ES256 JWT and
  sends it as a Bearer token to the backend.
- **Admin route structure** (from the `designFindings.md` screen set / left nav):
  `/dashboard`, `/round-planner` (Calendar/Map/List; `?round=X`), `/todays-work`,
  `/customers` (+ Customer Detail tabs: Overview/Service Plan/Visit
  History/Payments/Notes & Risk/Photos), `/debt-board`, `/reports/history`
  (+ `/reports/technicians`), `/complaints`, `/settings` (Business Profile /
  Payment Setup / Round Settings / SMS Templates / Technician Mgmt / Service
  Areas / Service Catalogue), `/technicians`, `/setup` (wizard). Modals/flows:
  Add Property (M6), Add Round (CreateRoundModal), Assign Property to Round
  (Screen 31), Round & Technician Assignment (Screen 30), Bulk Message (M1),
  Add One-Off Job (M2), Generate/Preview Invoice (M4/M5), Reassign Technician
  (M15), Upcoming Property Recurrences (M14).
- **Mobile app** (technician): Login/Invite/Reset/Complete Profile, Today's job
  list, Property Details, Active Visit + bottom sheets (Photo/Note/Cash/Skip/
  Access Issue/Complete Confirm), Notifications.

---

## 7. Security Design
- **Auth boundary:** all backend routes **except `/health`** require a Bearer JWT
  (`requireAuth`). Missing/invalid → 401.
- **No secret on backend:** verification is via JWKS public keys (ES256); the
  legacy HS256 shared secret was removed.
- **Single-tenant Phase 1 — no RLS (documented decision).** One business; no
  per-tenant isolation or row-level security in Phase 1. Phase 2 introduces
  multi-tenant isolation/RLS.
- **OCP seam for Phase 2 multi-tenancy:** service methods take `profileId` first
  (`SetupService` pattern) so a tenant-scoped implementation can be bound behind
  the same interface without changing routes.
- **Credential handling:** secrets in `.env` (gitignored); `.env.example`
  documents keys without values; **no secrets in code**. `GOOGLE_CLIENT_ID/SECRET`
  exist in `.env` but are unused by backend code (Google OAuth is Supabase-side).
- **CORS:** currently all origins (dev) — tighten to frontend origin(s) for prod.
- **Error hygiene:** typed `AppError` maps to its status; all else → generic 500
  (internals logged, not returned).

---

## 8. Deferred Design Decisions
Items acknowledged in the sources as not-yet-designed / pending:
- **Mobile completion delivery** — native app (React Native/Expo) vs mobile web
  (blocks the mobile build).
- **GHL automation trigger mechanism** — contact-field-sync-and-watch vs direct
  API call (blocks messaging/payment automation design).
- **RLS / multi-tenancy** — deferred to Phase 2 (Phase 1 is single-tenant, no RLS).
- **`RoundOccurrence` model** — deferred; per-occurrence assignment is derived
  from Visits in Phase 1.
- **Technician availability model (#4), invite entity (#5), notifications feed
  (#6), skip-reason enum (#7), assignment history (#9)** — Pending schema items.
- **`handle_new_user` trigger provenance** — commit SQL as a migration vs leave
  Supabase-managed (a reproducibility gap).
- **Auth hardening** — add `audience`/`issuer` checks (and app-role/claims
  validation) before production.
- **App roles in JWT (DP-ROLES)** — read app role from `Profile` per request vs
  custom JWT claims.
- **Technician self-mark "unable to attend"** (OQ#13 / MOB-2) — trigger undesigned.
- **Mobile app scope (MOB-1)** — confirm "B2C" naming vs a future customer app.
- **Notifications push vs in-app (MOB-3).**

---

*Source documents: `PROGRESS.md`, `prisma/schema.prisma`, `docs/designFindings.md`, `docs/RoundFlow_Context_and_Roadmap_v1.md`.*
