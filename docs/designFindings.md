# Design Findings — Unofficial WC Wireframes ("Rough" Page)

> Inspected via figma-desktop MCP · Node 401:943 · 2026-06-30
> **Updated 2026-07-07** — admin file `RoundFlow-Admin` (Page 1, node `0:1`) re-audited for 5 design changes; new **Mobile App (RoundFlow Technician / B2C)** file audited. See the **Mobile App** and **Design Update Log** sections at the end. Note: screenshots could not be captured this pass (figma-desktop MCP served only the active tab); details below are extracted from frame metadata/text.

---

## Overview

**App name:** RoundFlow  
**Domain:** Window cleaning business management platform (B2B SaaS)  
**Page summary:** The "Rough" page contains the complete wireframe set for RoundFlow, organised into 14 labelled sections on the canvas. Sections prefixed with `/` are core app routes; others are flows (Add Property, Add Round), feature modules (Complaints, Login/signup, Technicians), or developer-reference clusters.

**Primary nav (left sidebar, all screens):**  
Dashboard · Round Planner · Today's Work · Customers · Debt/Payment · Reports/History · Complaints · Settings · Technicians

**Quick Actions (bottom of sidebar):**  
Add Round · Bulk Message · Add One-Off Job

**Total distinct screens (primary + detail/sub-views):** ~30 unique screen states  
**Total canvas frames (inc. variants, modal overlays, ref frames):** 120+  
**Sections:** 14

---

## Screens

### 1. Login *(re-audited 2026-07-08)*  
**Section:** `Login/signup` · Node `936:61788` (`login-screen`) · original Rough node `658:7746`  
**Purpose:** Authentication entry point for returning users.  
**Layout:** Split — dark left panel (brand marketing) + white right panel (form).  
**Elements:**
- Left: RoundFlow logo (new "R" mark), headline "Manage your rounds. Empower your team.", subtitle "Track jobs, technicians, payments and complaints — all in one place.", 3 feature bullets (Live GPS tracking, Automated scheduling, Instant payments), "© 2024 RoundFlow Ltd." footer
- Right: "Welcome back / Sign in to your RoundFlow account"; **Log in / Sign up** tab toggle; **Work email**; **Password**; **Remember me** checkbox; **Forgot password?** link; **Sign in** button; "or" divider; **Continue with Google** button; "Don't have an account? **Sign up**" link

**Interactions:** Tab toggle switches Login ⇄ Sign Up (Screen 2). **Forgot password?** → Screen 3. **Continue with Google** → Google OAuth (`supabase.auth.signInWithOAuth({ provider: 'google' })`). **Sign up** → Screen 2. Email/password → `supabase.auth.signInWithPassword`. See **Auth Flows** below.

---

### 2. Sign Up *(re-audited 2026-07-08)*  
**Section:** `Login/signup` · Node `936:61853` (`signup-screen`) · original Rough node `658:7808`  
**Purpose:** New user account registration.  
**Layout:** Same split layout as Login.  
**Elements (right panel):** "Get started free / Create your RoundFlow account"; Log in / Sign up tab toggle; **Full name**; **Work email**; **Company name**; **Password**; **Confirm Password**; "By signing up you agree to our **Terms** & **Privacy Policy**"; **Create account** button; "or" → **Continue with Google**; "Already have an account? **Log in**" link.  
**Metadata mapping:** **Full name → `raw_user_meta_data.full_name`**, **Company name → `raw_user_meta_data.company_name`** (passed on `supabase.auth.signUp`). The `handle_new_user` trigger reads `full_name` → `Profile.name` and `company_name` → `BusinessSettings.businessName` (see **Auth Flows** + `docs/sql/handle_new_user_v2.sql`).  
**Interactions:** **Create account** → Supabase sends a **magic-link confirmation email** → user clicks → into app. **Continue with Google** → Google OAuth. **Log in** → Screen 1.

---

### 3. Forgot Password *(re-audited 2026-07-08)*  
**Section:** `Login/signup` · Node `936:61929` (`forgot-password`) · original Rough node `681:8108`  
**Purpose:** Password reset request.  
**Elements:** **← Back to log in** link; "Forgot password? / Enter your work email and we'll send you a reset link."; **Work email** input; **Send reset link** button; "Didn't receive an email? Check your spam folder or **resend**" helper.  
**Flow note:** Submitting calls `supabase.auth.resetPasswordForEmail(email, { redirectTo: <app>/reset-password })` → Supabase sends a **magic link** (NOT an OTP code) → user clicks → Screen 5. **← Back to log in** → Screen 1.

---

### 4. OTP Verification — ⚠️ DEFERRED (not in the Phase 1 flow)  
**Section:** `Login/signup` · Node `936:61974` (`otp-verification`) · original Rough node `681:8150`  
**Status:** **Deferred — not built in Phase 1.** Both password reset and signup confirmation use a **magic link**, not a 6-digit OTP, so this screen is **skipped entirely**. Kept in the design for a potential future OTP flow.  
**Elements (reference only):** "← Back"; "Check your email / We sent a 6-digit code to {email}. Enter it below to continue."; 6-box OTP input; **"Code expires in mm:ss"** countdown; **Verify code** button; "Didn't receive a code? **Resend code**".

---

### 5. Reset Password *(re-audited 2026-07-08)*  
**Section:** `Login/signup` · Node `936:62030` (`reset-password`) · original Rough node `681:8203`  
**Purpose:** Set a new password after clicking the reset magic link.  
**Elements:** "← Back"; "Set new password / Your new password must be at least 8 characters and include a number." (**password rule**); **New password** with **show/hide eye toggle**; **password strength indicator** (Weak / Fair / Good / Strong); **Confirm password** with eye toggle; **Reset password** button; "You'll be redirected to log in after reset." note.  
**Flow:** User arrives via the **magic link** from Screen 3 (route `/reset-password`, recovery session active) → `supabase.auth.updateUser({ password })` → redirected to Login (Screen 1).

---

### Auth Flows *(NEW — 2026-07-08)*
Auth is handled by **Supabase Auth** (frontend + Supabase); this backend only **verifies** the ES256 JWT (`requireAuth`) and reads the Profile created by the `handle_new_user` trigger. It issues no tokens and exposes no login/signup endpoints.

**1. Sign Up (email/password)**
`signup-screen` → `supabase.auth.signUp({ email, password, options: { data: { full_name, company_name } } })` → Supabase sends a **magic-link confirmation email** → user clicks → session established → into the app. On the `auth.users` insert, the **`handle_new_user` trigger** creates the `Profile` (role `ADMIN`, `name` = `full_name`) and sets `BusinessSettings.businessName` = `company_name` **only if not already set** (see `docs/sql/handle_new_user_v2.sql`).

**2. Login (email/password)**
`login-screen` → `supabase.auth.signInWithPassword({ email, password })` → session → into the app.

**3. Password reset**
`forgot-password` → `supabase.auth.resetPasswordForEmail(email, { redirectTo: '<app>/reset-password' })` → Supabase sends a **reset magic link** → user clicks → lands on `/reset-password` (Screen 5) with a recovery session → `supabase.auth.updateUser({ password })` → redirected to Login. **The OTP screen (4) is skipped.**

**4. Google OAuth**
"Continue with Google" (login/signup) → `supabase.auth.signInWithOAuth({ provider: 'google' })` → Supabase handles the Google redirect → returns to the frontend **`/auth/callback`** route → `supabase.auth.exchangeCodeForSession()` → session → into the app. First-time OAuth users also hit `handle_new_user` (Profile created; `company_name` absent → `businessName` untouched).

**Backend involvement:** none are backend HTTP endpoints. The backend only (a) verifies the Bearer JWT per request (`requireAuth`), and (b) relies on the `handle_new_user` Postgres trigger for Profile / BusinessSettings seeding. **`/auth/callback` is a frontend route.**

---

### 6. Setup Wizard (Onboarding) *(re-audited 2026-07-08 — now 12 steps)*  
**Section:** `/Setup` · section node `936:44567` · **34 frames** (29 "Setup" + Edit Changes + Edit/Add Service modals) · original primary `401:19250`  
**Purpose:** First-run multi-step wizard to configure the business before using the app.  
**Layout:** Full-screen (no sidebar nav), horizontal step indicator at top.

> ⚠️ **Design inconsistency (mid-refactor):** the file contains **two coexisting cuts** — an older **7-step** version (some frames still footer "Step X of 7") and a newer **12-step** version (header stepper runs to "12 Review & Launch"). Minor label bleed is also present (e.g. an "Add Area" button opening a service modal, a stray "Mobile Number *" in unrelated forms). **We build against the 12-step cut.** A confirmed canonical step list from the designer is still pending.

**Steps (12-step cut — authoritative):**

| # | Step | Content | Frame(s) | Backend |
|---|------|---------|----------|---------|
| 1 | **Business Profile** | Business Name\*, Phone\*, Email\*, Service Area (opt), Company Number (opt), VAT Registration (opt) | `936:44568` / `44681` / `44815` | ✅ `POST /setup/step/1` |
| 2 | **Payment Setup** | GoCardless + Stripe *Connect* (stub); **Default Payment Rule**; **VAT Applicable** toggle; **Debt Hold Enabled** toggle | `936:44953` | ✅ **real** `POST /setup/step/2` — persists `paymentRule`, `debtHoldEnabled`, `vatInInvoices`, `gocardlessConnected`, `stripeConnected` (connect = stub) |
| 3 | **Service Catalogue** | Add/search/filter services (All · Window Cleaning · Exterior Cleaning · Gutter & Fascia · Specialist), Active/Inactive, Edit/Add Service modals | `936:48147` / `48399` / `48714` / `49050` | ✅ `POST /setup/step/3` (full replace) |
| 4 | **Round Settings** | Default Recurring Cycle (Week/2/3/4-week), **Default Clean Methods** (Traditional/Water-fed Pole), **Auto-Generate Visits** toggle | `936:45071` / `45157` / `45264` | ⚠️ partial — `POST /setup/step/4` covers cycle + working days; clean-method + auto-gen not yet persisted (P1-nice) |
| 5 | **SMS/WhatsApp Templates** | Templates list (Pre-Clean Reminder, Payment Reminder, Payment Failed, Access Issue Follow-up, Job Completed, Weather Delay), `{{merge}}` vars | `936:45371` | 🟡 deferred stub (GHL owns messaging — Settings Decision 4) |
| 6 | **Technician Management** | Add New Technician: **Full Name\***, **Mobile Number\***, Role, Default Area; table Phone/Role/Round/App Status | `936:45492` / `45575` / `45675` / `45778` | ✅ `POST /setup/step/6` (**now accepts `name`**) |
| 7 | **Service Area** | Add New Area: name, postcode sector, default; area cards | `936:45881` | ✅ `POST /setup/step/7` (full replace) |
| 8 | **Assign Round** (Area→Round) | Round Name, Service Area Name, Post Code Sector, Round Day of Week, Add Round; Linked Rounds | `936:45976` / `46053` / `46155` | ✅ `POST /setup/step/8` (basic first round) |
| 9 | **Add Property** | Multi-substep: Property Details (Customer/Property, address) · Service Plan (frequency, price, VAT, payment method) · Scheduling (Start Date, Preferred Day) · Risk & Notes · Assign Property to Round | `936:46253` / `46371` · `46514` · `46601` · `46673` · `46743` / `46813` | 🔴 **designed but deferred to milestone M2 — backend endpoint does not yet exist** |
| 10 | **Assign Technicians to Rounds** | Total Rounds / Technicians / Unassigned; Round Assignments table (Round / Area / Properties / Assigned Technician) — multi-tech | `936:47259` / `47453` / `47665` · `47853` (Edit Changes) | 🔴 **designed but deferred to milestone M3 — backend endpoint does not yet exist** |
| 11 | **Activate System & Generate Visits** | Generate Visits (All Rounds / Selected Rounds), First Cycle Start Date, Frequency/Cycle → *Generate Visits & Activate* | `936:47044` / `47141` | 🔴 **designed but deferred to milestone M4 — backend endpoint does not yet exist** |
| 12 | **Review & Launch** | Setup Progress checklist (Business profile · GoCardless connected · Stripe configured · SMS templates · Technicians · Service areas · Round settings), Ready to Launch, What happens next | `936:46888` | ✅ `POST /setup/complete` |

