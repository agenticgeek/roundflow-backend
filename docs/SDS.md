# RoundFlow Phase 1 — Software Design Specification

> Derived from `PROGRESS.md`, `prisma/schema.prisma`, `prisma/tenant/schema.prisma`,
> `docs/designFindings.md`, `docs/RoundFlow_Context_and_Roadmap_v1.md`, and the
> implemented codebase (`src/`). **Built** items are present in code; **Planned**
> items are proposed from the screen set — route paths not yet in code.

---

## 1. Architecture Overview

### 1.1 Components
- **React web admin app** — separate repo; the admin screen set (Dashboard,
  Round Planner, Today's Work, Customers & Properties, Debt/Payment,
  Reports/History, Complaints, Settings, Technicians). Owns all admin UI + auth UX.
- **Mobile technician app** ("RoundFlow Technician") — field job execution;
  delivery form (native vs mobile web) TBD.
- **Express backend** (Node + TypeScript) — REST API; system of record access;
  all business logic. Built via `tsc -p tsconfig.build.json`; run via `tsx` in dev,
  `node dist/index.js` in prod.
- **Supabase Postgres** — managed database (Prisma ORM 6.19.3), region
  `ap-northeast-1`. Two schema layers: `public` (identity + tenant registry) and
  per-tenant operational schemas (`t_<20-hex>`).
- **Supabase Auth** — identity provider; issues ES256 JWTs. The backend replaces
  the retired `handle_new_user` trigger with `POST /auth/signup`, which creates the
  `Tenant` + `Profile` row and provisions the tenant schema atomically.
- **GHL (utility, deferred)** — messaging + payment assistance; single account.
- **Deployment** — Railway (backend); Supabase (DB + Auth).

### 1.2 Component Interaction (text diagram)
```
   ┌───────────────────┐         ┌──────────────────────┐
   │  Web Admin (React)│         │ Mobile Technician App │
   └─────────┬─────────┘         └───────────┬──────────┘
             │  Supabase JS (auth)           │
             │  + Bearer JWT (ES256)         │
             ▼                               ▼
        ┌──────────────────────────────────────────────────┐
        │           Express Backend (REST API)              │
        │  requireAuth (JWKS/ES256)                         │
        │  → requireTenantAccess (JWT→Profile→Tenant→schema)│
        │  → routes → services → DB                        │
        └──┬─────────────────────┬──────────────────┬──────┘
           │ @prisma/client       │ tenant-client    │ pg (direct)
           │ (pooler 6543)        │ LRU pool         │ (port 5432)
           ▼                     ▼                  ▼
    ┌──────────────┐   ┌──────────────────┐  ┌──────────────────┐
    │ public schema│   │ t_<hex> schema   │  │ Schema           │
    │ Profile      │   │ (per-tenant ops) │  │ Provisioning     │
    │ Tenant       │   │ Customer, Round, │  │ (new tenant      │
    │ TenantInvite │   │ Visit, etc.      │  │  setup only)     │
    └──────────────┘   └──────────────────┘  └──────────────────┘
           │
           ▼ (deferred)
    ┌──────────────┐
    │  GHL utility │
    │  Resend email│
    └──────────────┘
```
Auth token flow: frontend authenticates with Supabase → receives ES256 JWT →
sends `Authorization: Bearer <jwt>` to the backend → `requireAuth` verifies
against Supabase's JWKS endpoint → `requireTenantAccess` resolves
`supabaseUserId → Profile → Tenant.schemaName` → attaches a per-schema
`TenantPrismaClient` on `req.tenantPrisma`.

### 1.3 Why each component (from PROGRESS Architecture Decisions)
- **Prisma 6.19.3 (not 7):** Prisma 7 needs a driver adapter, moves the datasource
  URL into `prisma.config.ts`, drops `directUrl`, and its `migrate dev` bailed in
  the non-TTY environment. Prisma 6 keeps schema-based datasource, the
  `prisma-client-js` generator, and non-interactive `migrate dev`. Chosen for
  stability.
- **Two Prisma generated clients:** The public schema (`prisma/schema.prisma`) and
  tenant schema (`prisma/tenant/schema.prisma`) are fully separate Prisma projects.
  They generate into `@prisma/client` and `src/generated/tenant-client` respectively.
  Prisma cannot express cross-schema foreign keys, so cross-schema references
  (`Technician.profileId`, `PropertyNote.authorProfileId`) are plain `String` fields
  enforced at the application layer.
- **Schema-per-tenant (not RLS, not database-per-tenant):** Each business gets its
  own PostgreSQL schema (`t_<20-hex>`). RLS was not chosen because it adds
  query-level complexity to every operation; database-per-tenant is impractical on
  Supabase. Schema isolation is enforced by `requireTenantAccess` + the LRU pool.
- **LRU PrismaClient pool:** One `TenantPrismaClient` per `schemaName`, cached in
  an LRU (max 100 entries). Evicted clients call `$disconnect()` to release PgBouncer
  connections. Prevents connection exhaustion with many tenants; prevents duplicated
  Prisma engine processes.
- **`POST /auth/signup` (not `handle_new_user` trigger):** Replaces the Postgres
  trigger to put tenant provisioning under application control — the trigger had no
  way to run `provisionTenantSchema`. The frontend calls `GET /auth/me` first; if
  it gets a 404, it calls `POST /auth/signup`.
