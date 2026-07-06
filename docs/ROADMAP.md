# RoundFlow Phase 1 — Roadmap

> Grounded in `PROGRESS.md`, `docs/designFindings.md`,
> `docs/RoundFlow_Context_and_Roadmap_v1.md`, and `prisma/schema.prisma`.
> Milestone statuses reflect what the sources actually evidence; verification
> gaps are called out rather than assumed complete.
>
> **Status legend:** ✅ Complete · 🔄 In Progress · ⬜ Not started · ⚠️ caveat/unverified

---

## Product Vision
RoundFlow Phase 1 delivers a **standalone web + mobile FSM platform** for a single
UK window-cleaning business, replacing generic tools that don't fit the recurring,
round-based model. It runs the full operational loop end-to-end for one client —
properties and service plans, auto-generated visits organised into rounds,
live workday execution on a technician mobile app, and payments (GoCardless-first)
with a debt board — using **Supabase** for data + auth and **GHL** as a messaging/
payments utility. Getting the schema, auth, and service architecture right in
Phase 1 **unlocks Phase 2**: the same product becomes a multi-tenant, GHL
Marketplace-installable app (the `profileId` service seam and `ghlContactId` join
point are already in place for that).

---

## Operational Loop
Every milestone delivers a working slice of the product spine:

> **Property → Service Plan → Visit Generation → Round Planner → Today's Work → Mobile Completion → Payments**

Visit generation is a **backend cron** (not GHL-native). The loop is the success
criterion: one full round cycle run end-to-end without manual workarounds,
payments triggering automatically post-completion, an accurate debt board, and
reminders firing.

---

## Milestones

### M0 — Foundation ✅ Complete (with verification caveats)
- ✅ Schema **locked and migrated** to Supabase (19 models + 16 enums; 3 migrations:
  `init`, `remove-round-technician-id`, `add_setup_completed`).
- ✅ Backend auth built: **ES256 JWKS verification** (`requireAuth`),
  `handle_new_user` Profile trigger (in Supabase), `GET /auth/me`.
- ✅ Express server; **`tsc --noEmit` clean**; `npm audit` **0 vulnerabilities**;
  `/health` 200; no-token 401.
- ✅ Design source of truth established (`designFindings.md`) and re-audited
  (2026-07-07 admin update + mobile app).
- ✅ Architecture decisions documented (`PROGRESS.md`).
- ⚠️ **Unverified:** the full positive auth path (`/auth/me` with a **real** ES256
  token) and the `handle_new_user` trigger's actual `Profile` creation/`name`/`role`
  behaviour — both need a real Supabase-issued JWT (no anon key / test user
  available in the build env). Trigger SQL is **not version-controlled** yet.

### M1 — Setup Wizard 🔄 In Progress (backend built; verification + UI pending)
All 8 steps, **steps 2 + 5 stubbed/deferred** (Payment configured separately; SMS
via GHL):
- ✅ Backend `/setup/*` built: Business Profile, Service Catalogue, Round Settings,
  Technician Management (invite-pending), Service Areas, Assign Round (first ACTIVE
  round).
- ✅ **`SetupService`** behind `ISetupService` (the OCP seam; `profileId`-first),
  derived per-step completion, **completion guard** (`assertSetupIncomplete`;
  `completeSetup` → 409 already-complete / 400 missing steps), stateful progress
  (`setupCompleted` flag).
- ⚠️ **Remaining:** the authenticated `/setup/*` **HTTP path with a real token**
  isn't verified (route+auth and service logic verified separately); the frontend
  wizard UI (Screen 6) is a separate-repo deliverable.

### M2 — Customers & Properties ⬜
- Customer + Property creation via the **Add Property wizard** (Step 1 doubles as
  customer creation — M6).
- Customer **list** (Screen 14) + **detail** with six tabbed routes (Screen 15).
- **Property assignment to round** (Screen 31 — single + multi-technician choice;
  Save & Assign Later → unassigned).
- **Service Plan** creation (price, clean method, payment method, next-due).

### M3 — Visit Generation & Round Planner ⬜
- **Cron-based visit generation** from Service Plans + Round cadence (honour
  payment holds).
- **Round Planner** views: Calendar, Map, List (Screens 8–11).
- **Multi-technician job allocation** 3-step wizard (Select → Allocate → Review;
  manual division; per occurrence — Screen 30).