**Navigation:** Back / Continue; footer step counter (inconsistent — see warning above). **Steps 9–11 are designed but deferred to milestones M2 / M3 / M4 respectively; their backend endpoints do not yet exist.** Setup completion (`/setup/complete`) gates on the built steps only.

**Superseded:** the earlier **8-step** description (Business Profile · Payment Setup · Service Catalogue · Round Settings · SMS · Technicians · Service Area · Assign Round, "Step N of 8") reflected the older cut and is **no longer authoritative**.

#### Step-by-step Detail: Steps 9–12 *(deep audit 2026-07-21)*

**Step 9 — Add Property** · nodes `936:46253` / `46371` (sub-step 01, dropdown closed/open) · `46514` (sub-step 02) · `46601` · `46673` (sub-step 04) · `46743` / `46813` (sub-step 05)

Layout: horizontal top stepper (steps 1–12) + vertical left sub-stepper (01–05) + main content area. Header: "Add Property" / "Add properties to link with the rounds". Top-right: **Add Property** button (to add more than one during setup).

| Sub-step | Label | Fields |
|----------|-------|--------|
| 01 | Property Details | **Customer/Property:** Customer Name\*, Property Name (optional; defaults to customer name), Phone Number\*, Email (optional). **Address:** Full Address\*, Postcode\*, Service Area (dropdown, req), Property Type (dropdown: **House · Flat/Apartment · Commercial · Office · Conservatory**) |
| 02 | Service Plan | Cleaning Frequency (dropdown), Price per visit (£), VAT applicable (toggle/dropdown), Payment Method (GoCardless / Stripe / Cash) |
| 03 | Scheduling | Start Date (date picker), Preferred Day (dropdown) |
| 04 | Risk & Notes | Customer Notes (free text), Risk Notes (e.g. "Dog behind fence"), Access Notes (e.g. "Key under mat, side gate access") |
| 05 | Assign Property to Round | Select Round (dropdown), Select Service Area (sub-area within round, for "precise allotment") |

Footer: **Back** | "Step 6 of 7" (legacy label — ignore) | **Continue**.

**Backend:** `POST /setup/step/9` — one-time setup only, does NOT reuse `POST /customers` or `POST /properties`. Creates a `Customer` + `Property` + `ServicePlan` record atomically. Multiple properties can be added in sequence during setup (re-entering sub-step 01). Request body: `{ customerName, propertyName?, phone, email?, fullAddress, postcode, serviceAreaId, propertyType, cleaningFrequency, pricePerVisit, vatApplicable, paymentMethod, startDate, preferredDay, customerNotes?, riskNotes?, accessNotes?, roundId }`.

> ⚠️ **Schema note:** `PropertyType` enum needs: `HOUSE | FLAT_APARTMENT | COMMERCIAL | OFFICE | CONSERVATORY` — not yet in `schema.prisma`.

---

**Step 10 — Assign Technicians to Rounds** · node `936:47259` (main) · `47453` / `47665` (variants) · `47853` (Edit Changes state)

Layout: stat cards row + "Round Assignments" table + "Technician Workload" panel.

**Stat cards (3):**
- **Total Rounds** — integer count of all configured rounds
- **Technicians** — integer count of all technicians added in step 6
- **Unassigned** — rounds with no technician assigned yet (amber/warning styling, `#fffbeb` bg, `#fee685` border, value in `#bb4d00`)

**Round Assignments table** columns: `Round` (name + day-of-week sub-label) · `Area` (pin icon + area name) · `Properties` (count) · `Assigned Technician` (inline dropdown selector) · `Status` (badge) · `Action` (Edit link)

**Technician selector states per row:**
- Assigned: teal background (`rgba(2,155,182,0.1)`), technician name + chevron, Status = "Assigned" (green `#dcfce7` / `#008236`)
- Unassigned: dashed amber border (`#ffd230`), "— Unassigned —" text in `#e17100`, Status = "Missing" (amber `#fef3c6` / `#bb4d00`)

**Technician Workload panel** (below table): per-technician row with avatar initials circle (teal bg), name, horizontal progress bar (teal fill), "N rounds" label. Workload is derived from how many rounds are assigned to each tech.

**Backend:** `POST /setup/step/10` — accepts `assignments: [{ roundId: string, technicianIds: string[] }]`. Idempotent — re-submitting replaces all assignments for each listed round. Does NOT reuse any existing round-update endpoint.

> ⚠️ **Schema gap — multi-technician rounds:** The current schema has `Technician.roundId` (single FK — a technician belongs to one round). The design and user requirement ("one round can have multiple technicians") require a **many-to-many join table**: `RoundTechnician { roundId String, technicianId String, @@id([roundId, technicianId]) }`. This schema migration is needed before step 10 can be built. `Technician.roundId` can be kept for now as a "primary round" or retired once the join table is in place.

---

**Step 11 — Activate System & Generate Visits** · node `936:47044` (main) · `47141` (variant)

Layout: single-page form. Header: "Activate System & Generate Visits" / "Create first cycle of visits from your configured rounds".

**Section 1 — Generate Visits:**
| Option | Default | Description |
|--------|---------|-------------|
| All Rounds (recommended) | **ON** (teal toggle) | Generate visits for every configured round |
| Selected Rounds Only | OFF (grey toggle) | Generate for a subset — user selects which rounds |

**Section 2 — Start Date & Cycle:**
- **First Cycle Start Date** — date picker (example: "20 May 2025")
- **Frequency/Cycle** — dropdown (example: "4-week cycle"; options: 1-week, 2-week, 3-week, 4-week)

**CTA:** "Ready to Activate?" heading + sub-text "This will generate first set of visits and make them available for your team" + **Generate Visits & Activate System** button (teal with play icon, box-shadow glow).

**Backend:** `POST /setup/step/11` — one-time activation endpoint. Body: `{ generateAll: boolean, startDate: string (ISO date), cycleWeeks: 1 | 2 | 3 | 4, roundIds?: string[] }`. Creates `Visit` records for every `Property` in each selected (or all) `Round` for the first cycle, using the service plan's frequency. Marks the tenant's setup phase as activated. Does NOT reuse any existing visit-generation logic.

> **Note:** if `generateAll = true`, `roundIds` is ignored. If `generateAll = false`, `roundIds` is required and must be non-empty.

---

**Step 12 — Review & Launch** · node `936:46888`

Layout: centered content (no left stepper). Green check-circle icon at top centre.

**Setup Progress section:**
- Label "Setup Progress" + "7 of 7 completed" counter
- Full-width green progress bar (100% fill)

**Completed checklist** (all with green ✅ icons):
1. Business profile completed
2. GoCardless connected
3. Stripe configured
4. SMS templates created
5. Technicians added
6. Service areas created
7. Round settings saved

> Note: the checklist shows 7 items matching the **original 7-step cut** — the design has not yet been updated to reflect the full 12-step list. Build backend to check the 12-step items we control (steps 1–4, 6–11; skip 5 as deferred stub).

**"Ready to Launch" info box** (teal bg `#f0fdfb`, teal border `#99e0da`): "Ready to Launch" heading + "All required steps are complete. You can now launch your system and start managing your window cleaning business."

**"What happens next?" info box** (teal bg, blue border `#bedbff`): bulleted list:
- You'll be taken to your main dashboard
- You can start adding customer properties and creating rounds
- Access Settings anytime to update your configuration
- Your technicians will receive app invitations if configured

**Footer:** Back | "Step 6 of 7" (legacy label) | **Continue** (acts as the final **Launch** action).

**Backend:** `POST /setup/complete` — **already exists**. Marks setup as complete, sets `isSetupComplete = true` on `BusinessSettings`. The frontend's "Continue" on step 12 calls this. Extend to return a checklist summary of which steps are complete vs pending so the UI can render the progress bar accurately.

---

### 7. Dashboard  
**Section:** `/ Dashboard` · Node `401:8121`  
**Purpose:** Live business command centre — real-time snapshot of the day's rounds, financials, complaints, and GPS positions.  
**Elements:**
- **Top KPI row:** Jobs Scheduled, Open Complaints (flagged red), Clean Unpaid (amount + count), Monthly Revenue
- **Alert cards (expandable):** "N needs review / upsells", "N requires payment follow-up", "N due today / this week"
- **Live GPS Tracking map:** Embedded `GPSMap` component (node `740:9884`) — world-map placeholder with technician pins, technician list (name, status, location, last seen timestamp). Not a full-screen route.
- **Technician KPIs table (per technician):** Value Completed, Time on Job, Revenue/Hour, Complaints, Strikes, Damages, Upsells; Monthly/Yearly toggle
- **Three charts:** Value of Work Completed (bar), Revenue Per Hour (line), Issues Over Time (bar, colour-coded)
- **Today's Rounds table:** Round name, Technician, Stops, Done, Skip, Issues, Value, Status badge

**Interactions:** Alert cards expand/collapse. Technician tab toggle in KPI section. View All on Today's Rounds → Round Planner. Quick Actions trigger modals (Bulk Message, Add One-Off Job). Add Round → Add Round flow.

---

