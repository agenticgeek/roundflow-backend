# RoundFlow — Project Context & Phased Roadmap (v1)

**Audience:** Claude Code (and any dev working on this repo)
**Purpose:** Replace prior planning docs as the active source of context. Establishes what this project is, what changed from earlier planning, and how Phase 1 is scoped.

---

## 1. What This Project Is

RoundFlow is a **field service management (FSM) platform**, built initially for a single UK-based window cleaning business, with an eventual goal of listing on the **GoHighLevel (GHL) Marketplace** as an installable app.

It is an **internal competitive build**, designed to match the flow and feature set of **FieldTask** — an existing FSM SaaS product also distributed via the GHL Marketplace — alongside reference points like Jobber and ServiceTitan. FieldTask is a competitive reference only, not a spec to copy verbatim.

The **source of truth for screens, flows, and UX** is `designFindings.md` — a wireframe audit of the "RoundFlow" Figma file (~30 screens, 14 sections, modals, dropdowns). That document supersedes any screen list, flow, or screen count in older planning material.

---

## 2. What Changed From the Original Brief

An earlier document (`FieldService_DevBrief_v1_2`) scoped this as a **GHL-native build**: GHL Custom Objects as the database, GHL Workflows as the automation/business-logic engine, and a React app embedded as an iframe inside GHL's sidebar via Custom Pages.

**That architecture is retired.** It does not allow the product to function as a standalone web-based SaaS, which is now the Phase 1 requirement. Specifically, no longer in scope for Phase 1:

- GHL Custom Objects as the data layer
- GHL Workflows as the business-logic/automation engine
- GHL Custom Pages / iframe embedding as the delivery mechanism
- GHL OAuth as the primary auth model

**What's kept from the old brief, reframed:**

- The general *category* of integrations needed (messaging, payments) — but now consumed as external services, not as the platform foundation.
- General tech stack instincts (Node/Express, Postgres/Prisma, React, cron-based scheduling) — still reasonable defaults for a standalone SaaS, not because the old brief said so, but because they remain sound choices.
- Nothing from the old brief's **data model (Section 3)** carries over as-is. The schema is being **redesigned from scratch**, based on what the RoundFlow wireframes actually require — not retrofitted from the GHL Custom Object structure.

The old brief should be treated as **background context only** — useful for understanding the problem domain (recurring round-based scheduling, GoCardless-first payments, UK window cleaning operational patterns) — but **not a build spec**. Do not pull schema fields, workflow names, or screen counts from it.

---

## 3. New Architecture Direction

**RoundFlow Phase 1 is a standalone web-based SaaS:**

- Own backend (Node/Express or similar) and own database (Postgres) as the system of record for all operational data — Properties, Customers, Service Plans, Rounds, Visits, Issues, Technicians, Payments, etc.
- Own React frontend, served as a normal web app — not embedded in GHL's sidebar, not constrained to an ~880px iframe width.
- Own auth — not dependent on GHL OAuth/SSO for Phase 1 users.

**GHL is used as a utility, not as the platform**, specifically to avoid building expensive infrastructure from scratch:

- **Messaging** (SMS / WhatsApp / Email) — GHL's Conversations + Workflow templating already solves this well; rebuilding it in-house is wasted effort for an MVP.
- **Payments** — Stripe and GoCardless flows, where GHL automations can reduce the integration surface versus wiring both SDKs directly.