- **Supabase Auth + ES256 JWKS:** the project signs with ES256 (asymmetric), so
  the backend verifies via JWKS public keys — no shared secret stored.
- **GHL as utility, not platform:** avoids building messaging/payments infra;
  keeps RoundFlow's Postgres as the system of record.

---

## 2. Backend Design

### 2.1 Technology Stack
| Layer | Choice | Notes |
|-------|--------|-------|
| Runtime | Node.js + TypeScript | Run via `tsx` in dev; `node dist/` in prod |
| Build | `tsc -p tsconfig.build.json` | Outputs `dist/`; copies `src/generated` + `prisma/tenant` |
| Web framework | Express 4 | |
| ORM (public schema) | `@prisma/client` 6.19.3 | Singleton `prisma` client; `globalThis`-cached |
| ORM (tenant schema) | `src/generated/tenant-client` 6.19.3 | LRU-pooled per `schemaName` |
| Database | Supabase Postgres (`ap-northeast-1`) | |
| Auth verify | `jsonwebtoken` + `jwks-rsa` | ES256; JWKS keys cached 10h |
| Email | `resend` | Transactional (invite emails) |
| Schema provisioning | `pg` (direct connection, port 5432) | Used only by `provisionTenantSchema` |
| Client pool | `lru-cache` ^11 | Max 100 tenant clients; `$disconnect` on eviction |
| API docs | `swagger-ui-express` | `/docs` (UI), `/openapi.json` (raw spec) |
| Config | `dotenv` | `.env`; `FRONTEND_URL` + `INVITE_BASE_URL` validated at startup |
| Typecheck | `tsc --noEmit` | `strict`, `Node16` module/resolution |

### 2.2 Project Structure
Current `src/` layout:
```
src/
├── index.ts                    # Express app wiring: CORS (locked to FRONTEND_URL),
│                               #   JSON body, all routers, error handler, listen.
│                               #   Startup validation: exits if FRONTEND_URL or
│                               #   INVITE_BASE_URL are missing.
├── swagger.ts                  # OpenAPI document (served at /docs + /openapi.json)
├── generated/
│   └── tenant-client/          # Prisma-generated client for tenant schemas
│                               #   (output of `prisma generate --schema prisma/tenant/schema.prisma`)
├── lib/
│   ├── app-error.ts            # Typed AppError(statusCode, message)
│   ├── prisma.ts               # @prisma/client singleton (globalThis-cached)
│   ├── tenant-prisma-manager.ts# LRU pool of TenantPrismaClient; getTenantPrismaForSchema()
│   ├── tenant-provisioning.ts  # provisionTenantSchema(): creates schema + replays
│   │                           #   all prisma/tenant/migrations/*.sql in a transaction
│   ├── email.ts                # sendInviteEmail() + sendTemplatedEmail() via Resend
│   │                           #   (HTML-escaped values, {{variable}} rendering)
│   ├── http.ts                 # Route helpers: h(), asObject(), asArray(),
│   │                           #   requireString(), requireNumber(), optString(), optId(), etc.
│   └── validation.ts           # Domain validators: assertPositive(), assertPositiveInt(),
│                               #   validateWorkingDays(), optPaymentMethod(),
│                               #   requireCleaningFrequency(), optDayOfWeek(),
│                               #   optRoundStatus(), etc.
├── middleware/
│   ├── requireAuth.ts          # JWKS/ES256 Bearer verification → req.user; 401 on fail
│   ├── requireTenantAccess.ts  # JWT→Profile→Tenant.schemaName → req.tenantPrisma; 403 on fail
│   └── requireRole.ts          # requireRole(...roles): checks req.profile.role
│                               #   requireBusinessAccess(): GETs open to all, mutations ADMIN/MANAGER
├── routes/
│   ├── auth.ts                 # GET /auth/me, POST /auth/signup
│   ├── invites.ts              # POST /invites, GET /invites/:token,
│   │                           #   POST /invites/:token/accept
│   ├── setup.ts                # /setup/* (12 steps + /status + /complete)
│   ├── customers.ts            # GET /customers, GET /customers/:id, PATCH /customers/:id
│   ├── properties.ts           # POST /properties, PATCH /properties/:id,
│   │                           #   POST/GET /properties/:id/notes,
│   │                           #   POST /properties/:id/pause, POST /properties/:id/resume
│   ├── rounds.ts               # GET /rounds, POST /rounds,
│   │                           #   GET /rounds/:id, PATCH /rounds/:id,
│   │                           #   PUT /rounds/:id/technicians
│   └── settings.ts             # /settings/business-profile, /settings/round-settings,
│                               #   /settings/services(/:id), /settings/service-areas(/:id),
│                               #   /settings/technicians(/:id), /settings/payment,
│                               #   /settings/payment/:provider/connect,
│                               #   /settings/message-templates
└── services/
    ├── setup.service.ts        # ISetupService + SetupService (all 12 setup steps)
    ├── customer.service.ts     # ICustomerService: getCustomers, getCustomerDetail,
    │                           #   updateCustomer, createProperty, updateProperty,
    │                           #   pauseService, resumeService, getNotes, addNote;
    │                           #   FR-FREQ-1..6 logic in updateProperty + updateCustomer
    ├── round.service.ts        # IRoundService: listRounds, createRound, getRound,
    │                           #   updateRound, setTechnicians
    └── settings.service.ts     # ISettingsService: all settings section reads/writes;
                                #   MessageTemplate CRUD + replaceTemplates (for step 5)
```
**Intended layout** (as domains land): one `routes/<domain>.ts` + one
`services/<domain>.service.ts` per domain, following the thin-route /
service-owns-logic pattern established by Setup.