### 8. Round Planner — Calendar View  
**Section:** `/Round-Plan` · Node `401:945`  
**Purpose:** Plan and view all cleaning rounds on a monthly calendar; primary scheduling screen.  
**Elements:**
- Area selector dropdown (e.g. "Alnwick")
- View toggle: Calendar / Map / List
- Search bar (property, customer, postcode)
- Technician filter dropdown, Status filter dropdown
- + Add Round button
- Stats bar: Total Stops, Round Value, Estimated Duration, Completion %, Payment Holds (amber), Issues (red with badge)
- Weekly calendar grid (Mon–Fri columns, week rows for the cycle period)
- Round cards on calendar: round name, status dot (green=Completed, blue=In-progress), stops count, value, technician name + status
- **⟳ Update (2026-07-07):** a round can now carry **multiple technicians** (job division is manual — see Screen 30). A round is now assigned **per occurrence** (per recurrence), not once-and-fixed. When a technician becomes unavailable or a recurrence comes due without an assignee, an **alert banner** appears above the stats bar — *"N properties have upcoming recurrences requiring technician assignment"* with a **Review Now** button → *Upcoming Property Recurrences* modal (M14).

**Interactions:** Round card click → same Calendar View with `?round=X` query param applied (see Screen 11). Technician dropdown → multi-select filter (see Dropdowns). Area dropdown filters calendar.

---

### 9. Round Planner — Map View  
**Section:** `/Round-Plan` · Node `401:1231`  
**Purpose:** Visualise stop locations on a map for route planning.  
**Elements:** Same header controls as Calendar View. Full-bleed map with property pins.

---

### 10. Round Planner — List View  
**Section:** `/Round-Plan` · Node `401:1467`  
**Purpose:** Tabular view of all stops in the selected round.  
**Elements:** Same header. Table with property name, address, customer, price, status, technician columns.

---

### 11. Round Planner — Round Detail (Alnwick Tuesday)  
**Section:** `/Round-Plan` · Node `665:9086`  
**Purpose:** Calendar View filtered to a specific round via `/round-planner?round=X` — same route as Screen 8, not a separate route.  
**Elements:** Round name in breadcrumb/tab area (e.g. "Alnwick Monday ∨"), Previous / Current / Next navigation, same calendar grid filtered to this round.

---

### 12. Today's Work  
**Section:** `/Today-s-Work` · Node `401:10172`  
**Purpose:** Live operations monitor for the active workday. Shows real-time progress of all rounds in-flight.  
**Elements:**
- Live badge + timestamp, Close Day button (red, prominent)
- KPI tiles: Scheduled Stops, In Progress (blue), Completed (green), Skipped (amber), Issues (red), Payment Holds (red), Value Completed
- Search bar, "Show only problems" filter toggle
- Rounds table: Status dot, Round name, Technician avatar+name, Progress bar (X/Y), Completed count, Skipped count, Issues count, Payment Holds, Value, ETA, Actions (⋮ menu)
- **Technician Workload cards:** Avatar, name, completed/remaining, round name, issue count, on-track/behind indicator

**Interactions:** Round row click → Round Details slide-out panel. Show only problems filters table.

---

### 13. Today's Work — Round Details Panel  
**Section:** `/Today-s-Work` · Node `401:10634`  
**Purpose:** Right-side drawer showing per-property job status for a selected round.  
**Layout:** Slide-in panel overlaid on Today's Work list (main content visible behind).  
**Elements:**
- Round name + technician name + status badge (In Progress), X to close
- Progress bar with fraction (2/5 completed)
- Mini stat tiles: Completed (green), Skipped (amber), Issues (red)
- Quick Actions: Reassign Technician, Push Missed Jobs
- Jobs list: Property name, address, status badge (Completed / Scheduled / In Progress / Skipped), issue flags (Payment Hold, Gate locked)
- **⟳ Update (2026-07-07):** *Reassign Technician* now opens a modal (M15) — *"Reassign remaining jobs from [tech] to another tech"*, target-technician selector, note field (*"Add a note about this reassignment…"*), *"Notify new technician of reassignment"* checkbox, **Reassign Jobs** button. Technicians on a round are not fixed and can be changed after creation (see Screen 30).

---

### 14. Customers & Properties *(re-audited 2026-07-16 · Rough page)*  
**Section:** `/Customers-Properties` — **section node `401:12908`** · list frame `401:12909` (+ filter-open variants `761:9885`, `761:10213`; state variants `796:32658`, `796:32922`)  
**Purpose:** Master customer/property list — browse all customers, see round assignment and payment status at a glance.  
**Header:** "Customers & Properties" / subtitle "Showing 5 sample customers with complete records".  
**How-to banner:** "Click any customer row below to view their full property record. All text on this screen is selectable - just highlight and copy (Ctrl/Cmd+C)."  
**Search:** full-width — "Search customers by name, address, or postcode…".  
**Summary KPI row (4 cards):** **Total Customers** (5) · **Active** (2, green) · **Payment Holds** (1, red) · **Amount Due** (£84, amber).  
**Filters (top-right):** **Rounds** dropdown · **Status** dropdown (open-state variants captured in `761:9885` / `761:10213`).  
**Customer row (per property):**
- Name + **status badge** — `Active` (green) / `Hold` (red)
- Address with map-pin (e.g. "12 Market Street, NE66 1SS")
- Inline meta: **Round:** (Alnwick Monday) · **Frequency:** (Every 4 weeks) · **Price:** (£35) · **Technician:** (James) · **Next Due:** (15/06/2026) · **Payment Status:** badge — `paid` (green) / `hold` (red)
- **Hold rows** additionally show a red **⚠ "£84 due"** flag
- Chevron **›** → Customer Detail (Screen 15)

**Unassigned property row (inline state):** a property with no round replaces the meta row with an info banner — *"Not assigned to a round or technician yet — Assign this property to a round so visits can be scheduled and payments collected."* + **Assign to Round & Technician** button → Assign Property to Round (Screen 31). Maps to `Property.roundId = null`.

**Backend mapping:** each row = a `Property` joined to its `Customer` (name), current `ServicePlan` (price, cleanMethod), assigned `Round` + `Technician`. KPI cards + `Amount Due` + `Payment Status` "hold" are **derived** (no stored fields). Implies `GET /customers` (list) with **`?search=`** (name/address/postcode) and **`?round=` / `?status=`** filters — **endpoint not built**.

---

### 15. Customer Detail *(re-audited 2026-07-16 · all 6 tabs)*  
**Section:** `/Customers-Properties` (section `401:12908`)  
**Tab frames:** Overview `401:13125` · Service Plan `401:13325` · Visit History `559:44443` · Payments `401:13983` · Notes & Risk `401:14181` (Add-Note `592:6976`, toast `629:11606`) · Photos `401:14364`. (Naming note: Figma layers use both "Customers Details" and "Customer Details" — same screen.)  
**Purpose:** Full property record for a single customer/property.  
**Header (all tabs):** ← back · customer name + address · **status badge** (Active) · **round badge** (Alnwick Monday) · actions **Edit** (→ M19) · **Pause Service** (→ M9) · **Send Message** (→ Send Message route).  
**Standing info block (above the tabs, two columns):**
- **Property Information:** Property Type (Residential) · Frequency (Every 4 weeks) · Price (£35) · Clean Method (Water Fed Pole) · Next Due (15/06/2026) · Last Completed (20/05/2026) · Assigned Round (Alnwick Monday) · Technician (James).
- **Payment & Status:** Payment Status (paid) · Outstanding Balance (£0) · Payment Method (GoCardless) · Last Payment (15/05/2026) · Issues Count (0) · Next Visit Status (Scheduled).

**Tab bar (6 tabs — distinct routes): Overview · Service Plan · Visit History · Payments · Notes & Risk · Photos.**
- **Overview** (`401:13125`) — **Property Details:** Full Address (12 Market Street, NE66 1SS) · Access Notes ("No access notes") · Risk Notes ("No risk notes"). **Contact Information:** phone (+44 7700 900000) · email (customer@example.com).
- **Service Plan** (`401:13325`) — **Service Plan Details:** Service Type (Window Cleaning) · Price (Inc. VAT) · Round Assignment · Payment Rule · Plan Status (Active). Panel actions: **Move Round** · **Pause**.
- **Visit History** (`559:44443`) — table columns **Round · Status · Payment · Notes** (per visit; date + amount per row).
- **Payments** (`401:13983`) — **Payment History → "Visits & Invoices" ("N visits total")** table: **Visit Date · Technician · Amount · Payment** (badge `Unpaid` amber / `Paid` green) **· Invoice** (`Sent` / —) **· Transaction** (GoCardless id, e.g. `GC-2026-05-001`, or —) **· Action** (**Download** when invoiced, else **Generate** → M4). Toasts: "Invoice INV-… downloaded as PDF" (M11); "Message sent successfully" (M12).
- **Notes & Risk** (`401:14181`) — **Notes & Risk Information** + **Add Note** (→ M20). Note cards: type label (**Internal Note** / Risk Warning / Customer), body, "Added on 10 Mar 2026", "By Admin".
- **Photos** (`401:14364`) — **Property Photos** / **Upload Photo**; empty state "No property photos uploaded yet — Upload before and after photos to track work quality" + **Upload First Photo**.

**Unassigned property state:** when `Property.roundId = null`, the round badge / Assigned Round / Technician render as *Unassigned* with an **Assign to Round & Technician** CTA (→ Screen 31) — matches the list's unassigned row.

**Interactions:** Edit → **M19 (Edit Customer Record)** · Pause Service → **M9** · Send Message → route · Generate Invoice → **M4** (Payments-tab **Generate** action) · Add Note → **M20**. All six tabs are distinct routes.

**Backend mapping:** the info block + tabs read `Property` + current `ServicePlan` + latest `Payment`/`Visit`/`Invoice` (mostly **derived**). Notes → `Property.accessNotes`/`riskNotes` (Overview) **but** the Notes & Risk tab needs a multi-note model (see gaps). Contact → `Customer.phone`/`email`. Payments rows → `Visit`+`Invoice`+`Payment` (`Payment.gocardlessId` = Transaction). Photos → `Photo`. Implies `GET /customers/:id` (aggregate) — **not built**.

#### `/Customers-Properties` — full frame inventory & Buttons sub-group *(audited 2026-07-16)*
**Section `401:12908`** (Rough page, `RoundFlow-Admin`) holds **23 frames**: 18 in the main group + 5 in a nested **Buttons** sub-section (`401:14712`).
- **List states:** `401:12909` (default) · `761:9885` / `761:10213` (filter-dropdown open) · `796:32658` / `796:32922` (list state/button variants).
- **Detail tabs:** Overview `401:13125` · Service Plan `401:13325` · Visit History `559:44443` · Payments `401:13983` · Notes & Risk `401:14181` (+ Add-Note `592:6976`, toast `629:11606`) · Photos `401:14364`.
- **Payments overlays/toasts:** Generate Invoice `534:35154` (M4) · Preview Invoice `540:36009` (M5) · Download-PDF toast `540:38369` / `592:4974` (M11) · action toasts `559:44158` / `629:9938` / `629:10254` ("Message sent successfully" etc. — M12).
- **Buttons sub-group (`401:14712`, 5 frames):** **Edit Modal** `401:14713` (→ M19) · **Pause Service Modal** `401:15085` + `401:15414` (two states → M9) · list variants `796:32658` / `796:32922`. These are **component/state variants** (modal-open, toast, filter-open) overlaid on the list or Customer Detail — **not new routes**.