The exact mechanism for *how* the backend triggers GHL automations (e.g. writing to a synced GHL Contact's custom fields and letting a GHL Workflow watch for the change, vs. calling the GHL API directly to fire a specific action) is **not yet decided** and should be treated as an open design question to resolve early in Phase 1 — likely during backend/integration design, before visit-generation and payment logic are built against it. Whatever is chosen, every Customer/Property record in the Postgres schema should carry a `ghl_contact_id` (or equivalent) from day one, since that's the join point that makes GHL-triggered messaging/payments possible regardless of which mechanism is picked.

**Important boundary:** using GHL automations as a utility is separate from the **GHL Marketplace listing**. The Marketplace listing (Phase 2+) is about RoundFlow becoming an installable app inside *other* GHL accounts — true multi-tenancy, OAuth install flow, per-install data isolation. Phase 1 just uses one GHL account (the client's) as a messaging/payments utility; it is not yet a multi-tenant marketplace app.

---

## 4. Schema Approach

- Build the Postgres/Prisma schema **from the RoundFlow wireframes**, not from the old brief's Section 3 GHL Custom Object model.
- Derive entities and fields by reading what each screen in `designFindings.md` actually displays and edits — e.g. the Customer Detail screen's six tabs (Overview, Service Plan, Visit History, Payments, Notes & Risk, Photos) imply real relational structure; the Debt Board's bucket system implies payment-status fields; the Issue/Complaint severity levels (Low/Medium/High) imply an enum, etc.
- Where the wireframes are silent or ambiguous (see Open Questions in `designFindings.md`, e.g. #8 — "Assign Property Now?" decline behavior), flag rather than guess, and resolve before locking the schema.
- Lock the schema only once it's been cross-checked against the full screen set — this is a one-time-cost, get-it-right step before Visit generation, Round Planner, and mobile completion logic get built on top of it.

---

## 5. Core Operational Loop (Unchanged)

This remains the spine of the product, independent of the architecture pivot:

> Property → Service Plan → Visit Generation → Round Planner → Today's Work → Mobile Completion → Payments

Visit generation remains a backend cron job (`node-cron` or equivalent), not GHL-native — this was already correctly decided pre-pivot and still holds in the new architecture, since GHL Workflows are no longer the business-logic engine at all.

---

## 6. Phased Roadmap

### Phase 1 — Web SaaS MVP (current focus)
- Standalone backend + Postgres database, schema locked from RoundFlow wireframes
- Standalone React web frontend implementing the RoundFlow screen set (admin side: Dashboard, Round Planner, Today's Work, Customers & Properties, Debt/Payments, Reports, Complaints, Settings, Technicians)
- Core operational loop fully functional end to end for one client
- GHL used as a utility for messaging (SMS/WhatsApp/Email) and assisting payment flows (Stripe/GoCardless) — single GHL account, not multi-tenant
- Mobile technician completion flow (in whatever form is decided — native app vs. mobile web is a separate decision not yet made)
- Success criteria: one full round cycle run end-to-end through the system without manual workarounds, payments triggering automatically post-completion, debt board accurate, reminders firing

### Phase 2 — GHL Marketplace Integration
- GHL OAuth install flow — true multi-tenancy, app installable into any GHL account
- Per-tenant data isolation in the schema (this is where `location_id`-tagging webhook payloads, if reintroduced, would matter — as marketplace infrastructure, not as Phase 1 plumbing)
- Public Marketplace listing
- Self-serve onboarding for new GHL accounts installing the app

### Phase 3 — Advanced Operations (deferred, per old brief's Out-of-Scope list, still reasonable)
- Route optimization / dispatch
- Live GPS tracking
- Weather API integration
- Advanced analytics / BI dashboards
- AI-assisted quote handling, risk scoring, crew performance scoring

---

## 7. Instructions for Claude Code

- Treat `designFindings.md` as the authoritative screen/flow spec for Phase 1.
- Treat `FieldService_DevBrief_v1_2` as background domain context only — never as a source for schema, screen counts, or architecture decisions.
- Do not build against GHL Custom Objects, GHL Workflows-as-business-logic, or GHL Custom Pages/iframes for Phase 1.
- Design the Postgres schema from scratch against the wireframes; flag unresolved wireframe ambiguities rather than assuming.
- Treat the GHL-automation trigger mechanism (contact-field-sync-and-watch vs. direct API call) as an open decision to design early, not something to silently pick.
- Keep Phase 2 (GHL Marketplace multi-tenancy) and Phase 3 (advanced ops) out of Phase 1 build scope — reference them only to avoid making schema/architecture choices that would block them later.