### 2.3 API Design Principles
- **RESTful conventions:** resource-oriented paths; `GET` reads, `POST` creates/
  actions, `PATCH` partial updates; JSON request/response bodies.
- **Auth middleware chain:** `requireAuth` (JWKS/ES256 Bearer) → `requireTenantAccess`
  (tenant schema resolution) → `requireRole` / `requireBusinessAccess` (role gate).
  Every protected route runs the chain. `/health`, `GET /invites/:token`, and
  `GET /auth/me` are partial exceptions (auth only, no tenant resolution).
- **Error handling:** typed **`AppError(statusCode, message)`** thrown by services;
  centralised 4-arg Express error handler maps `AppError → { error, statusCode }`;
  everything else → `500 { error: "Internal Server Error" }` (internals logged, not
  leaked).
- **Service layer (OCP seam):** routes are **thin** (validate input → call service
  → respond); **all business logic and DB access live in services**. Services are
  bound behind interfaces and every method takes `profileId` first, so a Phase 2
  implementation scoped by GHL install/location can be swapped in without changing
  routes.
- **Shared route utilities:** `src/lib/http.ts` provides `h()` (async error
  forwarding), `asObject()`, `asArray()`, `requireString()`, `requireNumber()`,
  `optString()`, `optId()` etc. `src/lib/validation.ts` provides domain-specific
  validators. Routes never duplicate validation logic.

### 2.4 Route Inventory
**Built** = present in code. **Planned** = proposed from the screen set (path not
yet in code). All non-`/health` routes require a Bearer JWT.