> ⚠️ **Schema gaps — Customers & Properties (2026-07-16):**
> - **Multi-note model missing.** The Notes & Risk tab + M20 show **multiple authored, timestamped notes** with a **type** (Internal / Risk Warning / Customer). Schema only has `Property.accessNotes` / `Property.riskNotes` as single strings → needs a `PropertyNote` model `{ id, propertyId, type, body, authorProfileId, createdAt }`. **Not in `schema.prisma`.**
> - **"Hold" has no field.** List/Detail show a `Hold` customer badge + `hold` payment badge, but `PaymentStatus` enum has no `HOLD`/`ON_HOLD`. How "hold" is set/derived is undefined (relates to overdue / `Visit.paymentHold`). See OQ-CP1.
> - **Derived-only values:** Outstanding Balance, Amount Due, Payment Holds count, Issues Count, Next Visit Status — no stored fields (aggregate queries needed).
> - **Per-plan Payment Rule** appears on the Service Plan tab, but `paymentRule` lives on `BusinessSettings` (global). See OQ-CP2.
> - **Endpoints implied but not built:** `GET /customers` (list + search + `?round`/`?status`), `GET /customers/:id`, `PATCH` customer/property/plan (Edit — M19), `POST /properties` (Add Property — M6), pause/resume (M9), `POST …/notes` (M20), `POST …/invoices` (M4), `POST …/photos` (upload), assign-to-round (Screen 31).

> **Open questions (Customers & Properties, 2026-07-16):**
> - **OQ-CP1:** How is **"Hold"** determined — manual flag, derived from overdue payments, or `Visit.paymentHold`? No dedicated field.
> - **OQ-CP2:** Is **Payment Rule** per-`ServicePlan` (Service Plan tab implies) or global (`BusinessSettings.paymentRule`)?
> - **OQ-CP3:** Notes stream scoped per **property** or per **customer**? (Tab is property-scoped but titled "Notes & Risk".)
> - **OQ-CP4:** **"Move Round"** (Service Plan tab) — same as Screen 31 (Assign Property to Round) or a distinct reassign flow?

> ✅ **M2 post-review patched (2026-07-21):** the Customers & Properties backend (M2) was built, then five senior-review findings were fixed:
> - **F1** — empty-string `roundId` / `serviceAreaId` / `serviceId` bypassed the FK guard → 500. **Resolved** (new `optId` helper normalises `""` → `null`).
> - **F2** — money summed in JS floating point → rounding errors + KPI/row mismatch. **Resolved** (`Prisma.Decimal.add` accumulation).
> - **F3** — `TECHNICIAN` role could read full financial data via `GET /customers` and `/customers/:id`. **Resolved** (Option B projection — `amountDue` / `outstandingBalance` / the payments tab are omitted for TECHNICIAN viewers).
> - **F4** — `pauseEndDate` not validated against `pauseStartDate`. **Resolved** (400 guard: end must be after start).
> - **F5** — `derivePaymentStatus` returned `"paid"` for zero-payment customers. **Resolved** (default now `"none"`; see OQ-CP1).

---

### 16. Debt / Payment Risk Board  
**Section:** `/Debt-Board` · Node `401:15703`  
**Purpose:** Financial risk triage — identify and act on overdue, failing, or held payments before the next clean.  
**Elements:**
- Header KPIs: Total Outstandings (£ + count), Failed GoCardless (red), Due Before Clean (amber), Hold Next Clean, Bad Debt (red bold)
- Search bar, Bulk Export button, All Rounds dropdown, Methods dropdown
- Category tabs (with count badges): Invoice Sent · Due Before · Failed GC · 7 Days Over · 14 Days Over · On Hold · Bad Debt
- Result count + Select All checkbox
- Customer cards (2-column grid): name, address, £ owed (red), payment method, contact status (Not yet contacted / Contacted), last contact timestamp
- Per-card actions: Send Reminder, View Invoice, ⋮ menu

**Interactions:** Tab click filters list. Card checkbox → bulk select. Send Reminder → modal. Card selected state shows expanded inline detail.

---

### 17. Debt Board — Card Selected State  
**Section:** `/Debt-Board` · Node `401:15950`  
**Purpose:** Expanded state of a customer card on the debt board with action buttons visible inline.  
**Elements:** Same as debt board but selected card shows Send Reminder / View Invoice buttons prominently.

---

### 18. Reports & History  
**Section:** `/Reports/History` · Node `404:1060`  
**Purpose:** Business performance analytics — revenue, completed visits, technician KPIs, visit history, and audit log.  
**Elements:**
- Header KPIs: Total Revenue, Completed Visits, Completed Rounds, Undone Payments; all show % vs last 30 days
- Status filter + Export button
- Revenue Overview: line chart (Daily/Weekly/Monthly toggle), full year
- Technician Performance table: Technician name/email, Completed, Skipped, Efficiency %, Revenue Impact
- Visit History table: Date, Property, Round, Technician, Status badge, Amount; View All →
- System Activity Log: timestamped event entries (visits generated, property added, technician assigned, round updated); View All →

---

### 19. Reports — Tech Manage View All  
**Section:** `/Reports/History` · Node `436:10715`  
**Purpose:** Full technician performance table, expanded from Reports. Route: `/reports/technicians`.  
**Elements:** Full-width technician table with more columns/rows than the Reports summary panel.

---

### 20. Complaints  
**Section:** `Complaints` · Node `592:8816`  
**Purpose:** Customer service queue — log and track quality issues.  
**Elements:**
- Cycle date + Log Complaint button (top right)
- Tab: All
- Search bar (customer or issue)
- Complaint cards: coloured status badge (Open · In Review · Revisit Booked · Resolved), date, issue title, customer name + area, technician avatar, photo count, calendar icon (revisit date)
- List sorted by recency; severity (Low / Medium / High) is not a sort factor

---

### 21. Complaint Detail  
**Section:** `Complaints` · Node `592:11810`  
**Purpose:** Read and respond to an individual complaint; manage resolution workflow.  
**Layout:** Two-panel split — left: complaints list (master), right: complaint detail (detail).  
**Elements (right panel):**
- ← Back to list
- Customer name + address, status badge (Open), severity badge (Low / Medium / High)
- Actions: Schedule Revisit · Mark In Review · Resolve
- Tabs: Messages · Details
- Messages tab: customer message thread, reply textarea (Ctrl+Enter to send), send icon button
- Toast notification ("Marked for in-review!") visible at top

---

### 22. Log New Complaint  
**Section:** `Complaints` · Node `734:15063`  
**Purpose:** Form to log a new customer complaint.  
**Elements:** Customer selector, issue type, description textarea, severity (Low / Medium / High — no effect on list ordering), assign technician, submit.

---

### 23. Settings — Business Profile *(re-audited 2026-07-08)*  
**Section:** `/Settings` · section node `936:42196` · frame `936:42197` (original Rough node `401:18286`)  
**Purpose:** Global business configuration — the **first of seven** Settings sub-sections.  
**Layout:** Two-column — left: settings nav (7 items), right: content panel. Header: *"Settings / Manage business rules, payments, technicians, messages, and round preferences anytime."*  
**Settings sub-screens** — each nav item is a **distinct panel** (all under `/Settings`):
| Nav item | Screen | Frame |
|----------|--------|-------|
| Business Profile | **23** (this) | `936:42197` |
| Payment Setup | **32** *(NEW)* | `936:42318` |
| Round Settings | **33** *(NEW)* | `936:42443` |
| SMS Templates | **34** *(NEW)* | `936:42550` |
| Technician Mgmt | **35** *(NEW)* | `936:42673` |
| Service Areas | **36** *(NEW)* | `936:42784` |
| Service Catalogue | **24** | `936:42893` |

**Business Profile fields:** Business Name \*, Business Phone \*, Business Email \*, Service Area \* (e.g. "Northumberland"), Default Working Days (Mon–Sun toggle buttons), Timezone dropdown (e.g. "Europe/London (GMT)"), Currency dropdown. **Edit** / **Save Changes** buttons.

---

### 24. Settings — Service Catalogue *(re-audited 2026-07-08)*  
**Section:** `/Settings` · frame `936:42893` (original Rough node `440:1889`)  
**Purpose:** Manage the list of services offered — name, category, description, default price, active/default toggles. *"Add Services you will provide to the customer/property."*  
**Elements:**
- **+ Add Area** button (top-right) — label reads "Add Area" but opens the **Add New Service** modal (M16); likely a design label slip.
- Services table columns: **Service** (name + description) · **Category badge** · **Default Price** (£) · **Active** toggle · row actions **Edit** (→ M17) / **Delete** (→ delete confirmation).
- Category badges observed: **Default** · **Window Cleaning** · **Gutter & Fascia** · **Exterior Cleaning** · **Specialist**.
- Example rows: Windows Only (Default · Window Cleaning · £12.00) · Conservatory Roof (£35.00) · Gutter Cleaning (Gutter & Fascia · £55.00) · Fascia & Soffits (£45.00) · Pressure Washing (Exterior Cleaning · £80.00) · Render Cleaning (£120.00) · Roof Cleaning (Specialist · £200.00, inactive) · Graffiti Removal (£150.00, inactive).
- **Save Changes** button; a "Changes saved successfully" toast (M12) appears on save.

**Modals:** **Add New Service** (M16), **Edit Service** (M17).

---

### 25. Technicians List *(re-audited 2026-07-08 · RoundFlow-Admin (Copy))*  
**Section:** `/Technicians` · Node `936:62093` (`technicians-list`) · original Rough node `695:14404`  
**Purpose:** Monitor team activity, performance, and round assignments.  
**Elements:**
- Date + Add Technician button
- Top KPIs: Active Now (green dot), Total Rounds, This Week's Revenue, Avg Rev/Hour
- Technician cards: avatar + name + role, status badge (In Progress / Completed), Rounds count, Today's Jobs (X/Y progress), Issues count (red), Revenue
- Assigned Rounds list (within card): round name, stop count, status badge, value
- Contact info row: phone, email, service areas
- Send Message / View Details action buttons
- **⟳ Update (2026-07-07):** technician cards/table now show an **App Status** column with an availability state — **Active** vs **Unavailable** (e.g. *"On leave 14 July 2026 — N jobs require reassignment"*). Marking a technician Unavailable flags their upcoming recurring jobs for reassignment (surfaced on Round Planner banner + Screen 30). Status pills observed: `● In Progress`, `✓ Active`, `Unavailable`. See change #2 in the Design Update Log and Open Question #13.
- **Empty state (`936:62193`):** when no technicians exist, the grid shows "No technicians in the system currently".

