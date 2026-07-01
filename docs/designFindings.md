# Design Findings — Unofficial WC Wireframes ("Rough" Page)

> Inspected via figma-desktop MCP · Node 401:943 · 2026-06-30

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

### 1. Login  
**Section:** `Login/signup` · Node `658:7746`  
**Purpose:** Authentication entry point for returning users.  
**Layout:** Split — dark left panel (brand marketing) + white right panel (form).  
**Elements:**
- Left: RoundFlow logo, headline "Manage your rounds. Empower your team.", 3 feature bullets (Live GPS tracking, Automated scheduling, Instant payments)
- Right: Log in / Sign up tab toggle, Work email input, Password input, Remember me checkbox, Forgot password link, Sign in button, "Continue with Google" OAuth button, Sign up link

**Interactions:** Tab toggle switches between login and signup form. Forgot password → dedicated screen.

---

### 2. Sign Up  
**Section:** `Login/signup` · Node `658:7808`  
**Purpose:** New user account registration.  
**Elements:** Same split layout. Name, work email, password, confirm password fields + Sign up CTA.

---

### 3. Forgot Password  
**Section:** `Login/signup` · Node `681:8108`  
**Purpose:** Password reset request.  
**Elements:** Email input, Send Reset Link button, Back to login link.

---

### 4. OTP Verification  
**Section:** `Login/signup` · Node `681:8150`  
**Purpose:** 6-digit code verification step in password reset flow.  
**Elements:** 6-box OTP input, Resend code link, Verify button.

---

### 5. Reset Password  
**Section:** `Login/signup` · Node `681:8203`  
**Purpose:** New password entry after OTP confirmed.  
**Elements:** New password + confirm password inputs, Reset Password button.

---

### 6. Setup Wizard (Onboarding)  
**Section:** `/Setup` · Primary node `401:19250`  
**Purpose:** First-run multi-step wizard to configure the business before using the app.  
**Layout:** Full-screen (no sidebar nav), horizontal step indicator at top showing 8 steps.

**Steps:**
1. **Business Profile** — Business Name, Phone, Email, Service Area (optional), Company Number, VAT Registration, VAT Registered Y/N, Default Working Days, Timezone, Currency
2. **Payment Setup** — GoCardless integration, BACS/bank details
3. **Service Catalogue** — Add services (type, price, description)
4. **Round Settings** — Default cycle length, visit frequency options
5. **SMS/WhatsApp Templates** — Pre-built message templates for reminders, weather delays, etc.
6. **Technician Management** — Add technicians with name, role, contact
7. **Service Area** — Geographic areas served
8. **Assign Round** — Assign the first round to a technician

**Navigation:** Back / Continue buttons, "Step N of 8" — stepper and footer are now consistent.  
**26 frames** in this section cover each step's default + error/alternate states plus Edit Changes sub-flow.

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

---

### 14. Customers & Properties  
**Section:** `/Customers-Properties` · Node `401:12909`  
**Purpose:** Master customer list — browse all customers, see payment status and round assignment at a glance.  
**Elements:**
- Info banner (how-to-use tip)
- Summary row: Total Customers, Active, Payment Holds (red), Amount Due (amber)
- Rounds filter dropdown, Status filter dropdown
- Customer list rows: Name + status badge (Active / Hold), address, Round, Frequency, Price, Technician, Next Due date, Payment Status badge (paid / hold)
- Amount-due flag on hold rows (e.g. "£84 due")
- Chevron → Customer Detail

---

### 15. Customer Detail  
**Section:** `/Customers-Properties` · Node `401:13125`  
**Note:** Figma layers use both "Customers Details" and "Customer Details" interchangeably — same screen, naming is a Figma layer error.  
**Purpose:** Full property record for a single customer.  
**Elements:**
- Header: ← back, customer name + address, status badge, round badge, Edit / Pause Service / Send Message action buttons
- Two-column info block: Property Information (type, frequency, price, clean method, next due, last completed, assigned round, technician) + Payment & Status (payment status, outstanding balance, payment method, last payment, issues count, next visit status)
- Tab bar: Overview · Service Plan · Visit History · Payments · Notes & Risk · Photos (each tab is a distinct route)
- Overview tab: Property Details (address, type, access notes, risk notes) + Contact Information (name, phone, email)
- Visit History tab (other frame): date, price, notes icon, photos icon per visit row

**Interactions:** Edit → distinct route (Edit Customer). Pause Service → M9 modal. Send Message → distinct route. All six tabs are distinct routes. Generate Invoice → M4 modal (from visit row on Visit History tab).

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

### 23. Settings — Business Profile  
**Section:** `/Settings` · Node `401:18286`  
**Purpose:** Global business configuration, first sub-section of Settings.  
**Layout:** Two-column — left: settings nav, right: content panel.  
**Left nav items:** Business Profile · Payment Setup · Round Settings · SMS Templates · Technician Mgmt · Service Areas · Service Catalogue  
**Business Profile fields:** Business Name, Phone, Email, Service Area, Default Working Days (toggle buttons), Timezone dropdown, Currency dropdown. Edit / Save Changes buttons.

---