| Method | Path | Auth | Service | Status |
|--------|------|------|---------|--------|
| GET | `/health` | No | — | **Built** |
| GET | `/auth/me` | JWT only | (inline; Profile lookup) | **Built** |
| POST | `/auth/signup` | JWT only | (inline; Tenant + Profile create + schema provision) | **Built** |
| GET | `/invites/:token` | No | (inline; invite lookup) | **Built** |
| POST | `/invites` | JWT + Tenant | — | **Built** |
| POST | `/invites/:token/accept` | JWT only | — | **Built** |
| GET | `/setup/status` | JWT + Tenant | SetupService | **Built** |
| GET/POST | `/setup/step/1` (Business Profile) | JWT + Tenant | SetupService | **Built** |
| GET/POST | `/setup/step/2` (Payment — deferred stub) | JWT + Tenant | — | **Built** |
| GET/POST | `/setup/step/3` (Service Catalogue) | JWT + Tenant | SetupService | **Built** |
| GET/POST | `/setup/step/4` (Round Settings) | JWT + Tenant | SetupService | **Built** |
| GET/POST | `/setup/step/5` (Message Templates — SMS/WhatsApp/Email) | JWT + Tenant | SettingsService | **Built** |
| GET/POST | `/setup/step/6` (Technicians) | JWT + Tenant | SetupService | **Built** |
| GET/POST | `/setup/step/7` (Service Areas) | JWT + Tenant | SetupService | **Built** |
| GET/POST | `/setup/step/8` (First Round) | JWT + Tenant | SetupService | **Built** |
| GET/POST | `/setup/step/9` (Add Property) | JWT + Tenant | SetupService | **Built** |
| GET/POST | `/setup/step/10` (Assign Technicians) | JWT + Tenant | SetupService | **Built** |
| GET/POST | `/setup/step/11` (Activate / Generate Visits) | JWT + Tenant | SetupService | **Built** |
| GET | `/setup/step/12` (Review checklist) | JWT + Tenant | SetupService | **Built** |
| POST | `/setup/complete` | JWT + Tenant | SetupService | **Built** |
| GET | `/customers` | JWT + Tenant | CustomerService | **Built** |
| GET | `/customers/:id` | JWT + Tenant | CustomerService | **Built** |
| PATCH | `/customers/:id` | JWT + Tenant (ADMIN/MGR) | CustomerService | **Built** |
| POST | `/properties` | JWT + Tenant (ADMIN/MGR) | CustomerService | **Built** |
| PATCH | `/properties/:id` | JWT + Tenant (ADMIN/MGR) | CustomerService | **Built** |
| POST | `/properties/:id/pause` | JWT + Tenant (ADMIN/MGR) | CustomerService | **Built** |
| POST | `/properties/:id/resume` | JWT + Tenant (ADMIN/MGR) | CustomerService | **Built** |
| GET | `/properties/:id/notes` | JWT + Tenant | CustomerService | **Built** |
| POST | `/properties/:id/notes` | JWT + Tenant (ADMIN/MGR) | CustomerService | **Built** |
| POST | `/customers` | JWT + Tenant (ADMIN/MGR) | CustomerService | **Built** |
| DELETE | `/customers/:id` | JWT + Tenant (ADMIN/MGR) | CustomerService | **Built** |
| POST | `/customers/:id/properties` | JWT + Tenant (ADMIN/MGR) | CustomerService | **Built** |
| DELETE | `/properties/:id` | JWT + Tenant (ADMIN/MGR) | CustomerService | **Built** |
| GET | `/settings/business-profile` | JWT + Tenant | SettingsService | **Built** |
| PATCH | `/settings/business-profile` | JWT + Tenant (ADMIN/MGR) | SettingsService | **Built** |
| GET | `/settings/round-settings` | JWT + Tenant | SettingsService | **Built** |
| PATCH | `/settings/round-settings` | JWT + Tenant (ADMIN/MGR) | SettingsService | **Built** |
| GET | `/settings/services` | JWT + Tenant | SettingsService | **Built** |
| POST | `/settings/services` | JWT + Tenant (ADMIN/MGR) | SettingsService | **Built** |
| PATCH | `/settings/services/:id` | JWT + Tenant (ADMIN/MGR) | SettingsService | **Built** |
| DELETE | `/settings/services/:id` | JWT + Tenant (ADMIN/MGR) | SettingsService | **Built** |
| GET | `/settings/service-areas` | JWT + Tenant | SettingsService | **Built** |
| POST | `/settings/service-areas` | JWT + Tenant (ADMIN/MGR) | SettingsService | **Built** |
| PATCH | `/settings/service-areas/:id` | JWT + Tenant (ADMIN/MGR) | SettingsService | **Built** |
| DELETE | `/settings/service-areas/:id` | JWT + Tenant (ADMIN/MGR) | SettingsService | **Built** |
| GET | `/settings/technicians` | JWT + Tenant | SettingsService | **Built** |
| POST | `/settings/technicians` | JWT + Tenant (ADMIN/MGR) | SettingsService | **Built** |
| PATCH | `/settings/technicians/:id` | JWT + Tenant (ADMIN/MGR) | SettingsService | **Built** |
| DELETE | `/settings/technicians/:id` | JWT + Tenant (ADMIN/MGR) | SettingsService | **Built** |
| GET | `/settings/payment` | JWT + Tenant | SettingsService | **Built** |
| PATCH | `/settings/payment` | JWT + Tenant (ADMIN/MGR) | SettingsService | **Built** |
| POST | `/settings/payment/:provider/connect` | JWT + Tenant (ADMIN/MGR) | SettingsService | **Built** |
| GET | `/settings/message-templates` | JWT + Tenant | SettingsService | **Built** |
| POST | `/settings/message-templates` | JWT + Tenant (ADMIN/MGR) | SettingsService | **Built** |
| PATCH | `/settings/message-templates/:id` | JWT + Tenant (ADMIN/MGR) | SettingsService | **Built** |
| DELETE | `/settings/message-templates/:id` | JWT + Tenant (ADMIN/MGR) | SettingsService | **Built** |
| GET | `/openapi.json` | No | — | **Built** |
| GET | `/docs` | No | swagger-ui-express | **Built** |
| GET | `/rounds` | JWT + Tenant | RoundService | **Built** |
| POST | `/rounds` | JWT + Tenant (ADMIN/MGR) | RoundService | **Built** |
| GET | `/rounds/:id` | JWT + Tenant | RoundService | **Built** |
| PATCH | `/rounds/:id` | JWT + Tenant (ADMIN/MGR) | RoundService | **Built** |
| PUT | `/rounds/:id/technicians` | JWT + Tenant (ADMIN/MGR) | RoundService | **Built** |
| GET | `/rounds/:id/planner/occurrences` | JWT + Tenant | RoundService | **Built** |
| GET | `/rounds/:id/planner/occurrences/:date` | JWT + Tenant | RoundService | **Built** |
| — | Visit generation (cron) + Visit reads | JWT + Tenant / cron | VisitService (planned) | **Planned** |
| — | Round Planner map view + Today's Work (per-technician day view) | JWT + Tenant | RoundService (planned) | **Planned** |
| — | Today's Work + Reassign / Push Missed | JWT + Tenant | VisitService (planned) | **Planned** |
| — | Debt / Payment Risk Board | JWT + Tenant | DebtService (planned) | **Planned** |
| — | Invoices (generate/preview/send) | JWT + Tenant | InvoiceService (planned) | **Planned** |
| — | Complaints (log/review/revisit/resolve) | JWT + Tenant | ComplaintService (planned) | **Planned** |
| — | Reports & History | JWT + Tenant | ReportService (planned) | **Planned** |
| — | Mobile: job list, visit actions, notifications | JWT + Tenant | MobileService (planned) | **Planned** |

### 2.5 Data Access Pattern
Two Prisma clients and one direct `pg` connection cover all DB access:

**Public schema client (`@prisma/client`)** — singleton on `globalThis`, manages
`Profile`, `Tenant`, `TenantInvite`. Used directly in `auth.ts` and `invites.ts`;
never put on `req.tenantPrisma`.

**Tenant schema client pool (`src/generated/tenant-client`)** — one
`TenantPrismaClient` per `Tenant.schemaName`, cached in an LRU (max 100). The
`getTenantPrismaForSchema(schemaName)` function checks the cache and creates a new
client with `?schema=<name>` appended to `DATABASE_URL` on miss. Evicted clients
call `$disconnect()`. `requireTenantAccess` middleware attaches the resolved client
to `req.tenantPrisma`; all tenant-domain service methods read from it.

