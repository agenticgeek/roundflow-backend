# RoundFlow Phase 1 — Roadmap

> Linear-ready delivery plan. Every checkbox is designed to become **one Linear
> ticket** (roughly one PR's worth of work). Backend and frontend are tracked
> separately per milestone.
>
> **Status legend:** 🔴 Not Started · 🟡 In Progress · ✅ Done
>
> **Ticket ID:** `BE-M<milestone>-<nn>` (backend) / `FE-M<milestone>-<nn>` (frontend).
> **Labels:** each ticket ends with `labels: <side>, <domain>` — paste straight into Linear.
> **Screen refs:** `Screen N` / `MN` / `Mobile Screen N` cross-reference
> `docs/designFindings.md`. FR refs cross-reference `docs/SRS.md`.
>
> Sources: `PROGRESS.md`, `docs/designFindings.md`, `docs/SRS.md`, `docs/SDS.md`,
> `docs/RoundFlow_Context_and_Roadmap_v1.md`, `prisma/schema.prisma`.

---

## Product Vision
RoundFlow Phase 1 delivers a **standalone web + mobile FSM platform** for a single
UK window-cleaning business, running the full operational loop end-to-end for one
client — properties and service plans, auto-generated visits organised into
rounds, live workday execution on a technician mobile app, and GoCardless-first
payments with a debt board. Supabase provides data + auth; GHL is a messaging/payments utility.
**Schema-per-tenant multi-tenancy is live from day one** — each tenant gets an
isolated `t_<20-hex>` PostgreSQL schema provisioned atomically at signup. The
`profileId` service seam and `ghlContactId` join point are already in place,
positioning Phase 1 for Phase 2 (GHL Marketplace listing + OAuth install flow).

## Operational Loop
Every milestone delivers a working slice of the product spine:

> **Property → Service Plan → Visit Generation → Round Planner → Today's Work → Mobile Completion → Payments**

Two locked assignment rules run through the scheduling milestones (see
`designFindings.md` Screen 30 / M14 **Rule** lines, SRS FR-ROUND-9/10, SDS §3.4):
- **Multi-technician rounds** — a round may have >1 technician; job division is **manual** (per-`Visit`).
- **Per-occurrence assignment** — each recurrence **starts unassigned**; technicians are **not auto-inherited** and must be explicitly assigned before dispatch.

---

## M0 — Foundation · ✅ Done
**Goal:** Stand up the schema, auth, server, build/docs tooling, and design baseline so all domain work can begin.
**Depends on:** none

> Backend + design foundation is complete and verified. The frontend-foundation
> tickets below are the frontend repo's equivalent starting point (tracked there).

### Backend tickets
- [x] **[BE-M0-01]** Prisma schema + migrations — 19 models / 16 enums; `init`, `remove-round-technician-id`, `add_setup_completed` applied to Supabase. `labels: backend, infra`
- [x] **[BE-M0-02]** `requireAuth` middleware — ES256 JWKS verification → `req.user`; 401 on missing/invalid. `labels: backend, auth`
- [x] **[BE-M0-03]** ~~`handle_new_user` Profile trigger~~ **Replaced** by `POST /auth/signup` (trigger dropped 2026-07-21 — see `docs/sql/drop_handle_new_user.sql`). `GET /auth/me` still confirmed. `labels: backend, auth`
- [x] **[BE-M0-04]** Express app skeleton — cors, json, `/health`, centralised `AppError` handler. `labels: backend, infra`
- [x] **[BE-M0-05]** Prisma client singleton + idempotent dev seed. `labels: backend, infra`
- [x] **[BE-M0-06]** Build pipeline (`clean → typecheck → emit dist`) + `start:prod`. `labels: backend, infra`
- [x] **[BE-M0-07]** OpenAPI spec (`swagger.ts`) served at `/docs` + `/openapi.json`. `labels: backend, docs`
- [x] **[BE-M0-08]** ~~Update `handle_new_user` trigger~~ **Superseded** — trigger dropped entirely (2026-07-21). Tenant + Profile provisioning moved to `POST /auth/signup`; `company_name` collected by Setup Wizard step 1 instead. `labels: backend, auth`

### Frontend tickets
- [ ] **[FE-M0-01]** Scaffold frontend (Vite + React + TS) + Supabase JS client + env config. `labels: frontend, infra`
- [ ] **[FE-M0-02]** Auth screens — Login + Sign Up via Supabase (email/password + Continue with Google). Sign Up passes **Full name** + **Company name** as user metadata; email confirmation via **magic link** (Screen 1, Screen 2). `labels: frontend, auth`
- [ ] **[FE-M0-03]** Password reset flow — Forgot + Reset via Supabase **magic link** (`resetPasswordForEmail` → link → `/reset-password` route → `updateUser({ password })`). **OTP (Screen 4) deferred — not built in Phase 1** (magic link used instead) (Screen 3, Screen 5). `labels: frontend, auth`
- [ ] **[FE-M0-04]** App shell + protected routing + left-sidebar nav (Dashboard · Round Planner · Today's Work · Customers · Debt/Payment · Reports · Complaints · Settings · Technicians). `labels: frontend, infra`
- [ ] **[FE-M0-05]** API client wrapper — attach Supabase Bearer token; handle 401 + token refresh. `labels: frontend, infra`
- [ ] **[FE-M0-06]** Google OAuth — "Continue with Google" on login + signup (`signInWithOAuth({ provider: 'google' })`); **`/auth/callback`** route calling `exchangeCodeForSession()`. `labels: frontend, auth`
- [ ] **[FE-M0-07]** Post-signup email confirmation UX — show "Check your email for a confirmation link" after Sign Up; handle the magic-link redirect back into the app. `labels: frontend, auth`
- [ ] **[FE-M0-08]** Auth redirect guards — protected-route wrapper: unauthenticated → `/login`; authenticated user on an auth screen → `/dashboard`. `labels: frontend, auth`

### Definition of Done
- Schema migrated to Supabase; `requireAuth` + `/auth/me` verified with a real ES256 token; `/health` 200; `npm run build` + `/docs` served; `npm audit` 0 vulnerabilities.
- Frontend builds; a user can log in via Supabase and reach an authenticated app shell; API calls carry the Bearer token.

---

## M1 — Setup Wizard · 🟡 In Progress
**Goal:** A first-run admin can configure the business through the 12-step wizard and mark setup complete (step 2 is a deferred stub; step 5 (Message Templates) is now fully built).
**Depends on:** M0

### Backend tickets
- [x] **[BE-M1-01]** `SetupService` + `ISetupService` (OCP seam) + `GET /setup/status` (derived per-step). `labels: backend, setup`
- [x] **[BE-M1-02]** Step 1 & 4 — Business Profile / Round Settings (GET + POST `BusinessSettings` singleton) (Screen 6 steps 1, 4). `labels: backend, setup`
- [x] **[BE-M1-03]** Step 3 — Service Catalogue (GET + create/replace) (Screen 6 step 3). `labels: backend, setup`
- [x] **[BE-M1-04]** Step 6 & 7 — Technicians (invite-pending) + Service Areas (GET + POST) (Screen 6 steps 6, 7). `labels: backend, setup`
- [x] **[BE-M1-05]** Step 8 — first Round (`status=ACTIVE`); step 2 deferred stub (step 5 un-deferred — see BE-M1-12) (Screen 6 steps 8, 2, 5). `labels: backend, setup`
- [x] **[BE-M1-06]** `POST /setup/complete` + `assertSetupIncomplete` guard (403 / 400 / 409). `labels: backend, setup`
- [x] **[BE-M1-08]** Step 9 — Add Properties: Customer + Property + ServicePlan in a single transaction; `roundId` required + must be ACTIVE (FR-SETUP-9). `labels: backend, setup`
- [x] **[BE-M1-09]** Step 10 — Assign Technicians: set `RoundTechnician` rows (replace semantics); rejects inactive technicians + duplicate roundIds (FR-SETUP-10). `labels: backend, setup`
- [x] **[BE-M1-10]** Step 11 — Activate System: generate `Visit` records for `startDate + cycleWeeks`; 409 guard if already complete (FR-SETUP-11). `labels: backend, setup`
- [x] **[BE-M1-11]** Step 12 — Review & Launch: read-only checklist derived from steps 1–11 completion state (FR-SETUP-12). `labels: backend, setup`
- [x] **[BE-M1-12]** Step 5 — Message Templates (SMS / WhatsApp / Email via Resend): real GET + POST (bulk replace semantics); `subject String?` migration added; step complete when ≥1 template saved. `labels: backend, setup, email`
- [ ] **[BE-M1-07]** Integration test — `/setup/*` over HTTP with a real token (currently only proven via `/auth/me` + direct-DB). `labels: backend, setup`

### Frontend tickets
- [ ] **[FE-M1-01]** Setup Wizard shell — 12-step stepper, Back/Continue, progress from `GET /setup/status` (Screen 6). `labels: frontend, setup`
- [ ] **[FE-M1-02]** Step 1 — Business Profile form (Screen 6 step 1). `labels: frontend, setup`
- [ ] **[FE-M1-03]** Step 2 — Payment Setup deferred-stub screen (Screen 6 step 2). `labels: frontend, setup`
- [ ] **[FE-M1-04]** Step 3 — Service Catalogue editor (Screen 6 step 3 / Screen 24). `labels: frontend, setup`
- [ ] **[FE-M1-05]** Step 4 — Round Settings form (Screen 6 step 4). `labels: frontend, setup`
- [ ] **[FE-M1-06]** Step 5 — Message Templates (SMS / WhatsApp / Email); GET/POST against real `/setup/step/5` endpoint (Screen 6 step 5). `labels: frontend, setup`
- [ ] **[FE-M1-07]** Step 6 — Technician Management (add invite-pending technicians) (Screen 6 step 6). `labels: frontend, setup`
- [ ] **[FE-M1-08]** Step 7 — Service Areas (Screen 6 step 7). `labels: frontend, setup`
- [ ] **[FE-M1-09]** Step 8 — Assign Round (create the first round) (Screen 6 step 8). `labels: frontend, setup`
- [ ] **[FE-M1-10]** Step 12 — Review & Launch checklist → `POST /setup/complete`; gate app entry on `setupCompleted` (Screen 6 step 12). `labels: frontend, setup`
- [ ] **[FE-M1-11]** Step 9 — Add Properties: Customer + Property + ServicePlan form; round picker from ACTIVE rounds (Screen 6 step 9). `labels: frontend, setup`
- [ ] **[FE-M1-12]** Step 10 — Assign Technicians: tech multi-picker per ACTIVE round (Screen 6 step 10). `labels: frontend, setup`
- [ ] **[FE-M1-13]** Step 11 — Activate System: date-range picker → trigger visit generation; show count of visits created (Screen 6 step 11). `labels: frontend, setup`

### Definition of Done
- All required steps (1, 3, 4, 5, 6, 7, 8, 9, 10, 11) completable via the UI against the API; `setupCompleted` flips true; the wizard locks (403) after completion; step 2 renders as deferred; step 5 (Message Templates) is now required and must be completed; step 12 is the read-only review screen.

---

## M2 — Customers & Properties · 🟡 In Progress
**Goal:** Admin can create customers + properties (Add Property flow), browse the customer list, and view/edit the full customer record.
**Depends on:** M1

> Backend complete and PR-reviewed (2026-07-21). 5 findings from senior review resolved (F1–F5): `optId` FK normalisation, `Decimal.add()` money accumulation, TECHNICIAN financial-field projection, `paymentStatus` "none" default, `pauseEndDate` guard. BE-M2-07 + BE-M2-08 completed 2026-07-26 (round assignment + FR-FREQ logic). Frontend tickets not yet started. BE-M2-09 completed 2026-07-28 (standalone customer CRUD + property-to-customer linking).

### Backend tickets
- [x] **[BE-M2-01]** Customer service+routes — create/read/update + list with filters (Screen 14). `labels: backend, customers`
- [x] **[BE-M2-02]** Property CRUD — create/read/update; `roundId` nullable (unassigned) (Screen 15). `labels: backend, properties`
- [x] **[BE-M2-03]** Add Property transaction — create Customer + Property together (M6 step 1). `labels: backend, properties`
- [x] **[BE-M2-04]** ServicePlan create/read for a property (price, cleanMethod, paymentMethod, next-due) (Screen 15 Service Plan tab). `labels: backend, service-plans`
- [x] **[BE-M2-05]** Customer Detail aggregate read — property info + payment & status + tab data (Screen 15). `labels: backend, customers`
- [x] **[BE-M2-06]** Pause / Resume service — `LifecycleStatus` transitions (M9). `labels: backend, customers`
- [x] **[BE-M2-07]** Assign Property to Round + "Save & Assign Later" (unassigned) (Screen 31). `labels: backend, rounds`
- [x] **[BE-M2-08]** Frequency change on `ServicePlan` → automatic round reassignment (FR-FREQ-2/3/4): find or create an ACTIVE round matching the new frequency + `serviceAreaId`; copy `RoundTechnician` assignments to any newly created round; no-op if unassigned (FR-FREQ-5) or frequency unchanged (FR-FREQ-6). `labels: backend, rounds`
- [x] **[BE-M2-09]** Standalone customer create (`POST /customers`), customer soft-delete (`DELETE /customers/:id`), add-property-to-existing-customer (`POST /customers/:id/properties`), property soft-delete (`DELETE /properties/:id`). `labels: backend, customers, properties`

### Frontend tickets
- [ ] **[FE-M2-01]** Customers & Properties list — summary KPIs + round/status filters (Screen 14). `labels: frontend, customers`
- [ ] **[FE-M2-02]** Add Property wizard — 7-step flow; step 1 creates the customer (M6). `labels: frontend, properties`
- [ ] **[FE-M2-03]** Assign Property to Round — One-tech vs Multi-tech vs Save & Assign Later (Screen 31). `labels: frontend, rounds`
- [ ] **[FE-M2-04]** Customer Detail shell + Overview tab (Screen 15). `labels: frontend, customers`
- [ ] **[FE-M2-05]** Customer Detail — Service Plan tab (Screen 15). `labels: frontend, service-plans`
- [ ] **[FE-M2-06]** Customer Detail — Visit History tab (Screen 15). `labels: frontend, customers`
- [ ] **[FE-M2-07]** Customer Detail — Notes & Risk tab (Screen 15). `labels: frontend, customers`
- [ ] **[FE-M2-08]** Customer Detail — Photos tab (Screen 15). `labels: frontend, customers`
- [ ] **[FE-M2-09]** Edit Customer + Pause/Resume Service confirm (M9). `labels: frontend, customers`
- [ ] **[FE-M2-10]** Service Plan — frequency picker (FR-FREQ-1); auto-reassignment confirmation flow when the chosen frequency differs from the current round's frequency (FR-FREQ-2). `labels: frontend, service-plans`

### Definition of Done
- Admin can add a customer+property (assigned or unassigned), find it in the list, open the detail with all six tabs, edit it, and attach a service plan; changing a property's frequency automatically reassigns it to the correct round. Covers FR-CUST-1..6, FR-FREQ-1..6.

---

## M3 — Visit Generation & Round Planner · 🟡 In Progress
**Goal:** Visits auto-generate from service plans on the round cadence, and the admin can plan rounds and assign technicians (multi-tech, per-occurrence).
**Depends on:** M2

### Backend tickets
- [ ] **[BE-M3-01]** Visit generation cron — create `Visit`s from `ServicePlan` next-due + `Round` cadence; **new visits start `technicianId=null`** (per-occurrence rule, SRS FR-ROUND-10). `labels: backend, visits`
- [ ] **[BE-M3-02]** Payment-hold gating in generation (respect `Visit.paymentHold`) (FR-VISIT-1). `labels: backend, visits`
- [x] **[BE-M3-03]** Round create (Add Round wizard) + read (Round + **derived** assigned technicians) (Screen 30). `labels: backend, rounds`
- [x] **[BE-M3-04]** Round Planner reads — calendar/list/map data (stops, value, completion %, holds, issues) (Screens 8–11). `labels: backend, rounds`
- [ ] **[BE-M3-05]** Multi-tech allocation — set `Visit.technicianId` per job for an occurrence (manual division, SRS FR-ROUND-9). `labels: backend, rounds`
- [ ] **[BE-M3-06]** Upcoming Property Recurrences — list unassigned upcoming occurrences + per-row assign (M14). `labels: backend, rounds`
- [ ] **[BE-M3-07]** Add properties to an existing round (Add Round step 3 / Screen 31). `labels: backend, rounds`
- [ ] **[BE-M3-08]** One-off job — create a standalone `Visit` (`isOneOff`) not tied to a plan (M2). `labels: backend, visits`

### Frontend tickets
- [ ] **[FE-M3-01]** Round Planner — Calendar view + header controls + stats bar (Screen 8). `labels: frontend, rounds`
- [ ] **[FE-M3-02]** Round Planner — Map view (Screen 9). `labels: frontend, rounds`
- [ ] **[FE-M3-03]** Round Planner — List view (Screen 10). `labels: frontend, rounds`
- [ ] **[FE-M3-04]** Round Detail filter (`?round=X`) + Prev/Current/Next nav (Screen 11). `labels: frontend, rounds`
- [ ] **[FE-M3-05]** Add Round wizard — CreateRoundModal 5 steps (Round Details · Assign Area · Add Properties · Assign Technician · Review & Save) (Design Update #4). `labels: frontend, rounds`
- [ ] **[FE-M3-06]** Round & Technician Assignment — Overview + Round Details (Replace / Remove / + Add) (Screen 30). `labels: frontend, rounds`
- [ ] **[FE-M3-07]** Multi-tech allocation wizard — Select → Allocate → Review (Screen 30). `labels: frontend, rounds`
- [ ] **[FE-M3-08]** Upcoming Property Recurrences modal + Round Planner alert banner (M14). `labels: frontend, rounds`
- [ ] **[FE-M3-09]** Add One-Off Job modal (M2). `labels: frontend, visits`

### Definition of Done
- Cron generates visits on cadence with each new occurrence **unassigned**; admin can create rounds, assign one or multiple technicians **per occurrence** manually, add properties to a round, and clear the "upcoming recurrences" queue. Verifies FR-ROUND-9/10 end-to-end.

---

## M4 — Today's Work · 🔴 Not Started
**Goal:** The office can monitor the live workday and intervene (reassign, push missed, close day).
**Depends on:** M3

### Backend tickets
- [ ] **[BE-M4-01]** Today's Work aggregate — per-round progress + KPI tiles (Screen 12). `labels: backend, todays-work`
- [ ] **[BE-M4-02]** Round Details panel data — per-property job status + issue flags (Screen 13). `labels: backend, todays-work`
- [ ] **[BE-M4-03]** Reassign Technician — move remaining jobs to another tech + note + notify flag (M15). `labels: backend, todays-work`
- [ ] **[BE-M4-04]** Push Missed Jobs — move unfinished visits to a chosen date. `labels: backend, todays-work`
- [ ] **[BE-M4-05]** Close Day — mark remaining scheduled visits + generate summary. `labels: backend, todays-work`

### Frontend tickets
- [ ] **[FE-M4-01]** Today's Work dashboard — KPI tiles + rounds table + technician workload cards (Screen 12). `labels: frontend, todays-work`
- [ ] **[FE-M4-02]** Round Details slide-out panel (Screen 13). `labels: frontend, todays-work`
- [ ] **[FE-M4-03]** Reassign Technician modal (M15). `labels: frontend, todays-work`
- [ ] **[FE-M4-04]** Push Missed Jobs + Close Day actions. `labels: frontend, todays-work`

### Definition of Done
- The workday view reflects live visit statuses; admin can reassign a round's remaining jobs, push missed jobs, and close the day. Covers FR-VISIT-3/4/5.

---

## M5 — Mobile Technician App · 🔴 Not Started
**Goal:** A technician can onboard, see today's jobs, and execute each visit (start / complete / skip / access-issue / cash / photos).
**Depends on:** M3 (visits exist). BE tickets (BE-M5-*) are Phase 1. **All FE tickets (FE-M5-*) are Phase 2** — the mobile app is a React Native native app (iOS + Android); DP-MOBILE resolved.

### Backend tickets
- [x] **[BE-M5-01]** Technician invite/onboarding — `TenantInvite` entity + `POST /invites` + `POST /invites/:token/accept` (tech-link idempotent; cross-tenant guards) (done 2026-07-21). `labels: backend, mobile`
- [ ] **[BE-M5-02]** "Today's jobs" endpoint — the logged-in technician's assigned `Visit`s for the day (Mobile Screen 5). `labels: backend, mobile`
- [ ] **[BE-M5-03]** Visit action endpoints — start / complete / skip / access-issue (Mobile Screen 8). `labels: backend, mobile`
- [ ] **[BE-M5-04]** Skip-reason enum migration (Not home / No access / Customer refused / Unsafe / Other) (schema item #7). `labels: backend, visits`
- [ ] **[BE-M5-05]** Record cash payment — `Payment.method=CASH` from mobile (Mobile CashSheet). `labels: backend, payments`
- [ ] **[BE-M5-06]** Photo upload (before/after) linked to a `Visit` (Mobile PhotoSheet). `labels: backend, mobile`
- [ ] **[BE-M5-07]** Notifications feed entity + endpoint (schedule / round / payment) (Mobile Screen 6; schema item #6). `labels: backend, mobile`

### Frontend tickets (mobile)
- [ ] **[FE-M5-01]** Mobile auth — Login + invite code + Complete Profile + Reset (Mobile Screens 1–4). `labels: frontend, mobile`
- [ ] **[FE-M5-02]** Today / Job List (Mobile Screen 5). `labels: frontend, mobile`
- [ ] **[FE-M5-03]** Property Details — access/risk notes, service details, Start visit (Mobile Screen 7). `labels: frontend, mobile`
- [ ] **[FE-M5-04]** Active Visit + action bar (Record cash / Skip / Report access / Mark complete) (Mobile Screen 8). `labels: frontend, mobile`
- [ ] **[FE-M5-05]** Bottom sheets — Skip / Access Issue / Cash / Complete Confirm / Photo / Note. `labels: frontend, mobile`
- [ ] **[FE-M5-06]** Notifications screen (Mobile Screen 6). `labels: frontend, mobile`

### Definition of Done
- A technician onboards via invite, sees today's assigned jobs, and completes a visit end-to-end (photos, cash, skip-with-reason) — with status reflected on the admin Today's Work. Covers FR-MOBILE-1..9.

---

## M6 — Payments & Debt Board · 🔴 Not Started
**Goal:** Payments trigger after completion, invoices generate/send, and overdue balances are triaged on the debt board.
**Depends on:** M4/M5 (completed visits), M2 (payment methods)

### Backend tickets
- [ ] **[BE-M6-01]** Post-completion payment trigger — create `Payment` when a `Visit` completes (FR-INVOICE-2). `labels: backend, payments`
- [ ] **[BE-M6-02]** GoCardless integration — mandate check + collect (primary path) (FR-INVOICE-3). `labels: backend, payments`
- [ ] **[BE-M6-03]** Stripe integration — payment links (card fallback) + webhook (FR-INVOICE-3). `labels: backend, payments`
- [ ] **[BE-M6-04]** Invoice — generate / preview / send (M4/M5/M10). `labels: backend, invoicing`
- [ ] **[BE-M6-05]** Debt Board buckets — derive from `Payment` status + invoice dates; Bad Debt flag (Screen 16). `labels: backend, debt`
- [ ] **[BE-M6-06]** Send Payment Reminder (M3) + Send Payment Link (M8) endpoints. `labels: backend, debt`

### Frontend tickets
- [ ] **[FE-M6-01]** Debt / Payment Risk Board — KPIs + category tabs + cards (Screen 16). `labels: frontend, debt`
- [ ] **[FE-M6-02]** Debt card selected/expanded state + bulk select (Screen 17). `labels: frontend, debt`
- [ ] **[FE-M6-03]** Generate Invoice + Preview Invoice modals (M4/M5). `labels: frontend, invoicing`
- [ ] **[FE-M6-04]** Send Payment Reminder (M3) + Send Payment Link (M8) modals. `labels: frontend, debt`
- [ ] **[FE-M6-05]** Customer Detail — Payments tab (Screen 15). `labels: frontend, payments`

### Definition of Done
- A completed visit triggers a GoCardless collection (or Stripe link); invoices generate + send; the debt board buckets outstanding balances accurately. Covers FR-DEBT-1..4, FR-INVOICE-1..4.

---

## M7 — Complaints & Reporting · 🔴 Not Started
**Goal:** The office can log/manage complaints through resolution and view business-performance reports.
**Depends on:** M2 (customers/visits)

### Backend tickets
- [ ] **[BE-M7-01]** Complaint CRUD + workflow (Open → In Review → Revisit Booked → Resolved) (Screens 20–22). `labels: backend, complaints`
- [ ] **[BE-M7-02]** Complaint message thread + Schedule Revisit (creates a revisit `Visit`) (Screen 21). `labels: backend, complaints`
- [ ] **[BE-M7-03]** Reports aggregates — revenue, completed visits/rounds, technician KPIs, visit history (Screen 18). `labels: backend, reports`
- [ ] **[BE-M7-04]** System Activity Log — write + read (Screen 18). `labels: backend, reports`

### Frontend tickets
- [ ] **[FE-M7-01]** Complaints queue + Log Complaint (Screens 20, 22). `labels: frontend, complaints`
- [ ] **[FE-M7-02]** Complaint Detail — master/detail, Messages/Details tabs, Schedule Revisit / Mark In Review / Resolve (Screen 21). `labels: frontend, complaints`
- [ ] **[FE-M7-03]** Reports & History — KPIs + Revenue chart + technician/visit tables + activity log (Screen 18). `labels: frontend, reports`
- [ ] **[FE-M7-04]** Technician Performance view-all (`/reports/technicians`) (Screen 19). `labels: frontend, reports`

### Definition of Done
- A complaint can be logged, moved through the workflow (incl. a scheduled revisit), and resolved; reports render revenue / technician / visit metrics. Covers FR-COMPLAINT-1..4, FR-REPORT-1..3.

---

## M8 — Messaging & GHL Integration · 🔴 Not Started
**Goal:** Customer/technician messaging (SMS/WhatsApp/Email) flows through GHL — incl. bulk and payment reminders.
**Depends on:** M2 (customers), M6 (debt reminders). ⚠️ **Blocked** on the GHL trigger-mechanism decision (DP-GHL).

### Backend tickets
- [ ] **[BE-M8-01]** GHL trigger-mechanism spike + decision (contact-field-sync-and-watch vs direct API). `labels: backend, ghl`
- [ ] **[BE-M8-02]** GHL contact sync — populate/maintain `ghlContactId` on Customer/Property. `labels: backend, ghl`
- [ ] **[BE-M8-03]** Send message (SMS/WhatsApp/Email) via GHL + record `Message` (Screen 27, M3). `labels: backend, messaging`
- [ ] **[BE-M8-04]** Bulk Message to a round (M1). `labels: backend, messaging`
- [ ] **[BE-M8-05]** Message Templates CRUD (SMS Templates). `labels: backend, messaging`
- [ ] **[BE-M8-06]** Wire Debt Board payment reminders/links to GHL send (M6). `labels: backend, messaging`

### Frontend tickets
- [ ] **[FE-M8-01]** Bulk Message Round modal (M1). `labels: frontend, messaging`
- [ ] **[FE-M8-02]** Send Message to Technician (Screen 27). `labels: frontend, messaging`
- [ ] **[FE-M8-03]** SMS Templates settings editor. `labels: frontend, settings`

### Definition of Done
- A message (single + bulk) sends via GHL and is recorded; payment reminders dispatch from the debt board; templates are manageable. Covers FR-TECH-4, FR-DEBT-3, and the messaging half of FR-SETTINGS.

---

## M9 — Settings & Polish · 🔴 Not Started
**Goal:** All settings sections are editable, one full cycle runs end-to-end, and the app is production-hardened.
**Depends on:** M1–M8

### Backend tickets
- [ ] **[BE-M9-01]** Settings read/update per section — Business Profile, Round Settings, Service Catalogue, Service Areas, Payment Setup (Screen 23/24). `labels: backend, settings`
- [ ] **[BE-M9-02]** Technician CRUD (Add/Edit/Delete) + availability status (Active/Unavailable) (Screens 25/28/29; Design Update #2; schema item #4). `labels: backend, technicians`
- [x] **[BE-M9-03]** Auth hardening — `audience`/`issuer` checks (done 2026-07-16); app role resolved from `Profile` via `requireTenantAccess` (done 2026-07-21). `labels: backend, auth`
- [ ] **[BE-M9-04]** Production hardening — ~~CORS lockdown~~ ✅ (2026-07-21); structured logging + health/readiness still pending. `labels: backend, infra`
- [x] **[BE-M9-05]** ~~Commit `handle_new_user` trigger~~ — trigger dropped (2026-07-21); `POST /auth/signup` is the provisioning path. `labels: backend, infra`
- [ ] **[BE-M9-06]** End-to-end cycle test — property → visit → completion → payment (Phase 1 success criterion). `labels: backend, infra`

### Frontend tickets
- [ ] **[FE-M9-01]** Settings shell + Business Profile section (Screen 23). `labels: frontend, settings`
- [ ] **[FE-M9-02]** Settings — Service Catalogue (Screen 24). `labels: frontend, settings`
- [ ] **[FE-M9-03]** Settings — Round Settings / Service Areas / Payment Setup sections (Screen 23). `labels: frontend, settings`
- [ ] **[FE-M9-04]** Technicians list + detail + Add/Edit + delete confirm (Screens 25/26/28/29, M13). `labels: frontend, technicians`
- [ ] **[FE-M9-05]** Dashboard — KPIs, charts, Today's Rounds table, alert cards (Screen 7; GPS map is a placeholder). `labels: frontend, dashboard`

### Definition of Done
- All settings sections editable via the UI; **one full round cycle runs end-to-end without manual workarounds** (the Phase 1 success criterion); production hardening (CORS, logging, auth checks, trigger migration) applied.

---

## Schema-Per-Tenant Foundation — ✅ Done (2026-07-21)
> Architectural prerequisite for multi-tenancy, resolved before M1 frontend starts so the backend is production-correct from day one.

- [x] Public schema split: `Tenant`, `Profile` (with `tenantId`), `TenantInvite` only — all operational models moved to per-tenant schemas.
- [x] Tenant schema (`prisma/tenant/schema.prisma`) — all operational models; generated to `src/generated/tenant-client`.
- [x] `POST /auth/signup` — provisions a fresh Postgres schema (`t_<20-hex>`) + Tenant row + ADMIN Profile on first signup; idempotent. Re-provisions on every call path (new / idempotent / P2002 race).
- [x] `docs/sql/drop_handle_new_user.sql` — drops the old trigger; must be run in Supabase SQL Editor before first live signup.
- [x] Cross-schema FK relations removed from Prisma; `Technician.name` and `PropertyNote.authorProfileId` are plain string fields.
- [x] tsc clean — all service/route files updated to import from `generated/tenant-client`; `BusinessSettings` singleton pattern replaced with `findFirst()`.
- [x] `src/lib/tenant-prisma-manager.ts` — per-schema PrismaClient factory with LRU cache (max 100); replaces deleted `tenant-prisma.ts` singleton.
- [x] `src/lib/tenant-provisioning.ts` — atomic schema provisioning (BEGIN/COMMIT); DROP only on empty schema; refuses to DROP if tables exist without `BusinessSettings`.
- [x] `src/middleware/requireTenantAccess.ts` — resolves `Profile` + `Tenant.schemaName` per request; attaches `req.profile` and `req.tenantPrisma`.
- [x] `POST /invites` + `GET /invites/:token` + `POST /invites/:token/accept` — full invite flow with tech-link idempotency, cross-tenant guards, and email rollback.
- [x] Services converted to constructor injection (`createXxxService(prisma)` factories); all `BusinessSettings` writes use `upsert`.
- [x] `BusinessSettings.uniqueId @unique @default("singleton")` — migration `20260721000002_business_settings_unique_id`; prevents concurrent create races.
- [x] CORS locked to `FRONTEND_URL`; `FRONTEND_URL` + `INVITE_BASE_URL` validated at startup with `process.exit(1)`.
- [x] Customer list pagination (`page`/`pageSize`) + payments tab capped at 50 rows.
- [x] HTML escaping + `encodeURI` in invite emails.

---

## Deferred to Phase 2
- GHL **Marketplace listing** + OAuth install flow + self-serve onboarding.
- **Row-level security (RLS)** — Phase 1 uses schema-per-tenant isolation instead (see foundation above).
- Route optimisation / GPS tracking (Phase 3 per the brief; Dashboard GPS map is a placeholder only).
- Advanced analytics / BI.
- Customer-facing portal.
- First-class **`RoundOccurrence`** model (Phase 1 derives occurrences from Visits — see SDS §3.4).
- **Mobile Technician App FE** — React Native native app (iOS + Android); all `FE-M5-*` tickets. Phase 1 delivers the BE endpoints (`BE-M5-*`) only. (DP-MOBILE resolved.)

---

## Open Questions Blocking Milestones
From `PROGRESS.md` Decisions Pending + `designFindings.md` OQ#13 / MOB-1/2/3.

| Open question | Blocks / affects |
|---------------|------------------|
| **GHL automation trigger mechanism** (contact-field-sync vs direct API) — DP-GHL | **M8** (BE-M8-01+); payment automation in **M6** |
| **Notification provider** — DP-NOTIF: push notifications required (FR-MOBILE-9) but provider undecided (Firebase or equivalent); schema for notification entity undefined | **M5** (BE-M5-07, FE-M5-06) |
| **Skip-reason enum** (#7) — currently free `String` | **M5** (BE-M5-04) |
| **Per-round assignment history** (#9) | **M3/M4** (Screen 30 "Recent Activity") |
| ~~**Mobile completion delivery** (native vs mobile web) — DP-MOBILE~~ | ✅ **Resolved 2026-07-16** — React Native native app (iOS + Android); FE-M5-* deferred to Phase 2 |
| ~~**App roles in JWT** (DP-ROLES) — Supabase claim vs `Profile` role~~ | ✅ **Resolved 2026-07-21** — `req.user.role` removed; app role resolved from `Profile.role` via `requireTenantAccess` on every request; FR-AUTH-8 added |
| ~~**Technician invite entity** (#5)~~ | ✅ **Resolved 2026-07-21** — `TenantInvite` model + full invite/accept flow live (BE-M5-01 done) |
| ~~**Technician availability model** (#4) + self-mark "unavailable" (OQ#13)~~ | ✅ **Resolved 2026-07-16** — technician self-marks Unavailable from mobile (Phase 2); admin views + reassigns from web admin (Phase 1 — BE-M9-02) |
| ~~**Notifications feed entity** (#6) + push-vs-in-app (MOB-3)~~ | Partially resolved — push + in-app + email notification types confirmed; provider open → DP-NOTIF above |
| ~~**Mobile app scope / "B2C" naming** (MOB-1)~~ | ✅ **Resolved** — mobile app is technician-facing only; "B2C" label in design file is a mistake |
| ~~**`handle_new_user` trigger provenance** — DP-TRIGGER~~ | ✅ **Resolved 2026-07-21** — trigger dropped; `POST /auth/signup` is the provisioning path |
| ~~**Auth hardening** (`audience`/`issuer`) — DP-AUTHHARD~~ | ✅ **Resolved** — `requireAuth` validates issuer + audience (commit c816192) |

---

*Source documents: `PROGRESS.md`, `docs/designFindings.md`, `docs/SRS.md`, `docs/SDS.md`, `docs/RoundFlow_Context_and_Roadmap_v1.md`, `prisma/schema.prisma`. Screen/modal numbers refer to `designFindings.md`.*
