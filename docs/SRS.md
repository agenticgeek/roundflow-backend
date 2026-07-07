# RoundFlow Phase 1 — Software Requirements Specification

> Derived strictly from `docs/designFindings.md`, `docs/RoundFlow_Context_and_Roadmap_v1.md`,
> `PROGRESS.md`, and `prisma/schema.prisma`. Where a requirement traces to a
> specific wireframe, the source screen/modal is cited. Nothing here is invented
> beyond what those documents evidence.
>
> Priority uses MoSCoW (**Must / Should / Could**), derived from the roadmap's
> "core operational loop" emphasis and Phase 1 success criteria: loop-spine
> capabilities are **Must**, exception/supporting flows are **Should**, and
> analytics/convenience features are **Could**.

---

## 1. Introduction

### 1.1 Purpose
This document specifies the requirements for **RoundFlow Phase 1**, a field
service management (FSM) platform for a single UK-based window-cleaning business.
It is the authoritative statement of *what* the system must do; the *how* is
covered in `SDS.md`.

### 1.2 Scope
RoundFlow Phase 1 is a **standalone web-based SaaS** consisting of:
- A **React web admin app** (separate frontend repo) implementing the RoundFlow
  admin screen set (Dashboard, Round Planner, Today's Work, Customers &
  Properties, Debt/Payment, Reports/History, Complaints, Settings, Technicians).
- A **mobile technician app** ("RoundFlow Technician") for field job execution.
- A **Node/Express + TypeScript backend** with a **Supabase-hosted Postgres**
  database (Prisma ORM) as the system of record for all operational data.
- **Supabase Auth** for identity, and **GHL** (GoHighLevel) used as a *utility*
  for messaging and to assist payment flows — not as the platform.

Phase 1 targets **one client / single tenant**. Multi-tenancy and the GHL
Marketplace listing are Phase 2.

### 1.3 Definitions & Acronyms
| Term | Meaning |
|------|---------|
| FSM | Field Service Management |
| Round | A geographic cluster of properties cleaned together on a recurring cadence (the operational unit of the business) |
| Occurrence | The group of Visits for a round sharing a cycle date (a single recurrence of a round) |
| Visit | One clean of one property on one date (the operational spine record) |
| Service Plan | A property's recurring service agreement (price, clean method, payment method) |
| Cycle | The recurrence period terminology used throughout the UI (e.g. 4-week cycle) |
| GHL | GoHighLevel — external messaging/payments utility |
| JWKS | JSON Web Key Set (public keys for JWT verification) |
| ES256 | ECDSA using P-256 and SHA-256 (asymmetric JWT signing algorithm Supabase uses) |
| OCP | Open/Closed Principle (SOLID) — the `profileId`-first service seam for Phase 2 |
| MoSCoW | Must / Should / Could / Won't prioritisation |
| Payment Hold | A flag blocking a visit/round pending payment resolution |

### 1.4 Out of Scope (Phase 1)
From `RoundFlow_Context_and_Roadmap_v1.md` (Phase 2/3) and design decisions:
- GHL Marketplace listing, OAuth install flow, and public marketplace onboarding.
- Multi-tenancy / per-tenant data isolation (RLS).
- Route optimisation / dispatch, live GPS tracking (the Dashboard GPS map is a
  placeholder component only), weather API integration.
- Advanced analytics / BI dashboards; AI quote handling, risk/crew scoring.
- Customer-facing portal (the mobile app is technician-facing only — see MOB-1).
- GHL Custom Objects as the data layer, GHL Workflows as business logic, GHL
  Custom Pages/iframe delivery, GHL OAuth as primary auth (all retired).
- Setup Wizard **Step 2 (Payment Setup)** and **Step 5 (SMS Templates)** are
  **deferred stubs** in Phase 1 (Payment configured separately; SMS templates
  managed via GHL).

---

## 2. System Overview
RoundFlow manages a recurring, round-based window-cleaning operation. The
business runs cleaning **rounds** (geographic clusters of properties) on a
recurring **cycle**. The system's spine is the core operational loop:

> **Property → Service Plan → Visit Generation → Round Planner → Today's Work → Mobile Completion → Payments**

**Users:** office admins/managers (web admin app) run scheduling, customers,
debt, complaints, and reporting; field technicians (mobile app) execute the
day's visits. The problem it solves: existing tools (FieldTask, Jobber,
CleanerPlanner per the brief) don't adequately support the recurring round
model, GoCardless-first payments, or window-cleaning operational patterns
(no time slots, round-based routing, access-note management, payment holds).