**Direct `pg` connection** — used only by `provisionTenantSchema()`. Opens a
non-pooled connection to `DIRECT_URL` (port 5432) so that `SET search_path TO
"<schema>"` persists across all statements in the provisioning session. Creates the
schema, then replays every `prisma/tenant/migrations/*.sql` file in lexicographic
order inside a single `BEGIN`/`COMMIT`.

Both Prisma clients use `DATABASE_URL` (Supabase transaction-mode pooler, port 6543,
`?pgbouncer=true`) for runtime queries. `DIRECT_URL` (port 5432) is used by Prisma
`migrate` CLI and by `provisionTenantSchema`.

---

## 3. Database Design

### 3.1 Schema Overview
The database is split into two Prisma projects and migration trees:

#### Public schema (`prisma/schema.prisma`)
Holds cross-tenant identity and tenant registry. 3 models, 1 enum.

| Model | Purpose |
|-------|---------|
| `Profile` | Public-schema mirror of `auth.users`. Fields: `supabaseUserId` (unique join key), `tenantId`, `role` (`UserRole`), `name`. |
| `Tenant` | One row per business. Fields: `schemaName` (`t_<20-hex>`, unique Postgres schema). |
| `TenantInvite` | Pending invite for a staff member. Fields: `tenantId`, `email`, `role`, `token` (unique cuid), `expiresAt`, `acceptedAt?`, `technicianId?` (link to tenant-schema Technician row). |

**Enum:** `UserRole` (ADMIN, MANAGER, TECHNICIAN).

#### Tenant schema (`prisma/tenant/schema.prisma`)
Holds all operational data for one business. Deployed per-tenant as `t_<20-hex>`.
20 models, 17 enums.

**Auth / config**
- **BusinessSettings** — single config row, DB-guarded singleton via
  `uniqueId @unique @default("singleton")`. Fields: business profile,
  `defaultWorkingDays`, `timezone`, `currency`, `defaultCycleLength`, `bankDetails`
  (Json), payment toggles, `setupCompleted`.

**Customers & properties**
- **Customer** — fields: `name`, `phone?`, `email?`, `status` (`LifecycleStatus`),
  `ghlContactId?` (GHL join), `paymentMethod?`, `badDebt`. Relations: many
  `Property`, `Invoice`, `Payment`, `Message`, `Complaint`.
- **Property** — fields: `addressLine`, `postcode`, `propertyName?`,
  `propertyType?` (`PropertyType` enum), `accessNotes?`, `riskNotes?`, `status`,
  `roundId?` (nullable = unassigned). Relations: `Customer`, `ServiceArea?`,
  `Round?`, many `ServicePlan`/`Visit`/`Photo`/`Issue`/`Complaint`/`PropertyNote`.
- **ServicePlan** — recurring service agreement. Fields: `price` (Decimal),
  `cleanMethod?`, `paymentMethod?`, `cleaningFrequency?` (`CleaningFrequency`),
  `status`, `nextDueDate?`, `lastCompleted?`. Relations: `Property`, `Service?`,
  `Visit[]`.
- **PropertyNote** — notes & risk. Fields: `type` (`NoteType`), `body`,
  `authorProfileId?` (references `public.Profile.id` — application-enforced, no
  DB FK). Relations: `Property`.

**Scheduling**
- **Round** — geographic cluster + cadence unit. Fields: `name`, `defaultDay?`
  (`DayOfWeek`), `frequency?` (`CleaningFrequency`), `status` (`RoundStatus`),
  `serviceAreaId?`. **No single `technicianId` FK** — multi-technician assignment
  uses `RoundTechnician`. Relations: `Property[]`, `Visit[]`, `RoundTechnician[]`.
- **RoundTechnician** — join table for Round ↔ Technician m:n. Fields: `roundId`,
  `technicianId`, `assignedAt`. Composite PK `(roundId, technicianId)`. DB-level
  FK constraints with `ON DELETE CASCADE`. Used in setup (step 10) and post-setup
  round management.
- **Visit** — one clean of one property on one date (the operational spine). Fields:
  `date`, `status` (`VisitStatus`), `price`, `paymentHold`, `isOneOff`, `skipReason?`,
  `notes?`, `completedAt?`, `technicianId?` (per-job assignment). Relations:
  `Property`, `Round?`, `ServicePlan?`, `Technician?`, `Invoice?`, `Payment?`,
  `Photo[]`, `Issue[]`.
- **Technician** — field operative. Fields: `profileId?` (**null = invited**, unique),
  `role?`, `phone?`, `active`, `avatarUrl?`. Relations: `TechnicianServiceArea[]`,
  `Visit[]`, `Message[]`, `Complaint[]`, `RoundTechnician[]`.
- **TechnicianServiceArea** — m:n join Technician ↔ ServiceArea.
- **ServiceArea** — geographic area. Fields: `name`, `postcodeSector?`, `isDefault`.

**Exceptions**
- **Complaint** — customer quality complaint. Fields: `title`, `severity` (`Severity`),
  `status` (`ComplaintStatus`), `revisitDate?`. Relations: `Customer`, `Property?`,
  `Technician?`, `Message[]`, `Photo[]`.
- **Issue** — lightweight operational exception on a visit. Fields: `type`
  (`IssueType`), `note?`.

**Billing**
- **Invoice** — fields: `invoiceNumber` (unique within tenant schema), `amount`,
  `status` (`InvoiceStatus`). Relations: `Customer`, `Visit?` (unique).