---

### 26. Technician Detail *(re-audited 2026-07-08)*  
**Section:** `/Technicians` · Node `936:62224` (`technician-detail-james`) · original Rough node `695:14580`  
**Purpose:** Full profile and performance record for a single technician.  
**Elements:**
- **Header:** name, "Role · Area · Phone" (e.g. "Lead Technician · Alnwick · 07123 456789"), status pill (● In Progress), **Send Message** button, ← Back to Technicians.
- **Today's Activity:** per-round progress (e.g. "Alnwick Monday 2/5 completed · £940", "Morpeth Wednesday 0/5 completed") + issue alert ("1 issue flagged on Alnwick Monday").
- **Performance (This Month):** Value Completed (£4,100), Time on Job (180h), Revenue / Hour (£22.80), Complaints (1), Issues (2).
- **Technician Info:** Full Name, Role, Phone, Email.

---

### 27. Send Message to Technician *(node updated 2026-07-08; content matches)*  
**Section:** `/Technicians` · Node `936:62333` (`message-james`) · original Rough node `695:14771`  
**Purpose:** Direct messaging interface for admin → technician communication.  
**Layout:** Full content-area page (not a modal).  
**Elements:**
- ← Back to [Name]
- "Send Message" heading + subtext
- To: pill (technician name + role + remove icon)
- Send via: SMS / WhatsApp toggle
- Message textarea + character counter (0/160)
- Credit cost info (1 SMS credit · ~3p per message)
- Schedule for later link
- Cancel / Send Message buttons
- **Previous Messages** list: date, message preview, SMS/WhatsApp badge

---

### 28. Add Technician *(re-audited 2026-07-08)*  
**Section:** `/Technicians` · Node `936:62394` (`add-technician`) · original Rough node `695:14911`  
**Purpose:** Form to onboard a new technician to the system — "Add a new team member and assign them to rounds."  
**Elements:**
- **Personal Details:** **Full Name \*** (e.g. "James Smith"), **Mobile Number \*** (e.g. "07700 900000"), **Email Address** (e.g. "james@example.com"), **Role** (Select role… dropdown), **Default Area** (Select area… dropdown), **Notes (optional)**.
- **App Access:** **"Send App Invite via SMS"** toggle — "Technician will receive a link to download the RoundFlow mobile app"; info note: "A text message will be sent to the mobile number above once you save."
- **Cancel** / **Add Technician** buttons.

---

### 29. Edit Technician *(re-audited 2026-07-08)*  
**Section:** `/Technicians` · Node `936:62464` (`edit-technician-james`) · original Rough node `737:9645`  
**Purpose:** Edit an existing technician's details and access settings — "Update [name]'s personal details and access settings."  
**Elements:**
- **Personal Details:** same fields as Add (Full Name \*, Mobile Number \*, Email Address, Role, Default Area, Notes), **prefilled** (e.g. Default Area = "Alnwick, Morpeth" — can hold multiple areas).
- **App Access:** "App Access Active" status pill + toggle; when already invited, shows **"App invite already sent. Resend invite?"**.
- **Danger Zone → Remove Technician:** "This will permanently remove [name] from all rounds." → opens the **Remove Technician Confirmation** modal (**M18**).
- **Cancel** / **Save Changes** buttons.

**Rule (backend, 2026-07-08):** **Danger Zone → Remove Technician maps to deactivation** — `PATCH /settings/technicians/:id` with `{ active: false }`, **not** a hard delete. Our `deleteTechnician` **409s** for accepted technicians (`profileId` set); that stays correct. Deactivation **preserves visit history** (required by Reports & History, Screen 18). Hard delete of an accepted technician is **not supported**.

> ⚠️ **Schema gaps identified (2026-07-08):** `Technician.email` (P1-nice, unbuilt), `Technician.notes` (new — not previously identified), Default Area wiring (`TechnicianServiceArea` join exists but unused). The **Send App Invite** mechanism requires a `TechnicianInvite` model (P1-req, M5). These are flagged for the next schema migration.

---