The backend is the **system of record**; GHL is a downstream utility for
messaging and payments. Success (per the roadmap) means one full round cycle
runs end-to-end with payments triggering automatically post-completion, an
accurate debt board, and reminders firing — without manual workarounds.

---

## 3. User Roles
Roles derive from the `UserRole` enum (`schema.prisma`): **ADMIN, MANAGER,
TECHNICIAN**. The role lives on the `Profile` model (the public-schema mirror of
Supabase `auth.users`).

### 3.1 Admin
- **Who:** business owner / office lead. Per the Setup Wizard, all self-signups
  are admins (technicians are invited, not self-signup — see FR-TECH / FR-AUTH).
- **Can do:** full admin surface — run the Setup Wizard, manage customers &
  properties, rounds & scheduling, technicians, debt/payments, invoices,
  complaints, reports, and settings.
- **Interface:** web admin app.

### 3.2 Manager
- **Who:** a `UserRole.MANAGER` profile. The enum exists; the wireframes do not
  separately enumerate a distinct manager-only screen set. *(No source
  distinguishes manager permissions from admin; treated as an operational admin
  variant until the design specifies otherwise.)*
- **Can do:** admin-side operations (per available evidence, same web surface).
- **Interface:** web admin app.

### 3.3 Technician
- **Who:** a field operative. Modelled as `Technician` (operational data), linked
  1:1 to a `Profile` with role `TECHNICIAN` once an invite is accepted;
  `Technician.profileId` is **null while invited but not yet accepted**.
- **Can do:** view their assigned day's jobs and execute visits — Start, Complete
  (with photos/notes), Skip (with reason), Report access problem, Record cash
  payment. Onboards via an **invite code** then "Complete Your Profile".
- **Interface:** mobile technician app (they never touch the web admin;
  admin↔technician messaging is admin-initiated per Screen 27).

---

## 4. Functional Requirements

### FR-AUTH — Authentication & Authorisation
| ID | Requirement | Source | Priority |
|----|-------------|--------|----------|
| FR-AUTH-1 | Users authenticate via **Supabase Auth**; the auth UX (login, signup, forgot-password, OTP, reset) is owned by the frontend + Supabase, not the backend. | Screens 1–5; PROGRESS Architecture Decisions | Must |
| FR-AUTH-2 | Support email/password login and **"Continue with Google"** OAuth (Google configured in Supabase + Google Cloud Console). | Screen 1; PROGRESS | Must |
| FR-AUTH-3 | The backend SHALL verify a Supabase-issued **Bearer JWT (ES256)** against the project **JWKS endpoint** on every protected route; reject missing/invalid tokens with 401. | PROGRESS (requireAuth) | Must |
| FR-AUTH-4 | On signup, a `Profile` row SHALL be auto-created (public-schema mirror of `auth.users`) via a Supabase **Postgres trigger** (`handle_new_user`). | PROGRESS Architecture Decisions | Must |
| FR-AUTH-5 | A protected `GET /auth/me` SHALL return the caller's `Profile` (by `supabaseUserId`). | PROGRESS (Backend) | Should |
| FR-AUTH-6 | Password reset SHALL be handled entirely by Supabase (no backend routes). | Screens 3–5; PROGRESS | Must |