- **Payment** — fields: `amount`, `method` (`PaymentMethod`), `status`
  (`PaymentStatus`), `gocardlessId?`, `stripeId?`. Relations: `Customer`, `Visit?`.

**Messaging**
- **Message** — fields: `channel` (`MessageChannel`), `direction`, `body`,
  `scheduledFor?`, `sentAt?`, `creditCost?`.
- **MessageTemplate** — reusable template (`name`, `channel?` (SMS/WHATSAPP/EMAIL), `subject?` (email subject line), `body`). Email templates rendered via `sendTemplatedEmail()` with `{{variable}}` substitution.

**Catalogue / config**
- **Service** — catalogue entry. Fields: `name`, `category` (`ServiceCategory`),
  `description?`, `defaultPrice`, `active`.
- **Photo** — linked to Property/Visit/Complaint. Fields: `url`, `type` (`PhotoType`).
- **ActivityLog** — timestamped audit entries (`type`, `message`).

**Enums (17):** `LifecycleStatus`, `RoundStatus`, `DayOfWeek`, `CleaningFrequency`,
`VisitStatus`, `PaymentStatus`, `PaymentMethod`, `PaymentTiming`, `MessageChannel`,
`MessageDirection`, `Severity`, `ComplaintStatus`, `ServiceCategory`, `PropertyType`,
`InvoiceStatus`, `IssueType`, `PhotoType`, `NoteType`.

### 3.2 Schema Decisions
**Decided:**
- **Per-occurrence assignment → derived (Option A); no `RoundOccurrence` model.**
  An occurrence = Visits sharing a Round + cycle date. Visit is already the per-date
  instance; a separate occurrence entity is redundant in Phase 1.
- **`RoundTechnician` join table for setup-phase round ↔ technician assignment.**
  Used in Setup step 10 (assign technicians to rounds before visit generation) and
  will serve post-setup round management. Distinct from per-Visit `technicianId`
  (which is the per-job operational assignment).
- **`BusinessSettings.uniqueId @unique @default("singleton")** — DB-level uniqueness
  constraint prevents concurrent first-write races from creating duplicate rows.

**Review queue (status):**
| # | Implication | Status |
|---|-------------|--------|
| 1 | `Round.technicianId` → m:n join table | **Done** (`RoundTechnician`) |
| 2 | `RoundOccurrence` entity | **Deferred** (derived for Phase 1) |
| 3 | Manual job division via `Visit.technicianId` | **Done** |
| 4 | Technician **availability** status (enum + leave date) | **Pending** |
| 5 | Technician **invite** entity | **Done** (`TenantInvite` in public schema) |
| 6 | **Notifications** feed entity | **Pending** |
| 7 | **Skip reason** enum (currently free `String`) | **Pending** |
| 8 | Access-issue description → `Issue.note` | **Done** |
| 9 | Per-round **assignment history** | **Pending** |
| 10 | Cash payment → `Payment.method = CASH` | **Done** |

### 3.3 Migration History

#### Public schema (`prisma/migrations/`)
| Migration | Purpose |
|-----------|---------|
| `20260720205728_init_public` | Creates `Profile`, `Tenant`, `TenantInvite` + `UserRole` enum. Replaces the retired `handle_new_user` trigger approach. |
| `20260721000001_add_technician_id_to_invite` | Adds `TenantInvite.technicianId` — links an invite to an existing `Technician` row so the tech-link is completed on invite acceptance. |

#### Tenant schema (`prisma/tenant/migrations/`)
Applied per-tenant by `provisionTenantSchema()` in lexicographic order inside a
single transaction.

| Migration | Purpose |
|-----------|---------|
| `20260721000001_init_tenant` | Full initial tenant schema — all operational models + enums. |
| `20260721000002_business_settings_unique_id` | Adds `BusinessSettings.uniqueId String @unique @default("singleton")` — DB-enforced singleton constraint. |
| `20260721000003_setup_steps_9_12` | Creates `PropertyType` enum; alters `Property.propertyType` from `String?` to `PropertyType?`; adds `ServicePlan.cleaningFrequency`; creates `RoundTechnician` join table with FK constraints (`ON DELETE CASCADE`). |

*Process note: destructive `migrate dev` prompts can't be answered in a non-TTY
environment, so breaking migrations are produced via `migrate diff` → `migrate
deploy`. The tenant migration tree is replayed by `provisionTenantSchema`, not by
`prisma migrate deploy`.*

### 3.4 Technician Assignment Model (multi-tech + per-occurrence)
Two assignment layers exist:

**`RoundTechnician` (round-level):** which technicians are assigned to a given round
as a whole — populated during Setup step 10. Used for scheduling and step 10
completion tracking (`allRoundsAssigned`). This is the "standing" assignment.

**`Visit.technicianId` (job-level):** which technician does a specific visit on a
specific date. Set during the 3-step Select → Allocate → Review wizard (Screen 30)
at visit generation time. Each new recurrence starts with `technicianId = null`;
visit generation never inherits the previous occurrence's technician. An admin must
explicitly assign per-occurrence (FR-ROUND-10). There is no automatic split across
multiple technicians.

### 3.5 Frequency Model & Automatic Round Reassignment

#### Frequency fields
Two fields carry cleaning frequency in the schema:
- `Round.frequency` (`CleaningFrequency?`) — the cadence of the entire round.
- `ServicePlan.cleaningFrequency` (`CleaningFrequency?`) — the cadence for a specific
  property's service plan.

Under normal operation these are equal. When a property is first assigned to a round
(during Setup step 9, `POST /properties`, or "Assign to Round"), the service layer
**SHALL set `ServicePlan.cleaningFrequency = Round.frequency`** so the property
inherits the round's cadence (FR-FREQ-1).

#### Trigger point
The full FR-FREQ-2..6 reassignment logic fires when `PATCH /properties/:id` receives
a `cleaningFrequency` field that differs from the property's current round frequency.
`CustomerService.updateProperty` detects the divergence and runs the algorithm.

`PATCH /customers/:id` covers only FR-FREQ-1: when the request includes a `roundId`,
`CustomerService.updateCustomer` syncs `ServicePlan.cleaningFrequency` to the new
round's frequency. It does **not** trigger the auto-reassignment path.

Routes stay thin; all detection and logic lives in the service layer.

#### Reassignment algorithm (FR-FREQ-2 through FR-FREQ-6)
Run atomically in a single Prisma transaction.

```
given: property P (currently in Round A with frequency F_A), new frequency F_B