- **Upcoming recurrences + assignment** (alert banner → M14).

### M4 — Today's Work ⬜
- **Live round progress** (Screen 12).
- **Round Details panel** (Screen 13).
- **Reassign Technician** (M15).
- **Push Missed Jobs**.

### M5 — Mobile Technician App ⬜
- Auth: **invite code + Complete Profile** (Mobile Screens 1–4).
- **Today's job list** (Screen 5).
- **Visit execution**: Start, Complete, Skip (with reason), Access Issue, Cash
  payment (confirm), Photos (before/after) — Screens 7/8 + bottom sheets.
- **Notifications feed** (Screen 6).
- ⚠️ **Decision pending:** native app vs mobile web (blocks this milestone).

### M6 — Payments & Debt Board ⬜
- **Debt / Payment Risk Board** — all buckets (Screen 16/17).
- **Invoice** generation + send (M4/M5/M10).
- **GoCardless** integration (primary).
- **Stripe** integration (card fallback).
- **Send Payment Reminder** (M3) / **Send Payment Link** (M8).

### M7 — Complaints & Reporting ⬜
- **Complaints** workflow: Log, Review, Revisit, Resolve (Screens 20–22).
- **Reports & History**: revenue, technician KPIs, visit history, System Activity
  Log (Screens 18/19).

### M8 — Messaging & GHL Integration ⬜
- SMS/WhatsApp/Email **via GHL** automations.
- **Bulk Message** (M1) and **Add One-Off Job** flows (M2).
- **SMS Templates**.
- **Payment reminders** triggered from the Debt Board.
- ⚠️ Gated by the **GHL trigger mechanism** decision (contact-field-sync vs direct
  API).

### M9 — Settings & Polish ⬜
- All **Settings** screens: Business Profile, Payment Setup, Round Settings, SMS
  Templates, Technician Mgmt, Service Areas, Service Catalogue (Screen 23/24).
- **End-to-end cycle test** — one full round from property → completed visit →
  payment (the Phase 1 success criterion).
- Bug fixes, edge cases, performance; production hardening (CORS lockdown, auth
  `audience`/`issuer` checks, build/runtime, structured logging — from Known
  Placeholders).

---

## Deferred to Phase 2
- GHL **Marketplace listing** + OAuth install flow + self-serve onboarding.
- **Multi-tenancy** (per-tenant data isolation, **RLS**).
- Route optimisation / GPS tracking (Phase 3 per the brief; Dashboard GPS map is a
  placeholder only).
- Advanced analytics / BI.
- Customer-facing portal.

---

## Open Questions Blocking Milestones
From `PROGRESS.md` Decisions Pending + `designFindings.md` OQ#13 / MOB-1/2/3.

| Open question | Blocks / affects |
|---------------|------------------|
| **Mobile completion delivery** (native vs mobile web) | **M5** (whole mobile app) |
| **GHL automation trigger mechanism** (contact-field-sync vs direct API) | **M8** (messaging/GHL); payment automation in **M6** |
| **Skip-reason enum** (#7) — currently free `String` | **M5** (mobile Skip), **M4** |
| **Technician invite entity** (#5) — no invite-token model | **M5** (technician onboarding) |
| **Notifications feed entity** (#6) + push-vs-in-app (MOB-3) | **M5** (notifications) |
| **Technician availability model** (#4) + self-mark "unavailable" (OQ#13/MOB-2) | **M3/M4** (reassignment), **M5** |
| **Per-round assignment history** (#9) | **M3/M4** (Round & Technician Assignment history) |
| **App roles in JWT** (DP-ROLES) — Supabase claim vs `Profile` role | Role-based authorisation from **M2** onward |
| **`handle_new_user` trigger provenance** (commit SQL vs Supabase-managed) | **M0/M1** auth reliability |
| **Auth hardening** (`audience`/`issuer` checks) | **M9** production readiness |
| **Mobile app scope / "B2C" naming** (MOB-1) | **M5** scope |

---

*Source documents: `PROGRESS.md`, `docs/designFindings.md`, `docs/RoundFlow_Context_and_Roadmap_v1.md`, `prisma/schema.prisma`. Screen/modal numbers refer to `designFindings.md`.*