### FR-SETUP — Setup Wizard (8 steps; steps 2 & 5 deferred)
Full-screen first-run wizard (Screen 6), 8 steps. Backend implemented as
`/setup/*` behind `requireAuth` with all logic in `SetupService`. Step
completion is **derived**, not stored; a `setupCompleted` flag gates the wizard.
| ID | Requirement | Source | Priority |
|----|-------------|--------|----------|
| FR-SETUP-1 | Step 1 — **Business Profile**: Business Name, Phone, Email, Company Number, VAT Registration/Registered, Default Working Days, Timezone, Currency → upsert `BusinessSettings`. Complete when `businessName` is set. | Screen 6 step 1 | Must |
| FR-SETUP-2 | Step 2 — **Payment Setup** (GoCardless, BACS/bank): **deferred stub** ("Payment setup is configured separately"), no DB write. | Screen 6 step 2 | Won't (Phase 1) |
| FR-SETUP-3 | Step 3 — **Service Catalogue**: create/replace `Service` entries (name, category, description, defaultPrice, active). Complete when ≥1 Service exists. | Screen 6 step 3; Screen 24 | Must |
| FR-SETUP-4 | Step 4 — **Round Settings**: default cycle length, working days → upsert `BusinessSettings`. Complete when `defaultCycleLength` is set. | Screen 6 step 4 | Must |
| FR-SETUP-5 | Step 5 — **SMS/WhatsApp Templates**: **deferred stub** ("SMS templates are managed via GHL"), no DB write. | Screen 6 step 5 | Won't (Phase 1) |
| FR-SETUP-6 | Step 6 — **Technician Management**: create invite-pending `Technician`(s) (`profileId=null`). Complete when ≥1 Technician exists. | Screen 6 step 6 | Must |
| FR-SETUP-7 | Step 7 — **Service Area(s)**: create `ServiceArea`(s). Complete when ≥1 ServiceArea exists. | Screen 6 step 7 | Must |
| FR-SETUP-8 | Step 8 — **Assign Round**: create the first `Round` with `status=ACTIVE`. Complete when ≥1 ACTIVE Round exists. | Screen 6 step 8 | Must |
| FR-SETUP-9 | `GET /setup/status` SHALL return per-step completion + `setupCompleted` + `allRequiredComplete`. | PROGRESS (Backend) | Must |
| FR-SETUP-10 | Mutating step endpoints SHALL be blocked (403) once setup is complete; `POST /setup/complete` SHALL return 409 if already complete, 400 listing missing required steps, else set `setupCompleted=true`. | PROGRESS (Backend) | Must |

### FR-CUST — Customers & Properties
| ID | Requirement | Source | Priority |
|----|-------------|--------|----------|
| FR-CUST-1 | Provide a **master customer list** with per-row status (Active/Hold), address, round, frequency, price, technician, next due, payment status; summary KPIs (Total Customers, Active, Payment Holds, Amount Due); filter by round/status. | Screen 14 | Must |
| FR-CUST-2 | Provide a **Customer Detail** record with six tabbed routes: Overview, Service Plan, Visit History, Payments, Notes & Risk, Photos; Property Information + Payment & Status blocks. | Screen 15 | Must |
| FR-CUST-3 | Customer creation happens **within the Add Property flow** (Step 1 doubles as customer creation — no separate Add Customer screen). Captures Customer Name, Property Name (optional), Phone, Email (optional), Address, Postcode, Service Area, Property Type. | M6; OQ#2 | Must |
| FR-CUST-4 | A property MAY be created **unassigned** (no round) via "Save & Assign Later" and assigned later from the customer record (`Property.roundId` nullable). | Screen 31; OQ#8 | Must |
| FR-CUST-5 | Customer Detail actions: Edit Customer, **Pause/Resume Service** (M9), Send Message, Generate Invoice (M4 from a visit row). | Screen 15; M4; M9 | Should |
| FR-CUST-6 | Notes & Risk: capture property access notes and **risk notes** (surfaced prominently to technicians). | Screen 15; mobile Screen 7 | Must |