if P.roundId is null:
    → update ServicePlan.cleaningFrequency = F_B only (FR-FREQ-5)
    → done

if F_B == F_A:
    → update ServicePlan.cleaningFrequency = F_B only (FR-FREQ-6)
    → done

// F_B differs from F_A — reassignment required.
// P.serviceAreaId is always set (FR-CUST-3a), so this is a concrete equality match.
roundB = find first ACTIVE round where:
    frequency     = F_B
    serviceAreaId = P.serviceAreaId

if roundB found:                                   // Case A (FR-FREQ-3)
    update Property.roundId = roundB.id
    update ServicePlan.cleaningFrequency = F_B
    // roundB's RoundTechnician rows are untouched

else:                                              // Case B (FR-FREQ-4)
    freqLabel = human-readable label for F_B
                (FORTNIGHTLY→"Fortnightly", FOUR_WEEKLY→"Four Weekly",
                 SIX_WEEKLY→"Six Weekly", EIGHT_WEEKLY→"Eight Weekly", MONTHLY→"Monthly")
    create roundB:
        name          = "<Round A name> (<freqLabel>)"
                        e.g. "North London (Fortnightly)"
        defaultDay    = Round A.defaultDay
        serviceAreaId = Round A.serviceAreaId
        status        = ACTIVE
        frequency     = F_B
    copy RoundTechnician rows from Round A → roundB
    update Property.roundId = roundB.id
    update ServicePlan.cleaningFrequency = F_B

