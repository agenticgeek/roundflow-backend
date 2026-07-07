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
- **⟳ Update (2026-07-07):** technician cards/table now show an **App Status** column with an availability state — **Active** vs **Unavailable** (e.g. *"On leave 14 July 2026 — N jobs require reassignment"*). Marking a technician Unavailable flags their upcoming recurring jobs for reassignment (surfaced on Round Planner banner + Screen 30). Status pills observed: `● In Progress`, `✓ Active`, `Unavailable`. See change #2 in the Design Update Log and Open Question #13.

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