### FR-ROUND — Rounds & Scheduling
| ID | Requirement | Source | Priority |
|----|-------------|--------|----------|
| FR-ROUND-1 | Provide a **Round Planner** with Calendar, Map, and List views over rounds/stops; header controls (area selector, view toggle, search, technician & status filters, + Add Round); stats bar (Total Stops, Round Value, Estimated Duration, Completion %, Payment Holds, Issues). | Screens 8–11 | Must |
| FR-ROUND-2 | **Add Round** SHALL be available as a **sidebar Quick Action** and a "+ Add Round" button, opening the 5-step CreateRoundModal (Round Details · Assign Area · Add Properties · Assign Technician · Review & Save). | Design Update #4; Screen 8 | Must |
| FR-ROUND-3 | A round MAY carry **multiple technicians**; **job division is manual** (per-Visit allocation). Assignment is **per occurrence**, not once-and-fixed. | Screen 30; Design Update #1 | Must |
| FR-ROUND-4 | Provide a **Round & Technician Assignment** module: Overview (rounds with Assigned Technicians + Count), Round Details (Replace / Remove / + Add Technician, Assignment History), Technician Details (availability, assigned rounds, upcoming schedule). | Screen 30 | Should |
| FR-ROUND-5 | Multi-technician assignment SHALL use a **3-step wizard**: Select Technicians (2+) → Allocate Jobs (manual) → Review & Confirm; warn when editing an in-progress occurrence. | Screen 30 | Should |
| FR-ROUND-6 | **Assign Property to Round** SHALL let the admin choose **One technician for all jobs** vs **Multiple technicians with manual job allocation**, or **Save & Assign Later** (unassigned). | Screen 31 | Must |
| FR-ROUND-7 | Existing rounds MAY have **properties added** after creation (Add Round Step 3 "Add Properties" — search existing or add inline; and Screen 31). | Design Update #5 | Should |
| FR-ROUND-8 | When a recurrence comes due without an assignee (or a technician is unavailable), surface an **alert banner** → **Upcoming Property Recurrences** modal listing unassigned recurrences with per-row Assign. | Screen 8 update; M14 | Should |
| FR-ROUND-9 | A round MAY have **multiple technicians assigned simultaneously**. Job division between technicians is performed **manually by the admin** (per-`Visit` allocation via the 3-step Select → Allocate → Review wizard); there is **no automatic split**. | Screen 30 **Rule** | Must |
| FR-ROUND-10 | Technician assignment is **per-occurrence, not inherited**: each new recurrence of a property's visit **starts unassigned** and requires **explicit admin assignment** before dispatch. The previous occurrence's technician is **not auto-carried** by visit generation. | M14 **Rule**; Screen 30 | Must |

### FR-VISIT — Visit Generation & Today's Work
| ID | Requirement | Source | Priority |
|----|-------------|--------|----------|
| FR-VISIT-1 | Visits SHALL be **auto-generated** from Service Plans + Round cadence via a backend **cron** job (not GHL). | Roadmap §5 | Must |
| FR-VISIT-2 | A `Visit` represents one clean of one property on one date, with status (Scheduled / In Progress / Completed / Skipped), price, payment-hold flag, per-visit technician assignment. | schema `Visit`; Screen 12/13 | Must |
| FR-VISIT-3 | Provide **Today's Work**: live workday monitor — KPI tiles (Scheduled/In Progress/Completed/Skipped/Issues/Payment Holds/Value), rounds table with progress, technician workload cards, "Close Day". | Screen 12 | Must |
| FR-VISIT-4 | Provide a **Round Details slide-out panel** with per-property job status, progress, mini stats, and Quick Actions (Reassign Technician, Push Missed Jobs). | Screen 13 | Should |
| FR-VISIT-5 | **Reassign Technician** (M15): move remaining jobs from one technician to another, with note + "Notify new technician" checkbox. | Screen 13; M15 | Should |
| FR-VISIT-6 | Support **one-off jobs** (Add One-Off Job, M2) that don't join regular rounds and don't recur (`Visit.isOneOff`). | M2; schema | Should |
| FR-VISIT-7 | Visit exceptions SHALL be captured as **Issues** (e.g. access problem, gate locked) and surfaced as Issue counts/flags. | schema `Issue`; Screen 13 | Should |

### FR-DEBT — Debt / Payment Risk Board
| ID | Requirement | Source | Priority |
|----|-------------|--------|----------|
| FR-DEBT-1 | Provide a **Debt / Payment Risk Board** with header KPIs (Total Outstandings, Failed GoCardless, Due Before Clean, Hold Next Clean, Bad Debt) and category tabs: Invoice Sent · Due Before · Failed GC · 7 Days Over · 14 Days Over · On Hold · Bad Debt. | Screen 16 | Must |
| FR-DEBT-2 | Customer cards SHALL show amount owed, payment method, contact status (Not yet contacted / Contacted), last contact; per-card actions Send Reminder, View Invoice; bulk select. | Screen 16/17 | Must |
| FR-DEBT-3 | Provide **Send Payment Reminder** (M3, SMS/WhatsApp/Email + template) and **Send Payment Link** (M8). | M3; M8 | Should |
| FR-DEBT-4 | Support **Bad Debt** (admin-set flag) and payment-hold buckets. Buckets are derived from payment status + invoice dates, except Bad Debt (`Customer.badDebt`) and hold (`Visit.paymentHold`). | Screen 16; PROGRESS | Should |