// Round A is never modified — it keeps its remaining properties and technicians
```

#### Key invariants
- **Every property always has a `serviceAreaId`** (FR-CUST-3a). The round lookup is
  always a concrete `serviceAreaId = X` equality, never a null comparison.
- **Round A is never touched.** Reassignment only updates the moving property's
  `roundId` and `ServicePlan.cleaningFrequency`.
- **Case A preserves Round B's technicians.** The existing `RoundTechnician` rows on
  Round B are left as-is; only the property moves in.
- **Case B copies technicians from Round A.** New `RoundTechnician` rows for Round B
  are created from Round A's current assignments — not from Round B, which doesn't
  exist yet.
- **Atomicity.** The round create (if needed), `RoundTechnician` copy, and
  `Property.roundId` + `ServicePlan.cleaningFrequency` updates all run in one
  transaction. A failure rolls back completely; no partial state.

---

## 4. Auth Design
- **Supabase Auth flow:** email/password + **Google OAuth** (backend uninvolved).
  Forgot/OTP/reset are entirely Supabase (Screens 3–5). The backend has **no
  login/signup endpoint via Supabase** — only `POST /auth/signup` (creates Tenant +
  Profile + provisions tenant schema).
- **JWT verification:** tokens are **ES256** (asymmetric). `requireAuth` fetches
  public keys from the Supabase **JWKS endpoint** via `jwks-rsa` (10h cache,
  rate-limited), resolves by `kid`, and calls `jwt.verify(..., { algorithms:
  ["ES256"] })`. Attaches `req.user = { supabaseUserId, email }`.
- **Tenant resolution:** `requireTenantAccess` loads `Profile` (with `Tenant`) by
  `supabaseUserId`, calls `getTenantPrismaForSchema(tenant.schemaName)`, and attaches
  the result as `req.tenantPrisma` and `req.profile`. Returns 401 if no `req.user`,
  403 if no `Profile` found.
- **Technician invite flow:** `POST /invites` creates a `TenantInvite` and sends an
  invite email via Resend. `POST /invites/:token/accept` is called by the invitee
  after authenticating. It creates a `Profile` and marks the invite accepted
  atomically (Prisma transaction). If the invite has a `technicianId`, the
  corresponding `Technician.profileId` is linked after the transaction. The endpoint
  is idempotent: if a Profile already exists for the caller, it re-attempts the
  tech-link and returns the existing profile. Cross-tenant and cross-email acceptance
  are rejected with 403.
- **RBAC — app role from DB, not JWT:** The Supabase JWT carries no app role claim.
  `requireTenantAccess` loads `Profile` by `supabaseUserId` on every request and
  attaches it as `req.profile`; `requireRole` and `requireBusinessAccess` gate on
  `req.profile.role` (ADMIN / MANAGER / TECHNICIAN). ADMIN and MANAGER may call any
  endpoint; TECHNICIAN requests to mutating routes are rejected with 403. Role
  changes in the DB take effect on the very next request — no token refresh needed.
  `AuthUser` (set by `requireAuth`) intentionally omits a role field to prevent
  reaching for the useless Supabase `"authenticated"` claim by mistake.

---

## 5. Integration Design

### 5.1 GHL (deferred — architecture only)
- **Role:** messaging (SMS/WhatsApp/Email) and assisting Stripe/GoCardless payment
  flows, against a **single GHL account**. Not the data layer, business-logic
  engine, delivery mechanism, or auth (that GHL-native architecture was retired).
- **Trigger mechanism — OPEN DECISION:** either (a) write to a synced GHL Contact's
  custom fields and let a GHL Workflow watch for the change, or (b) call the GHL
  API directly. To be resolved before visit-generation/payment logic depends on it.
- **Join point:** every `Customer`/`Property` carries `ghlContactId` from day one.

### 5.2 GoCardless / Stripe (deferred)
- **GoCardless** = primary (direct-debit-first) provider; **Stripe** = card fallback
  (payment links). Schema carries `Payment.gocardlessId` / `stripeId` and
  `PaymentMethod` includes `GOCARDLESS`/`STRIPE`/`CASH`/`CHEQUE`/`BACS`.
  `POST /settings/payment/:provider/connect` exists as a Phase-1 stub (boolean flag
  only, no real OAuth). No provider integration code beyond the stub.

### 5.3 Resend (live)
- **Role:** transactional email for invite delivery. `sendInviteEmail()` in
  `src/lib/email.ts` sends via the Resend SDK. The `businessName` field
  (user-supplied) is HTML-escaped before interpolation; the invite URL is encoded
  with `encodeURI`.

### 5.4 Supabase Auth (live)
- JWT issuance (ES256), JWKS endpoint for verification. `POST /auth/signup` replaces
  the retired `handle_new_user` trigger; the trigger SQL can be dropped via
  `docs/sql/drop_handle_new_user.sql`.

---

## 6. Frontend Design (high level — separate repo)
- **Stack (intended):** Vite + React + TypeScript with the **Supabase JS client**
  for auth. *(Confirm in the frontend repo.)*
- **Auth screens** (Screens 1–5) are handled entirely by Supabase; the frontend
  obtains an ES256 JWT, then calls `GET /auth/me` to check for an existing Profile.
  If 404, it calls `POST /auth/signup` to create one.
- **Admin route structure** (from `designFindings.md`): `/dashboard`,
  `/round-planner`, `/todays-work`, `/customers` (+ detail tabs), `/debt-board`,
  `/reports/history`, `/complaints`, `/settings`, `/technicians`, `/setup` (wizard).

---

## 7. Security Design
- **Auth boundary:** all backend routes **except `/health`**, `GET /invites/:token`**,
  and (partially) `GET /auth/me` require a Bearer JWT via `requireAuth`.
- **No secret on backend:** verification is via JWKS public keys (ES256); the
  legacy HS256 shared secret was removed.
- **Schema-per-tenant isolation:** each tenant's operational data lives in its own
  PostgreSQL schema. `requireTenantAccess` resolves the schema from the JWT on every
  request and provides a schema-scoped `TenantPrismaClient`. There is no
  cross-tenant data access path in the application layer.
- **CORS:** locked to `FRONTEND_URL` environment variable (`cors({ origin:
  FRONTEND_URL, credentials: true })`). The backend exits at startup if
  `FRONTEND_URL` or `INVITE_BASE_URL` are missing.
- **Invite security:** cross-tenant (invite.tenantId ≠ profile.tenantId) and
  cross-email (req.user.email ≠ invite.email) acceptance are explicitly rejected
  with 403 in `POST /invites/:token/accept`.
- **Email injection prevention:** `businessName` is HTML-escaped; invite URL is
  `encodeURI`-encoded before embedding in Resend email body.
- **Credential handling:** secrets in `.env` (gitignored); `.env.example` documents
  keys without values; no secrets in code.
- **Error hygiene:** typed `AppError` maps to its status; all else → generic 500
  (internals logged, not returned).

---

## 8. Deferred Design Decisions
Items not-yet-designed / pending:

- **Mobile completion delivery (DP-MOBILE)** — React Native/Expo app is Phase 2; all
  mobile FE tickets are deferred.
- **GHL automation trigger mechanism (DP-GHL)** — contact-field-sync-and-watch vs
  direct API call (blocks messaging/payment automation design).
- **`RoundOccurrence` model** — deferred; per-occurrence assignment is derived from
  Visits in Phase 1.
- **Technician availability model (#4)** — availability status enum + leave date;
  technician self-mark "unable to attend" trigger undesigned (OQ#13 / MOB-2).
- **Notifications feed entity (#6)** — push vs in-app (DP-NOTIF).
- **Skip-reason enum (#7)** — currently free `String` on `Visit`.
- **Assignment history (#9)** — per-round assignment history.

---

*Source documents: `PROGRESS.md`, `prisma/schema.prisma`, `prisma/tenant/schema.prisma`,
`docs/designFindings.md`, `docs/RoundFlow_Context_and_Roadmap_v1.md`, `src/` (codebase).*