### 30. Round & Technician Assignment *(NEW — 2026-07-07)*  
**Section:** `Round & Technician Assignment` · Node `936:64543`  
**Purpose:** Manage which technician(s) are assigned to each round, per occurrence — the home of **multi-technician rounds** (change #1) and **reassignment** (change #3). Covers the operational gap the old single `technician` field couldn't express.  
**Rule:** A single round **can have more than one technician assigned simultaneously**. Job division within the round is done **manually by the admin** — each job is allocated to a technician per-`Visit` (via the 3-step Select → Allocate → Review wizard below); there is **no automatic split**.  
**Sub-screens (6 states in the section):**
- **Overview** — header KPIs: Total Rounds, Assigned, Unassigned. Table columns: **Round Name · Day · Assigned Technicians** (avatar chips, e.g. "J James", "S Sarah") **· Count · Status · Actions** (Manage / view). Confirms a round can list **more than one** assigned technician with a count.
- **Overview — Empty State** — "No rounds found / Try adjusting your filters or add a new round" + **Add Round**.
- **Overview — No Results** — "No results match your search" + Clear all filters.
- **Round Details** (e.g. Alnwick Monday / Morpeth Wednesday) — Scheduled Day, Total Stops, Estimated Duration, **Field Technician** (with "Assigned: <date>"), per-technician actions **Replace · Remove · + Add Technician**, and **Recent Activity / Assignment History** (e.g. "James assigned to Alnwick Monday · 2 days ago", "Round created", "Schedule confirmed").
- **Technician Details** (e.g. James) — availability status (**Available**), Assigned Rounds count, Weekly Hours, list of rounds ("Monday · 5 stops · 6.5 hrs" / View Round), **+ Assign to Round**, and an **Upcoming Schedule** (Mon Alnwick / Tue Off / Wed Morpeth…).

**Multi-technician assignment wizard (3 steps)** — invoked when assigning 2+ technicians to a round occurrence:
1. **Select Technicians** — *"Choose two or more technicians for this occurrence."* Search technicians by name; checkbox list (name · role e.g. "Field Technician" · availability e.g. "Available"); "N selected"; **Continue to Allocation →**.
2. **Allocate Jobs** — *"Select two or more technicians and manually divide the N jobs between them."* Manual per-job allocation to each technician (**job division is manual**). (An auto **"Distribute Jobs Evenly"** proposal — "even distribution … based on estimated duration and current workload balance" with "Apply Distribution" — was seen only in the file's **Trash**; treat as considered-but-cut unless confirmed.)
3. **Review & Confirm**.

**Interactions / warnings:** editing an in-progress occurrence warns *"This occurrence is currently in progress. Changing assignments may affect technicians who are already working on their allocated jobs…"*; rolling an assignment to the next occurrence warns *"Jobs or technician availability may have changed since the previous occurrence."*  
**Note:** the section is `hidden="true"` on canvas (a design/spec cluster), so treat as the intended model rather than a finalised route; some states also appear in the "Assigning multiple technicians to a round Flow" storyboard (`968:39312`) and the "Assigning technicians after every reoccurence of a property" storyboard (`975:35743`).

---

### 31. Assign Property to Round *(NEW — 2026-07-07)*  
**Section:** part of Add Property flow / standalone · Nodes `938:22027`+ ("Assign Property to Round"), `854:29024`–`854:29376`  
**Purpose:** Decide how a property is placed into a round — resolves **Open Question #8** and is the entry point for **multi-technician** placement (change #1) and **adding a property to a round** (change #5).  
**Elements:**
- Vertical stepper (labelled "Step 1 of 7" within the Add Property wizard context).
- Header: "Assign Property to Round" / *"Assign the property in whichever round you want."*
- **Round** selector + **Round Day** selector (e.g. Alnwick / Thursday).
- Assignment choice (two cards):
  - **One technician for all jobs** — *"Assign a single technician who will be responsible for completing all N jobs."*
  - **Multiple technicians with manual job allocation** — *"Select two or more technicians and manually divide the N jobs between them"* → routes into the 3-step allocation wizard (Screen 30).
- **Assign & Save** (assign now) **or Save & Assign Later** — *"Property will be saved as unassigned. You can assign it to a round from the customer record at any time."*
- Success states: **Success: Assigned** / **Success: Unassigned**; unassigned → **Customer Detail: Unassigned**.

**Interactions:** "Save & Assign Later" → property persisted with no round (unassigned), assignable later from the customer record. Choosing "Multiple technicians…" → Select Technicians → Allocate Jobs → Review & Confirm.

---

### 32. Settings — Payment Setup *(NEW — 2026-07-08)*  
**Section:** `/Settings` · frame `936:42318`  
**Purpose:** Connect payment providers and set default payment rules. *"Connect your payment providers."*  
**Elements:**
- **GoCardless** card — "Direct Debit collections", status **Not Connected**, **Connect GoCardless** button.
- **Stripe** card — "Payment links and card payments", **Connect Stripe** button.
- **Default Payment Settings:**
  - **Default Payment Rule** — e.g. "Collect after Visit" (dropdown).
  - **VAT Applicable** — toggle, "Include VAT in invoices by default".
  - **Debt Hold Enabled** — toggle, "Block service if payment is overdue".
- **Edit** / **Save Changes**.

**Note:** this is the full design for Setup Wizard **Step 2 (Payment Setup)**, which is a *deferred stub* in the backend for Phase 1.

---

### 33. Settings — Round Settings *(NEW — 2026-07-08)*  
**Section:** `/Settings` · frame `936:42443`  
**Purpose:** Configure default cleaning-round preferences. *"Configure your cleaning round preferences."*  
**Elements:**
- **Default Recurring Cycle** — options **Week · 2-week · 3-week · 4-week**.
- **Default Clean Methods** — **Traditional** · **Water-fed Pole**.
- **Auto-Generate Visits** — toggle, "Automatically create visits based on schedule".
- **Pre-Clean Reminder Timing** — "Reminders are sent at 7 PM the evening prior to the scheduled clean." + a time-of-day picker (e.g. 7:00 PM), "Set the time of day reminders are sent to customers."
- **Edit** / **Save Changes**.

**Note:** maps to Setup Wizard **Step 4 (Round Settings)** — default cycle length + working days.

---

### 34. Settings — SMS / WhatsApp Templates *(NEW — 2026-07-08)*  
**Section:** `/Settings` · frame `936:42550`  
**Purpose:** Manage pre-built customer message templates. *"Configure your customer messaging templates."*  
**Elements:**
- **Templates list**, each with a channel badge (**SMS** / **WhatsApp**): **Pre-Clean Reminder** (SMS) · **Payment Reminder** · **Payment Failed** · **Access Issue Follow-up** · **Job Completed** (WhatsApp) · **Weather Delay**.
- Message bodies use merge variables, e.g. `{{customer_name}}`, `{{amount_owed}}`.
- Per-template **Preview** / **Edit**; an editor ("SMS Message") shows a rendered example (e.g. "Hi John Smith, your window clean is scheduled for …").
- **Save Changes**.

**Note:** full design for Setup Wizard **Step 5 (SMS Templates)**, a *deferred stub* in the backend (templates managed via GHL).

---

### 35. Settings — Technician Management *(NEW — 2026-07-08)*  
**Section:** `/Settings` · frame `936:42673`  
**Purpose:** Add team members and assign areas — the Settings-panel view of technicians (complements the standalone `/Technicians` Screens 25–29). *"Add your team members and assign areas."*  
**Elements:**
- **Add Technician** → **Add New Technician** inline form: **Full Name \***, **Mobile Number \***, **Role**, **Default Area** (dropdown), **Cancel**.
- Technician table columns: **Phone · Role · App Status · Actions**. Example row: Mark Thompson · mark@example.com · 07123 456789 · Lead Technician · Alnwick · **Active**.
- **Save Changes**.

**Note:** overlaps `/Technicians` (Screens 25–29). This form collects **Full Name** at add-time — but the invite-pending `Technician` schema only carries name once the invite is accepted (via Supabase Auth). Reconcile: does Settings create a named technician directly, or an invite? (See Open Question #13 / MOB-2 context and the invite-entity schema item.)

---

### 36. Settings — Service Areas *(NEW — 2026-07-08)*  
**Section:** `/Settings` · frame `936:42784`  
**Purpose:** Define service areas and postcodes. *"Define your service areas and postcode."*  
**Elements:**
- **Add New Area** inline form: **Full Name \***, **Default Area** toggle, **Add Area** / **Cancel**.
- Area cards: area name, postcode sector (e.g. **Alnwick / NE66**), description ("Main town center and surrounding areas"), **Linked Rounds** (e.g. Alnwick Monday, Alnwick Wednesday) shown read-only.
- **Save Changes**.

**Note:** maps to Setup Wizard **Step 7 (Service Areas)**. Surfaces the round↔area linkage.

---

## Modals & Overlays

### M1 — Bulk Message Round *(re-audited 2026-07-08)*  
**Triggered from:** **Bulk Message** quick action — on the **Dashboard** *and* the **Technicians** list (Quick Actions sidebar), not just the Dashboard.  
**Frames:** `936:62729` (live, RoundFlow-Admin (Copy)) · original `733:13202`  
**Context:** Overlaid on the background screen (blurred).  
**Elements:**
- Title: "Bulk Message Round" + subtitle
- Round dropdown (e.g. "Alnwick Monday (32 customers)")
- Message Template dropdown (e.g. "Weather Delay")
- Message Preview textarea (editable, 160 char/SMS credit shown)
- "Exclude customers on payment hold" checkbox
- Recipients + total cost info ("32 customers · 32 SMS credits (£3.20)")
- Send Options: Send now / Schedule radio
- Cancel / Send Message

---

### M2 — Add One-Off Job *(re-audited 2026-07-08)*  
**Triggered from:** **Add One-Off Job** quick action — on the **Dashboard** *and* the **Technicians** list, not just the Dashboard.  
**Frames:** `936:62891` (`AddOneOffJobModal`, live) · original `733:13907`  
**Context:** Overlaid on the background screen.  
**Elements:**
- Title: "Add One-Off Job" + subtitle
- Customer/Property dropdown (searchable)
- Service Type dropdown (e.g. Window Cleaning)
- Date picker + Time input
- Price input (£)
- Technician dropdown (Assign Later option)
- Payment Method dropdown (Cash, GoCardless, etc.)
- Notes textarea
- Info box: "One-off job — This job will not be added to regular rounds and won't recur automatically"
- Cancel / Create One-Off Visit

---

### M3 — Send Payment Reminder  
**Triggered from:** Debt/Payment Board > Send Reminder card action  
**Frames:** `401:16651`  
**Context:** Overlaid on the Debt Board.  
**Elements:**
- Title: "Send Payment Reminder"
- To: pre-filled customer name
- Send via: SMS / WhatsApp / EMAIL tab buttons
- Template dropdown (e.g. "Gentle Reminder")
- Message textarea (pre-filled from template, 154 chars shown)
- Cancel / Send Reminder

---

### M4 — Generate Invoice *(re-audited 2026-07-16)*  
**Triggered from:** Customer Detail → Payments tab → a row's **Generate** action  
**Frames:** `534:35154`  
**Context:** Overlaid on the Customer Detail (Payments tab) screen.  
**Elements:**
- Title: "Generate Invoice" + customer name + date
- Summary grid: Customer, Property, Visit Date, Amount (£35.00), Customer Email
- Invoice Number input (auto-generated, e.g. INV-2026-217)
- Notes textarea (optional)
- Payment Method info box (e.g. "Payment collected via GoCardless")
- "Also send to customer via email" checkbox + email preview
- Cancel / Preview Invoice / Generate & Send

---

### M5 — Preview Invoice *(re-audited 2026-07-16)*  
**Triggered from:** Generate Invoice modal (M4) > **Preview Invoice**  
**Frames:** `540:36009`  
**Context:** Overlaid on Customer Detail.  
**Elements:** "Invoice Preview" — a **rendered invoice**: RoundFlow logo + **INVOICE #INV-…**; **BILL TO** (name, address, email, phone); **INVOICE DETAILS** (Invoice Date, Visit Date, Due Date, Payment method e.g. GoCardless); **DESCRIPTION** (e.g. "Window Cleaning Service · Alnwick Monday · Saturday 23 May 2026") + **TECHNICIAN** + **AMOUNT** (£35.00); **Subtotal**, **VAT (0%)**, **Total Due**; footer "Thank you for your business". Actions: **← Edit Details** · **Print** · **Download PDF** (→ M11 toast).

---

### M6 — Add Property (Multi-step Wizard)  
**Triggered from:** Dashboard (implied) or Customers screen  
**Frames:** `442:5244` through `442:12302` (7 steps)  
**Context:** Full modal overlay on the Dashboard (dashboard visible in background).  
**Step indicator:** Vertical numbered stepper (steps 01–05 visible, scrollable).  
**Step 1 — Property Details:**
- Customer Name, Property Name (optional), Phone Number, Email (optional), Full Address, Postcode, Service Area dropdown, Property Type dropdown
- Back / Continue (Step 1 of 7)  
*Step 1 doubles as customer creation — no separate Add Customer flow exists. Subsequent steps cover service assignment, round assignment, payment setup, schedule, confirmation, and the "Assign Property to Round" sub-flow (now a distinct, fully-designed screen — see Screen 31).*

***⟳ Update (2026-07-07):** the "Assign Property to Round" step is now fully designed (Screen 31), **resolving Open Question #8**. The final step offers **Assign to a Round Now** vs **Save & Assign Later**; "Save & Assign Later" saves the property **unassigned** (*"Property will be saved as unassigned. You can assign it to a round from the customer record at any time"*), producing a **Customer Detail: Unassigned** state (matches the schema's nullable `Property.roundId`). Within "Assign Now", the admin chooses **One technician for all jobs** or **Multiple technicians with manual job allocation** (Screen 30/31). New frames observed: `854:28979`–`854:29376` (Step 4/5 Notes & Risk, Assign Decision, Assign Now empty/filled, Success: Assigned, Assign Later selected, Success: Unassigned, Customer Detail: Unassigned).*

---

### M7 — Confirmation / Delete Alerts  
**Frames:** `435:5886`, `435:7015`, `544:38842` series, `534:34060`, `629:9938`, etc.  
**Context:** Generic confirmation dialogs (overlaid on various screens).  
**Elements:** Icon, title text, descriptive message, Cancel / Confirm (destructive red) buttons.  
**Used for:** pausing service, resuming service, sending payment links, deleting items.

---

### M8 — Send Payment Link  
**Triggered from:** Debt Board  
**Frames:** `401:17371`  
**Elements:** Customer detail, amount, payment link method selector, send button.

---

### M9 — Pause Service / Resume Service *(re-audited 2026-07-16)*  
**Triggered from:** Customer Detail → **Pause Service** (Screen 15) / Debt Board  
**Frames:** `401:15085`, `401:15414` (Buttons group — Pause states) · original `401:17677` (Pause), `401:17984` (Resume)  
**Elements:**
- **Reason for Pause** dropdown (e.g. "Customer Holiday/ Away").
- **Pause Duration:** **Specific date range** ("Service will automatically resume on the end date") **/ Indefinite pause** ("Must be manually resumed — no scheduled visits will be generated").
- **Start Date** + **Resume Date** pickers.
- **Notify customer by SMS** toggle + editable message preview (e.g. "Hi John Smith, we're temporarily pausing your window cleaning service as requested…", char count · 1 SMS).
- Warning banner: **"Upcoming visits will be cancelled — Any scheduled visits during the pause period will not be generated. Payment collection will also be suspended."**
- **Cancel** / **Pause Service**.

**Backend:** sets a paused `LifecycleStatus` on `ServicePlan`/`Property`/`Customer` (`PAUSED` exists) + a pause window (start/resume) — **no pause-window fields in schema**; visit generation + payment collection must skip the window. Implies `POST /customers/:id/pause` + `/resume` — not built.

---

### M10 — Invoice Generated (Debt Board)  
**Triggered from:** Debt Board customer card  
**Frames:** `453:12981`  
**Elements:** Success state showing invoice number, amount, send status.

---

### M11 — Download Confirmation *(re-audited 2026-07-16)*  
**Triggered from:** Customer Detail → Payments tab → **Download** (or Preview Invoice → Download PDF)  
**Frames:** `540:38369`, `592:4974`  
**Elements:** A **success toast** (not a dialog) — e.g. **"Invoice INV-2026-733 downloaded as PDF"** with an X dismiss, shown over the Payments tab. Same toast pattern as M12.

---

### M12 — Message Frame (Toast)  
**Frames:** `435:5880`, `435:7692`, `534:34055`, `534:34605`, `734:15161`  
**Purpose:** Success/error toast notification (small bar, ~405×46px).  
**Elements:** Icon + short message text + X dismiss. Appears at top of screen. Seen on Dashboard, Settings, Technicians.

---

### M13 — Technician Delete Confirmation  
**Triggered from:** Technicians list/detail  
**Frames:** `734:15646` (labelled "Modal")  
**Elements:** Confirmation dialog for deleting/removing a technician.

---

### M14 — Upcoming Property Recurrences *(NEW — 2026-07-07)*  
**Triggered from:** Round Planner alert banner ("N properties have upcoming recurrences requiring technician assignment") > **Review Now**  
**Section:** `975:35743` ("Assigning technicians after every reoccurence of a property")  
**Purpose:** Per-occurrence (re)assignment — supports change #3. Because a round is assigned per recurrence, upcoming recurrences can be **Unassigned** and need a technician before dispatch.  
**Rule:** Technician assignment is **per occurrence** and **manual**. Each new recurrence of a property's visit **starts unassigned** — the previous occurrence's technician is **not auto-inherited**. The admin must **explicitly assign** each new occurrence (via this modal or Screen 30) before dispatch. (Rolling a prior assignment forward is itself a *deliberate* admin action, shown with a review warning — see Screen 30; visit generation never auto-assigns.)  
**Elements:**
- Title: "Upcoming Property Recurrences" + *"The following properties have recurrences due soon and need a technician assigned."*
- Property rows: property address, `customer · round` (e.g. "John Smith · Alnwick Monday"), **next recurrence date** (e.g. "21 Jul 2026"), **frequency** (e.g. "Every 4 weeks" / "Every 6 weeks"), status **Unassigned**, **Assign** button per row.

---

### M15 — Reassign Technician *(NEW — 2026-07-07)*  
**Triggered from:** Today's Work > Round Details Panel > **Reassign Technician** (Screen 13)  
**Frames:** in `/Today-s-Work` section (~`936:25925`)  
**Purpose:** Move remaining jobs from one technician to another mid-day — supports change #3.  
**Elements:**
- *"Reassign remaining jobs from [tech] to another tech"* + target-technician selector.
- Note field: *"Add a note about this reassignment…"*
- Checkbox: *"Notify new technician of reassignment"*.
- **Reassign Jobs** (confirm) / Cancel.

---

### M16 — Add New Service *(NEW — 2026-07-08)*  
**Triggered from:** Settings → Service Catalogue → **+ Add Area** button (Screen 24)  
**Frame:** `936:43855`  
**Purpose:** Create a custom service that can be added to jobs.  
**Elements:** **Service Name** (e.g. "Pressure Washing"), **Description** (optional), **Default Price (£)**, **Category** dropdown (`ServiceCategory`), **Active** toggle ("Available to add to jobs"), **Default** toggle ("Pre selected on new jobs"). **Cancel** / **Add Service**.

---

### M17 — Edit Service *(NEW — 2026-07-08)*  
**Triggered from:** Settings → Service Catalogue → row **Edit** (Screen 24)  
**Frame:** `936:43544`  
**Purpose:** Update the details for an existing service.  
**Elements:** Same fields as M16, pre-filled (Service Name, Description, Default Price, Category, Active, Default toggles). **Cancel** / **Save Changes**.

---

### M18 — Remove Technician Confirmation *(NEW — 2026-07-08)*  
**Triggered from:** Edit Technician (Screen 29) → **Danger Zone → Remove Technician**  
**Frame:** `936:62619`  
**Purpose:** Confirm removal of a technician from the system.  
**Elements:** "Are you sure you want to remove the technician **[name]** from the system?" · **Cancel** / **Remove** (destructive).  
**Note (backend):** "Remove" maps to **deactivation** (`PATCH /settings/technicians/:id` with `{ active: false }`), **not** a hard delete — accepted technicians (`profileId` set) are never destroyed, preserving visit history. See Screen 29 Rule.

---

### M19 — Edit Customer Record *(NEW — 2026-07-16)*  
**Triggered from:** Customer Detail → **Edit** (Screen 15)  
**Frame:** `401:14713` (Buttons sub-group)  
**Purpose:** Edit a customer + their property + service plan in one form.  
**Elements:**
- **Contact Details:** Full Name · Phone Number · Email Address.
- **Property Address:** Street Address · Postcode · Property Type (dropdown).
- **Service Details:** Frequency (dropdown) · Price (£) · Clean Method (dropdown) · Payment Method (dropdown) · Assigned Round (dropdown) · Assigned Technician (dropdown).
- **Notes:** Access Notes ("e.g. Gate code: 1234, side access only…") · Risk Notes (⚠ "visible to all technicians" — "e.g. Aggressive dog, slippery path…").
- **Cancel** / **Save Changes**.

**Backend:** one form that writes across **`Customer`** (name/phone/email), **`Property`** (address/postcode/type/accessNotes/riskNotes/roundId), **`ServicePlan`** (price/cleanMethod/paymentMethod) and **`Visit.technicianId`** (assigned technician). Implies `PATCH /customers/:id` (+ nested property/plan) — **not built**.

---

### M20 — Add Note (Notes & Risk) *(NEW — 2026-07-16)*  
**Triggered from:** Customer Detail → Notes & Risk tab → **Add Note** (Screen 15)  
**Frame:** `592:6976`  
**Purpose:** Add a timestamped, authored note to a property/customer.  
**Elements:** **New Note** — type toggle **Internal** / **Risk Warning** / **Customer** — + Text Area ("Type your note here…"); Save / Cancel.  
**Backend gap:** implies a **note entity** `{ type, body, author, createdAt }` per property — **no such model exists** (`Property.accessNotes`/`riskNotes` are single free-text strings). See the Customers & Properties schema-gaps note under Screen 15 (OQ-CP3).

---

## Dropdowns & Components

### D1 — Technician Filter Dropdown (Round Planner)  
**Node:** `665:11428` (full screen showing dropdown open state)  
**Behaviour:** Opens from the Technician button in the Round Planner header. Multi-select checklist with technician names and round counts (e.g. James 1, Sarah 1).

---

### D2 — Status Filter Dropdown (Round Planner)  
**Node:** `684:8103`  
**Behaviour:** Opens from Status button. Options: all statuses (Completed, In Progress, Scheduled, etc.).

---

### D3 — Status Filter Dropdown (Reports)  
**Node:** `404:1471`  
**Behaviour:** Small dropdown (107×99px), appears near the Export button. Status options for filtering visit history.

---

### D4 — Round Detail Dropdown (Debt Board)  
**Node:** `401:16244`  
**Behaviour:** Inline dropdown on the debt board for expanding payment method or round detail options.

---

### D5 — Area / Location Dropdown  
**Appears on:** Round Planner header, Customers & Properties filters.  
**Behaviour:** Single-select dropdown filtering all content by service area (e.g. "Alnwick", "All Rounds").

---

### D6 — Rounds Dropdown (Customers)  
**Node:** in `/Customers-Properties` section  
**Behaviour:** Filters the customer list by assigned round.

---

### D7 — Message Template Dropdown  
**Appears in:** Bulk Message modal, Send Payment Reminder modal, SMS Templates in Settings.  
**Behaviour:** Single-select, pre-built template options (Gentle Reminder, Weather Delay, etc.) — selecting a template pre-fills the message body.

---

### Dev Reference Frames (not app screens)  
**Section:** `/Dev Reference — Dropdowns` · Node `716:9201`  
Six annotated reference frames used internally by designers/developers to document dropdown states for:
- Round Planner
- Customers & Debt
- Reports
- Settings
- Setup Wizard
- Technicians/Messaging

These are **not user-facing screens** — exclude from implementation scope.

---

## Open Questions

1. ~~**Step count mismatch in Setup Wizard**~~ — **Resolved.** Stepper and footer are now consistent (8 steps).

2. ~~**No "Add Customer" screen found**~~ — **Resolved.** No separate Add Customer screen exists by design; customers are always created as part of the Add Property flow (M6 Step 1).

3. ~~**Round Planner — "Alnwick Tuesday" frame**~~ — **Resolved.** Same route as Calendar View, filtered via `/round-planner?round=X` query param; not a separate nested route.

4. ~~**16 "Customers Details" frame variants**~~ — **Resolved.** Distinct routes: Edit Customer, Send Message, Pause Service. All six tabs are distinct routes: Overview (default), Service Plan, Visit History, Payments, Notes & Risk, Photos. Remaining frames are prototype transition states, not separate routes.

5. ~~**Naming inconsistency**~~ — **Resolved.** "Customers Details" and "Customer Details" are the same screen; the variation is a Figma layer naming error. Treat as one screen throughout.

6. ~~**GPS Map standalone frame**~~ — **Resolved.** Confirmed as the embedded `GPSMap` component within the Dashboard's "Live GPS Tracking" section; not a standalone route.

7. ~~**Reports — "Tech Manage View All"**~~ — **Resolved.** Route is `/reports/technicians`, not under `/technicians`.

8. ~~**TBD — "Assign Property Now?"**~~ — **Resolved (2026-07-07).** The flow is now fully designed as **Screen 31 (Assign Property to Round)**. Declining = **Save & Assign Later** → the property is **created and saved unassigned** (no round), assignable later from the customer record (**Customer Detail: Unassigned**). Not auto-queued. Matches the schema's nullable `Property.roundId`.

9. ~~**Download Confirmation**~~ — **Resolved.** Single confirmation state (M11) reused in two contexts; the two frames are not distinct states.

10. ~~**Complaint severity field**~~ — **Resolved.** Three levels: Low / Medium / High. No effect on list ordering; list is sorted by recency.

11. ~~**"Add Round" flow step count ambiguity**~~ — **Resolved.** Each numbered frame is a distinct wizard step (7 steps total). Step 2 is a single long scrollable step, not a separate screen.

12. ~~**Cycle vs. period terminology**~~ — **Resolved.** "Cycle" is used consistently throughout the UI; "Period" does not appear anywhere.

13. ⚠️ **TBD (2026-07-07) — Technician "unable to attend" self-mark trigger (change #2).** The admin surfaces a technician **availability status** (Available / **Unavailable** / "On leave <date> — N jobs require reassignment", Screen 25/30) which flags upcoming recurring jobs for reassignment. The mobile app offers only a **per-visit Skip** (reasons: Not home / No access / Customer refused / Unsafe conditions / Other) — *not* a "mark myself unavailable for this round/occurrence" action. **No distinct screen was found where a technician self-marks unable to attend a whole recurring job.** Unresolved: is availability admin-set only, or is there a technician-facing action not yet designed? (See Mobile Open Question MOB-2.)

---

## Mobile App (RoundFlow Technician / B2C)

> Audited 2026-07-07 via figma-desktop MCP · file `RoundFlow-B2C` · Page 1 (`0:1`). ~20 phone screens + 6 bottom sheets on a single page. Screenshots unavailable this pass; extracted from frame metadata/text.

### Overview
**App:** RoundFlow **Technician** (the login reads "RoundFlow Technician"). Despite the `RoundFlow-B2C` filename, the content is **technician-facing** — daily job list, per-property visit execution, photo capture, cash collection, skip/access-issue reporting. No customer-facing screens were observed (see MOB-1). This is the mobile counterpart to the admin's Today's Work / Round Planner / Customer Detail.

### Screens
1. **Login** (`login-screen`, section `10:3016`) — "RoundFlow Technician / Sign in to view your jobs"; Email, Password, Forgot password?, **Sign in**; "Have an invitation code? **Enter code**"; footer "Account issues? Call the office on 01665 123 456".
2. **Invitation Code** (`invitation-code-screen`) — enter an invite code. Technician onboarding is **invite-based** (matches admin "invited" technicians / nullable `Technician.profileId`).
3. **Forgot Password** (`forgot-password-screen`) — "Reset Password / Enter your email address and we'll send you a reset link"; **Send Reset Link**; "Check your inbox for the reset instructions."
4. **Complete Your Profile** (`complete-profile-screen`) — "Complete Your Profile" (after accepting an invite).
5. **Today / Job List** (`TodayScreen`, `4:117`) — date; "Good morning, [name]"; **Today's round** card (round name e.g. "Alnwick Monday", "Assigned to you · N properties", progress "2/5", "Currently in progress"); property list (customer name, address, status); "All properties".
6. **Notifications** (`10:2923`) — Schedule update ("Alan Watts (property 5) moved from tomorrow to today"), Round confirmed ("Alnwick Monday dispatched for today"), Round ready, Payment collected ("Direct debit confirmed for …"); timestamps.
7. **Property Details** (several states, e.g. `5:605`, `10:3116`, `10:3026`) — "Property N of 5", customer name + address, **StatusBadge** (Ready / In progress / Completed), **Open directions**; **Safety note** (red risk box); **Access notes** (incl. gate code, e.g. "Gate code: 7734#"); **Service details** (Service e.g. "Full exterior window clean", Price, Payment method e.g. "direct debit", Last clean); **Start visit**.
8. **Active Visit** (`ActiveVisitScreen`, `5:750`+) — property details + notes; **Payment note** ("Cash payment due — £52. Confirm receipt before leaving"); **Photos** (before/after, "Photos are optional"); **Add note for office** ("Internal — not visible to customer"); actions: **Record cash payment (£X due) · Skip property · Report access problem · Mark property complete**.
9. **Property Complete** (`10:2862`) — "Property complete"; next-property preview; **Go to next property** / **View round overview**.

### Modals (bottom sheets)
- **PhotoSheet** — capture before/after photo.
- **NoteSheet** — add internal "note for office".
- **CashSheet** — "Confirm you have received £X in cash from the customer" · **Confirm £X received in cash** / Cancel.
- **SkipSheet** — "Skipping [customer]. Select a reason": **Not home · No access · Customer refused · Unsafe conditions · Other** · **Confirm skip**.
- **AccessIssueSheet** — **Description \*** ("What prevented access?") · submit.
- **CompleteConfirmSheet** — "Complete this property?" · Customer / Service / Price · "Completing this visit will notify the customer…" · **Confirm completion** / Not yet.

### Correspondence to admin screens (same data, different interface)
- Today's round + property list ↔ admin **Round** + **Visits** (Today's Work / Round Planner).
- Property Details ↔ **Customer Detail** (Overview / Service Plan / Notes & Risk / access + risk notes).
- Skip / Complete / cash actions ↔ **Visit.status** + **Payment**.
- Notifications (schedule change / round confirmed) ↔ admin dispatch + reassignment (M14/M15, Round Planner).

### Backend requirements implied (not all in current schema)
- **Invite-code onboarding** for technicians (invite token → Complete Profile → Supabase user → Profile role TECHNICIAN linked to Technician). Token/invite entity **not modelled**.
- **Skip reason** enum (Not home / No access / Customer refused / Unsafe conditions / Other) — currently `Visit.skipReason` is a free `String`.
- **Access issue** description — `Issue` exists, but a captured free-text "what prevented access?" field is implied.
- **Cash payment confirmation** ("received in cash") ↔ `Payment.method = CASH` (exists).
- **Notifications feed** (schedule updates, round confirmed, payment collected) — **not modelled** (no notification entity).
- Before/after **Photos** per visit — modelled (`Photo`).

### Open Questions (mobile)
- **MOB-1:** Is the `B2C` filename intentional? All observed content is technician-facing; confirm no separate customer app is expected here.
- **MOB-2:** Where does a technician mark "unable to attend" a whole round/occurrence (change #2)? Only per-visit Skip exists in mobile; admin shows an availability status. Self-mark trigger unresolved (see Open Question #13).
- **MOB-3:** Notifications — push vs in-app only? Backend feed/entity undefined.

---

## Design Update Log

**2026-07-07 — Admin re-audit (`RoundFlow-Admin`, Page 1 `0:1`) + new Mobile audit (`RoundFlow-B2C`).**
Original audit was **2026-06-30** on the "Rough" page (node `401:943`), which still exists as a second page in the admin file. Changes captured:

- **#1 Multi-technician rounds** — a round can carry **multiple technicians**; **job division is manual**. New **Screen 30 (Round & Technician Assignment)** (Overview table with "Assigned Technicians" + Count; Round Details with Replace / Remove / **+ Add Technician**) and **Screen 31 (Assign Property to Round)** (choice: *One technician for all jobs* vs *Multiple technicians with manual job allocation*). 3-step wizard: **Select Technicians → Allocate Jobs → Review & Confirm**. Storyboard: `968:39312`.
- **#2 Technician job status** — **Screen 25** now has an **App Status** (Active / **Unavailable**, "On leave <date> — N jobs require reassignment"); mobile has per-visit **Skip** reasons. Self-mark trigger for a whole round is **unresolved** (Open Question #13 / MOB-2).
- **#3 Technician reassignment on existing rounds** — **M15 (Reassign Technician modal)** from Today's Work (Screen 13); **Screen 30** Replace / Remove / + Add Technician; **M14 (Upcoming Property Recurrences)** — assignment is **per occurrence**, so recurrences can be Unassigned and need assigning. **Rule:** each new occurrence **starts unassigned**; technicians are assigned **per occurrence** and are **not auto-inherited** from the previous occurrence (deliberate admin action required before dispatch). Storyboard: `975:35743`.
- **#4 Add Round quick action** — confirmed as a **sidebar Quick Action** ("Add Round", alongside Bulk Message / Add One-Off Job) and a **"+ Add Round"** button on Round Planner; both open the **CreateRoundModal** 5-step wizard (Round Details · Assign Area · Add Properties · Assign Technician · Review & Save). Section `936:57646`.
- **#5 Add properties to existing rounds** — **Add Round → Step 3 "Add Properties"** (search existing, or **Add New Property Inline**: Address, Customer name, Postcode, Price £); and **Screen 31** places an existing/new property into a round after creation.
- **Open Question #8 resolved** (Assign Property Now decline → Save & Assign Later → unassigned property).
- **New Mobile App section** added (RoundFlow Technician / B2C).

**Method note:** screenshots could not be captured (figma-desktop MCP served only the active tab during this pass); all details were extracted from frame metadata/text. Frame IDs cited inline for re-verification.

**2026-07-08 — `/Settings` section full audit (node `936:42196`).**
The Settings area was under-documented (only Screens 23 & 24). The `/Settings`
section actually contains **seven** distinct sub-screens (one per left-nav item)
plus service modals. Captured this pass — **Business Profile (23)**, **Payment
Setup (32, NEW)**, **Round Settings (33, NEW)**, **SMS/WhatsApp Templates (34,
NEW)**, **Technician Management (35, NEW)**, **Service Areas (36, NEW)**,
**Service Catalogue (24)** — plus **Add New Service (M16, NEW)** and **Edit
Service (M17, NEW)** modals and a "Changes saved successfully" toast (M12).
Screens 23 & 24 expanded; 32–36 and M16/M17 added. Node IDs are Page-1
(`936:4xxxx`). Screenshots of the Add/Edit Service modals and the Service
Catalogue were captured this pass (admin file was the active tab). The seven
sub-screens are grouped via the cross-reference index in Screen 23 rather than a
separate top-level section, to keep the existing screen numbering intact.

**2026-07-08 — `/Technicians` section re-audited (from `RoundFlow-Admin (Copy)`, node `936:62092`).**
**10 frames** found vs **5** documented. **Node IDs updated** to live Page-1 IDs
(`695/737:xxxx` → `936:62xxx`). Screens **26 / 28 / 29** were purpose-only and are
now **fully documented** (fields, App Access, Danger Zone); Screen 25 gains an
**empty state** (`936:62193`). New modal **M18 (Remove Technician Confirmation)**
added; **M1 (Bulk Message)** and **M2 (Add One-Off Job)** given live node IDs and
noted as reachable from the Technicians list too. **Remove Technician conflict
resolved as deactivation** (Option A): Danger-Zone Remove → `PATCH { active: false }`,
not a hard delete — `deleteTechnician` keeps 409-ing accepted technicians, preserving
visit history. Schema gaps flagged under Screen 29 (`Technician.email`, `Technician.notes`,
Default-Area wiring, `TechnicianInvite` for Send App Invite).

**2026-07-21 — Setup Wizard steps 9–12 deep audit (`RoundFlow-Admin`, Page 1, nodes `936:46253`–`936:47259`+).**
Steps 9–12 live-inspected via Figma MCP plugin (fresh fetch, no cached nodes). Confirmed 34 total setup frames. Added full per-sub-step breakdown for step 9 (5 sub-steps, vertical left stepper), full field/state inventory for step 10 (Round Assignments table, Technician Workload panel, multi-tech schema gap flagged), step 11 (Generate Visits toggles, Start Date, Frequency/Cycle, Activate CTA), and step 12 (7-item checklist, Ready to Launch, What Happens Next). Key decisions recorded: step 9 does NOT reuse `POST /customers`/`POST /properties`; step 10 requires a new `RoundTechnician` join table (multi-tech per round); step 11 generates the first visit cycle; step 12 reuses existing `POST /setup/complete`. Figma screenshots captured for steps 9 (sub-step 01 two states), 10, 11, 12.

**2026-07-16 — `/Customers-Properties` section fully audited (Rough page, section node `401:12908`).**
Corrected the section reference: **`401:12909` is the list screen, not the section** — the
container is **`401:12908`**, which holds **23 frames** (18 main + 5 in a nested **Buttons**
sub-section `401:14712`). Screen 14 expanded (header, how-to banner, search, Rounds/Status
filters, 4 KPI cards, full row columns, `Active`/`Hold` + `paid`/`hold` badges, `£N due`
flag, **inline Unassigned property row** → Assign to Round & Technician). Screen 15 expanded
to **all 6 tabs** (Overview, Service Plan, Visit History, Payments w/ Visits & Invoices table,
Notes & Risk, Photos) + standing info block + Unassigned state. Modals **M4/M5/M9/M11**
expanded from the live frames; new modals **M19 (Edit Customer Record)** and **M20 (Add Note)**
added. **Schema gaps** flagged (Screen 15): missing multi-note model (`PropertyNote`), no
"Hold" field, per-plan Payment Rule ambiguity, pause-window fields, and a raft of unbuilt
`/customers`, `/properties`, invoice/pause/note/photo endpoints. **4 open questions**
(OQ-CP1..4). Method: text extracted from the Rough-page metadata dump; 7 frames screenshotted
(Generate/Preview Invoice, Edit Customer, Pause Service, list, Confirmation + Download toasts).