### FR-INVOICE — Invoicing & Payments
| ID | Requirement | Source | Priority |
|----|-------------|--------|----------|
| FR-INVOICE-1 | **Generate Invoice** (M4) for a visit: summary (customer, property, visit date, amount, email), auto invoice number, notes, "Also send via email"; **Preview Invoice** (M5); success state (M10). | M4/M5/M10; schema `Invoice` | Should |
| FR-INVOICE-2 | Payment SHALL be triggered automatically post-completion (success criterion); record `Payment` with method (GoCardless / Cash / Cheque / BACS / Stripe) and status. | Roadmap success criteria; schema `Payment` | Must |
| FR-INVOICE-3 | **GoCardless** SHALL be the primary payment path; **Stripe** the card fallback (payment links). | Roadmap; schema `gocardlessId`/`stripeId` | Must |
| FR-INVOICE-4 | **Cash/Cheque** payments SHALL be recordable (technician "Record cash payment"; `Payment.method`). | Mobile Screen 8; schema | Should |

### FR-COMPLAINT — Complaints
| ID | Requirement | Source | Priority |
|----|-------------|--------|----------|
| FR-COMPLAINT-1 | Provide a **Complaints** queue with cards (status badge Open/In Review/Revisit Booked/Resolved, issue title, customer+area, technician, photo count, revisit date), sorted by recency; **Log Complaint** action. | Screen 20 | Should |
| FR-COMPLAINT-2 | Provide **Complaint Detail** (two-panel master/detail) with severity (Low/Medium/High), actions Schedule Revisit / Mark In Review / Resolve, and a two-way message thread. | Screen 21 | Should |
| FR-COMPLAINT-3 | **Log New Complaint** (Screen 22): customer selector, issue type, description, severity, assign technician. | Screen 22; schema `Complaint` | Should |
| FR-COMPLAINT-4 | Severity has three levels (Low/Medium/High) and does **not** affect list ordering. | OQ#10 | Could |

### FR-REPORT — Reports & History
| ID | Requirement | Source | Priority |
|----|-------------|--------|----------|
| FR-REPORT-1 | Provide **Reports & History**: header KPIs (Total Revenue, Completed Visits, Completed Rounds, Undone Payments, % vs last 30 days), Revenue Overview chart, Technician Performance table, Visit History table, System Activity Log. | Screen 18 | Could |
| FR-REPORT-2 | Provide a full **Technician Performance** view at `/reports/technicians`. | Screen 19; OQ#7 | Could |
| FR-REPORT-3 | Maintain a **System Activity Log** of timestamped events (visits generated, property added, technician assigned, round updated). | Screen 18; schema `ActivityLog` | Could |