### 24. Settings — Service Catalogue  
**Section:** `/Settings` · Node `440:1889`  
**Purpose:** Manage the list of services offered (price + active/inactive toggle).  
**Elements:**
- + Add Area button
- Services table: Service name + category tags (Default, Window Cleaning, Gutter & Fascia, Exterior Cleaning, Specialist), description, Default Price, Active toggle, Edit / Delete actions
- Save Changes button

---

### 25. Technicians List  
**Section:** `/Technicians` · Node `695:14404`  
**Purpose:** Monitor team activity, performance, and round assignments.  
**Elements:**
- Date + Add Technician button
- Top KPIs: Active Now (green dot), Total Rounds, This Week's Revenue, Avg Rev/Hour
- Technician cards: avatar + name + role, status badge (In Progress / Completed), Rounds count, Today's Jobs (X/Y progress), Issues count (red), Revenue
- Assigned Rounds list (within card): round name, stop count, status badge, value
- Contact info row: phone, email, service areas
- Send Message / View Details action buttons

---

### 26. Technician Detail  
**Section:** `/Technicians` · Node `695:14580`  
**Purpose:** Full profile and performance record for a single technician.

---

### 27. Send Message to Technician  
**Section:** `/Technicians` · Node `695:14771`  
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

### 28. Add Technician  
**Section:** `/Technicians` · Node `695:14911`  
**Purpose:** Form to onboard a new technician to the system.

---

### 29. Edit Technician  
**Section:** `/Technicians` · Node `737:9645`  
**Purpose:** Edit an existing technician's details and assignments.

---

## Modals & Overlays

### M1 — Bulk Message Round  
**Triggered from:** Dashboard > Bulk Message quick action  
**Frames:** `733:13202`  
**Context:** Overlaid on the Dashboard (blurred background).  
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

### M2 — Add One-Off Job  
**Triggered from:** Dashboard > Add One-Off Job quick action  
**Frames:** `733:13907`  
**Context:** Overlaid on the Dashboard.  
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

### M4 — Generate Invoice  
**Triggered from:** Customer Detail > visit row action  
**Frames:** `534:35154`  
**Context:** Overlaid on the Customer Detail screen.  
**Elements:**
- Title: "Generate Invoice" + customer name + date
- Summary grid: Customer, Property, Visit Date, Amount (£35.00), Customer Email
- Invoice Number input (auto-generated, e.g. INV-2026-217)
- Notes textarea (optional)
- Payment Method info box (e.g. "Payment collected via GoCardless")
- "Also send to customer via email" checkbox + email preview
- Cancel / Preview Invoice / Generate & Send

---

### M5 — Preview Invoice  
**Triggered from:** Generate Invoice modal > Preview Invoice  
**Frames:** `540:36009`  
**Context:** Overlaid on Customer Detail.  
**Elements:** Rendered invoice preview. Download / Send actions.

---

### M6 — Add Property (Multi-step Wizard)  
**Triggered from:** Dashboard (implied) or Customers screen  
**Frames:** `442:5244` through `442:12302` (7 steps)  
**Context:** Full modal overlay on the Dashboard (dashboard visible in background).  
**Step indicator:** Vertical numbered stepper (steps 01–05 visible, scrollable).  
**Step 1 — Property Details:**
- Customer Name, Property Name (optional), Phone Number, Email (optional), Full Address, Postcode, Service Area dropdown, Property Type dropdown
- Back / Continue (Step 1 of 7)  
*Step 1 doubles as customer creation — no separate Add Customer flow exists. Subsequent steps cover service assignment, round assignment, payment setup, schedule, confirmation, and "Assign Property to Round" sub-flow (⚠️ TBD: behaviour when declining "Assign Property Now?" prompt is unresolved — see Open Questions #8).*

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

### M9 — Pause Service / Resume Service  
**Triggered from:** Customer Detail / Debt Board  
**Frames:** `401:17677` (Pause), `401:17984` (Resume)  
**Elements:** Reason selector, date, confirmation note, Cancel / Confirm.

---

### M10 — Invoice Generated (Debt Board)  
**Triggered from:** Debt Board customer card  
**Frames:** `453:12981`  
**Elements:** Success state showing invoice number, amount, send status.

---

### M11 — Download Confirmation  
**Triggered from:** Customer Detail > Payments tab  
**Frames:** `540:38369`, `592:4974` — single confirmation state reused in two contexts (not two distinct states).  
**Elements:** PDF/download confirmation with file name, Download / Cancel.

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

8. ⚠️ **TBD — "Assign Property Now?"** screen (442:11619): A full-screen prompt appearing within the Add Property flow, then transitioning to a Dashboard state (442:9643). Decline path behaviour is unresolved — does declining skip assignment entirely or queue it for later?

9. ~~**Download Confirmation**~~ — **Resolved.** Single confirmation state (M11) reused in two contexts; the two frames are not distinct states.

10. ~~**Complaint severity field**~~ — **Resolved.** Three levels: Low / Medium / High. No effect on list ordering; list is sorted by recency.

11. ~~**"Add Round" flow step count ambiguity**~~ — **Resolved.** Each numbered frame is a distinct wizard step (7 steps total). Step 2 is a single long scrollable step, not a separate screen.

12. ~~**Cycle vs. period terminology**~~ — **Resolved.** "Cycle" is used consistently throughout the UI; "Period" does not appear anywhere.