### FR-TECH — Technician Management
| ID | Requirement | Source | Priority |
|----|-------------|--------|----------|
| FR-TECH-1 | Provide a **Technicians list** (KPIs, cards with role, status, rounds, today's jobs, issues, revenue, assigned rounds, contact) and **Technician Detail**. | Screens 25/26 | Should |
| FR-TECH-2 | Support **Add / Edit / Delete** technician (Screens 28/29, M13). | Screens 28/29; M13 | Should |
| FR-TECH-3 | Technician cards SHALL show an **App Status** availability state (Active / Unavailable — e.g. "On leave <date> — N jobs require reassignment"); marking Unavailable flags upcoming recurring jobs for reassignment. | Screen 25 update; Design Update #2 | Should |
| FR-TECH-4 | Provide **admin → technician messaging** (Screen 27): SMS/WhatsApp, character counter, credit cost, schedule-for-later, previous messages. | Screen 27 | Could |
| FR-TECH-5 | Technicians are onboarded by **invite** (not self-signup); an invited technician has `profileId=null` until the invite is accepted. | Screen 6 step 6; schema; mobile Screen 2 | Must |

### FR-SETTINGS — Settings
| ID | Requirement | Source | Priority |
|----|-------------|--------|----------|
| FR-SETTINGS-1 | Provide a **Settings** area (two-column nav) with sections: Business Profile, Payment Setup, Round Settings, SMS Templates, Technician Mgmt, Service Areas, Service Catalogue. | Screen 23 | Should |
| FR-SETTINGS-2 | **Business Profile** settings: Business Name, Phone, Email, Service Area, Default Working Days, Timezone, Currency (edit/save). | Screen 23 | Should |
| FR-SETTINGS-3 | **Service Catalogue** settings: services table with category tags, description, default price, active toggle, edit/delete. | Screen 24 | Should |
| FR-SETTINGS-4 | Payment Setup & SMS Templates settings correspond to the deferred Setup steps (Payment configured separately; SMS via GHL). | Screen 23; Setup steps 2/5 | Could |

### FR-MOBILE — Mobile Technician App
| ID | Requirement | Source | Priority |
|----|-------------|--------|----------|
| FR-MOBILE-1 | Technician authenticates (Sign in) and onboards via **invite code** → **Complete Your Profile**; Forgot/Reset via Supabase. | Mobile Screens 1–4 | Must |
| FR-MOBILE-2 | **Today / Job List**: greeting, today's round (name, N properties, progress e.g. 2/5), ordered property list with status. | Mobile Screen 5 | Must |
| FR-MOBILE-3 | **Property Details**: status badge, directions, **Safety/risk note** (prominent), **Access notes** incl. gate code, service details (service, price, payment method, last clean), Start visit. | Mobile Screen 7 | Must |
| FR-MOBILE-4 | **Active Visit** execution: **Record cash payment**, **Skip property**, **Report access problem**, **Mark property complete**; before/after **Photos** (optional); internal "note for office". | Mobile Screen 8 | Must |
| FR-MOBILE-5 | **Skip** SHALL capture a reason: Not home / No access / Customer refused / Unsafe conditions / Other (SkipSheet). | Mobile SkipSheet | Must |
| FR-MOBILE-6 | **Report access problem** SHALL capture a free-text "what prevented access?" description (AccessIssueSheet). | Mobile AccessIssueSheet | Should |
| FR-MOBILE-7 | **Cash payment** SHALL require explicit confirmation ("Confirm £X received in cash", CashSheet). | Mobile CashSheet | Must |
| FR-MOBILE-8 | **Complete** SHALL confirm and notify the customer (CompleteConfirmSheet). | Mobile CompleteConfirmSheet | Must |
| FR-MOBILE-9 | Provide a **Notifications** feed (schedule update, round confirmed, payment collected). | Mobile Screen 6 | Should |
| FR-MOBILE-10 | Delivery form (native app vs mobile web) is **not yet decided**. | Roadmap §Phase 1; PROGRESS Decisions Pending | (blocked) |

---

## 5. Non-Functional Requirements

### 5.1 Performance
- **NFR-PERF-1:** Today's Work and Round Planner present live, workday-scale data
  (KPIs, per-visit progress); the design implies near-real-time refresh of the
  active day. *(No specific latency/throughput targets are stated in the sources.)*
- **NFR-PERF-2:** Runtime DB access goes through the Supabase **transaction-mode
  pooler** (PgBouncer, port 6543); migrations use the **direct** connection
  (port 5432). Backend uses a single shared Prisma client (pool reused across
  dev hot-reloads).

### 5.2 Security
- **NFR-SEC-1:** All backend routes except `/health` SHALL require a valid
  **Supabase ES256 Bearer JWT**, verified against the JWKS endpoint.
- **NFR-SEC-2:** No auth secret is stored on the backend (JWKS/public-key
  verification only; the legacy HS256 shared secret was removed).
- **NFR-SEC-3:** **Single-tenant Phase 1** — one business. No row-level security
  (RLS) or per-tenant isolation in Phase 1 (a documented decision; Phase 2 adds
  isolation). The service layer takes `profileId` first as the **OCP seam** so a
  Phase 2 tenant-scoped implementation can be swapped in without route changes.
- **NFR-SEC-4:** Secrets live in `.env` (gitignored); no secrets in code or
  committed files. `.env.example` documents required keys without values.
- **NFR-SEC-5:** CORS currently allows all origins (dev) — to be tightened to
  the frontend origin(s) before production.

### 5.3 Scalability
- **NFR-SCALE-1:** The architecture is designed so **Phase 2 multi-tenancy** can
  be introduced without rewriting routes: service methods are tenant-agnostic in
  Phase 1 (single `BusinessSettings` singleton) but take `profileId` as the
  future tenant-resolution seam.
- **NFR-SCALE-2:** Schema/architecture choices must not block Phase 2 (per the
  roadmap instruction): every Customer/Property carries `ghlContactId` from day
  one; Phase 2 concerns (per-tenant isolation, RLS) are deferred but anticipated.

### 5.4 Reliability
- **NFR-REL-1:** Errors SHALL be handled centrally; typed `AppError`s carry an
  HTTP status + message, everything else returns 500 (no leakage of internals).
- **NFR-REL-2:** Visit generation, reminders, and debt checks run as backend
  cron jobs; the system SHALL support one full round cycle end-to-end without
  manual workarounds (Phase 1 success criterion).
- **NFR-REL-3:** Seed/migration state is reproducible; migrations are tracked in
  `prisma/migrations`. *(Note: the `handle_new_user` Supabase trigger is not yet
  version-controlled — a known reliability gap.)*

---

## 6. External Integrations
| Integration | Role | Status |
|-------------|------|--------|
| **Supabase Auth** | Identity: signup/login/OAuth/reset; issues ES256 JWTs; `handle_new_user` trigger creates `Profile`. | **Live** (backend verifies JWTs; trigger created in Supabase) |
| **Supabase Postgres** | System of record (Prisma ORM). | **Live** |
| **GHL (GoHighLevel)** | Utility for **messaging** (SMS/WhatsApp/Email) and to **assist payment flows**; single GHL account. **Not** the platform. Trigger mechanism (contact-field-sync-and-watch vs direct API) is an **open decision**. | **Deferred** (architected for; `ghlContactId` present; no integration code) |
| **GoCardless** | Primary (direct-debit-first) payment provider. | **Deferred** (schema fields present; no code) |
| **Stripe** | Card payment fallback (payment links). | **Deferred** (schema fields present; no code) |
| **Google OAuth** | "Continue with Google" sign-in via Supabase provider; configured in Supabase + Google Cloud Console; **backend uninvolved**. | Configured (Supabase-side) |

---

## 7. Constraints & Assumptions
- **Single tenant (Phase 1):** one window-cleaning business; `BusinessSettings`
  is a DB-guarded singleton.
- **UK market:** GBP currency (£ throughout), UK postcodes / postcode sectors,
  UK phone formats, GoCardless-first (direct debit) payment culture.
- **Recurring round model:** no time slots; work is organised by round + cycle,
  not appointments.
- **Backend is the system of record;** GHL is downstream. Every Customer/Property
  carries `ghlContactId` as the GHL join point from day one.
- **Frontend is a separate repo;** it owns all UI and the auth UX.
- **Mobile delivery form (native vs web) is TBD.**
- **GHL automation trigger mechanism is TBD** (resolve before visit-generation /
  payment logic depends on it).
- **`designFindings.md` is the source of truth** for screens/flows; the old GHL-
  native dev brief is background domain context only.

---

## 8. Open Questions
From `designFindings.md` (OQ#13, MOB-1/2/3) and `PROGRESS.md` Decisions Pending.

| ID | Question | Blocks / Affects |
|----|----------|------------------|
| OQ#13 | Where does a technician mark themselves **"unable to attend"** a whole recurring round/occurrence? Admin shows an availability status; mobile has only per-visit Skip. Is availability admin-set only, or is a technician-facing action undesigned? | FR-TECH-3, FR-ROUND-8, technician availability model |
| MOB-1 | Is the "B2C" mobile filename intentional? All observed content is technician-facing; confirm no separate customer app is expected. | Mobile app scope |
| MOB-2 | (See OQ#13) technician self-mark "unavailable" trigger. | FR-MOBILE, FR-TECH |
| MOB-3 | Notifications — push vs in-app only? Backing feed/entity undefined. | FR-MOBILE-9, notifications entity |
| DP-GHL | GHL automation **trigger mechanism**: contact-field-sync-and-watch vs direct API call. | FR-INVOICE, messaging, visit-generation/payment logic |
| DP-MOBILE | **Mobile completion delivery**: native app vs mobile web. | FR-MOBILE (all) |
| DP-TRIGGER | `handle_new_user` **trigger provenance**: commit SQL as a migration vs leave Supabase-managed. | FR-AUTH-4 reliability |
| DP-AUTHHARD | **Auth hardening**: add `audience`/`issuer` checks (and role/claims validation) to JWT verification before production. | FR-AUTH-3 |
| DP-ROLES | **App roles in JWT**: `req.user.role` is the raw Supabase claim (`authenticated`), not the app role — read app role from `Profile` per request vs custom JWT claims. | Role-based authorisation |

---

*Source documents: `docs/designFindings.md`, `docs/RoundFlow_Context_and_Roadmap_v1.md`, `PROGRESS.md`, `prisma/schema.prisma`. Screen/modal numbers refer to `designFindings.md`.*
