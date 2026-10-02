# Mobile Design Findings — RoundFlow B2C (Technician App)

> Figma file: `RoundFlow-B2C` (key: `xfrwHHREaOuO5Jqd4fet8m`)
> Audit date: 2026-09-23

---

## Design Language

**Colour palette**
- Primary: Teal (`#1DAFB8` approx) — buttons, active tabs, status badges, progress steps, icons
- Background: Very light teal/cyan (`#EBF8F9` approx) — page background
- Card surface: White
- Danger: Red-coral — "Access issue" button, "Report access problem" CTA
- Warning: Amber — safety note icon
- Text: Near-black for headings, mid-grey for labels and secondary text

**Typography**
- Page titles: Bold, ~20px
- Section headings: Medium weight, ~14px uppercase label
- Body: ~14px regular
- Large numeric display (cash amount): ~36–40px bold

**Spacing / layout**
- Cards have 16px horizontal padding, rounded corners (~12px radius)
- Consistent 20px horizontal page margin
- Bottom sheets slide up from the bottom; pill handle at top; soft-shadow overlay

**Navigation / bottom bar**
- 5-tab bottom bar: Home · Search · Imagine · Message · Profile
- Home tab has a circular teal FAB overlay on it when on the home screen
- No visible tab indicator active styling beyond icon/label highlight

**Status badges**
- `Completed` — teal background
- `In Progress` — teal outline/text
- `Ready` — light grey with dot
- `Overdue` / debt state — red background (seen on Michelle Roe card on Home)

---

## Screens

### 1. Login (`459:2212`)
Clean, minimal auth entry point redesigned from the original brief.

- Heading: "Login Account"
- Social SSO: Google + Apple buttons (full-width, outlined)
- Divider: "or" separator
- Email + Password fields
- Primary CTA: "Sign in" (teal)
- Footer links: "Forgot Password?" and "Don't have an account? Sign up"

**Notable:** No invitation code flow in this screen — auth is standard SSO/email. Invitation is delivered via magic link (separate screen).

---

### 2. Enter Link (`459:1930`)
Shown after a technician is invited by admin via email.

- Instruction copy: "Your admin has sent you a secure magic link. Open the email and click the link to continue."
- Paste field for the link (for copy-paste fallback)
- Support text: "Account issues? Call the office on 01665 123 456"

**Notable:** The support phone number is hard-coded as placeholder copy. This should be the tenant's office number in production.

---

### 3. Forgot Password — Enter Email (`459:2001`)
- Email input field
- CTA: "Send Code" (teal)
- Back to Login link

---

### 4. Enter Code / OTP (`459:2033`)
- 4-digit OTP input
- Resend link
- Submit button

---

### 5. Reset Successful (`459:2095`)
- Success confirmation copy
- CTA: "Continue to Dashboard"
- "Back to Login" link

---

### 6. Account Created Successfully (`459:2144`)
- Confirmation message
- CTA: "Continue"
- "Back to Login" link

---

### 7. Home / Dashboard (`176:47`)
The primary landing screen after login. Designed as a daily work hub.

**Sections (top to bottom):**
1. **Greeting header** — "Hello, James!" with location "Alnwick, Northumberland", notification bell icon
2. **Quick Filters** — horizontal pill chips: "All Rounds", "Alnwick", "Morpeth" (more off-screen). Scroll to filter the content below
3. **Today's Round cards** — horizontal scroll cards showing round name (e.g. "Alnwick Monday"), date, progress bar (e.g. "2/5 complete"), with "Navigate" and "Track Jobs" buttons
4. **Search bar** — "Search properties…" with filter icon
5. **Current Job** — highlighted card showing CUSTOMER / SERVICE fields, a 4-step progress tracker (Navigate → Arrived → Working → Done), "Start Navigation" CTA inline
6. **All Jobs Today** — list of all assigned jobs with status badges. Icons: teal checkmark (completed), teal circle (in progress), numbered badge (ready/pending), warning icon (access issue/overdue)
7. **Recent Completions** — abbreviated list of recently completed jobs
8. **Stats bar** — `2 Done | 1 Active | 2 Pending`

**Notable:** The "Current Job" section only appears when the technician has an active visit in progress. The search bar persists on the page (not a separate screen).

---

### 8. Home — In Debt / Overdue State (`513:513`)
Same layout as above but with one job card showing a red "Overdue" (or similar alert) badge for Michelle Roe. The job is highlighted with a red status indicator rather than the standard teal. This triggers the "In Debt Flow" UX for that customer.

---

### 9. Track Jobs (`114:6899`)
Drill-down list of all jobs for a specific round.

- Back arrow + "Track Jobs" heading + job count badge (e.g. "5 jobs")
- Round subtitle: "Alnwick Monday · 7 Jul 2025"
- Search + filter controls
- Tab bar: **All 5 | Active 1 | Pending 2 | Completed 2 | Ski...** (skipped, truncated)
- Job cards: customer name, address, status badge (Completed / In-Progress / Ready), price, service name, a 4-dot progress indicator
- Tapping a card goes to Job Details

---

### 10. Track Jobs — Pending Filter (`119:8871`)
Same as above with "Pending 2" tab active, showing only Diane Pearson (Ready) and Alan Watts (Ready). Demonstrates the filtering UX.

---

### 11. Job Details — Ready (`475:536`)
The pre-visit detail view. Shown when a job has been dispatched but not yet started.

- Back arrow + "Details" heading + copy icon (top right)
- Location pin icon (map link placeholder)
- Status badge: `Ready`
- 4-step progress tracker (Navigate highlighted, rest greyed)
- **ACCESS NOTES** card — e.g. "All windows reachable from pavement."
- **Property Details** table: Customer, Address, Service, Price, Payment method, Last clean, Round
- **Open directions** row (links to maps)
- **Technician card** — technician name, role, chat + call icons
- **Activity log** — timestamped events
- CTA (bottom sticky): **"Start visit"** (teal, full-width)

---

### 12. Job Details — In Progress (`97:697`)
Same layout but status is `In Progress`. Sticky CTA becomes **"Continue visit"**.

Additional info cards visible:
- **SAFETY NOTE** (amber icon) — e.g. "Uneven cobblestone at rear. Ladder against brick wall only"
- **ACCESS NOTES** (teal icon) — gate code, instructions
- **PAYMENT DUE** (dollar icon) — e.g. "Cash payment due – £52. Confirm receipt before leaving."

---

### 13. Job Details — Completed (`116:7383`)
Status: `Completed`. Full progress bar filled. No sticky CTA. Activity log shows all 4 steps completed.

---

### 14. Active Visit (`323:743`)
The core during-visit screen. Technician sees this while on-site.

- Back arrow + "Active Visit" heading + `In Progress` badge
- **Customer name** (large) + address
- **SAFETY NOTE** card (amber)
- **ACCESS NOTES** card
- **PAYMENT DUE** card ($ icon) — cash/DD amount
- **Evidence Photos** section — two dashed-border placeholders: "Take Before Photo" / "Take After Photo"
- **Actions** (tappable rows):
  - "Add note for office" — internal, not visible to customer
  - "Record cash payment" — £xx due from customer
- **Bottom action bar**:
  - Left: "Skip job" (ghost text)
  - Right: "Access issue" (red outlined button)
  - Sticky CTA: **"Mark property complete"** (teal, full-width)

**Notable:** Photos are explicitly labelled "Photos are optional". Both before and after photos are captured in the same screen (not a separate photo flow screen).

---

### 15. Active Visit — Photos Added (`102:1068`)
Same screen after 2 before + 2 after photos have been taken. Thumbnails replace the dashed placeholders; `+ ` button allows adding more. "Photos are optional" copy remains.

---

### 16. BottomSheet — Before Photo Camera (`357:1267`)
Slides up from Active Visit when "Take Before Photo" is tapped.

- Title: "Before photo" + X dismiss
- Large dashed camera preview area ("Camera preview" placeholder)
- Thumbnail strip (last photo from camera roll for reference)
- CTA: **"Take photo"** (teal)
- "Cancel" text link

---

### 17. BottomSheet — Before Photo Saved (`357:1465`)
After a photo is taken.

- Title: "Before photo" + X dismiss
- Teal checkmark + "Photo saved"
- CTA: **"Take another photo"**
- "Done (2 photos)" text link (underlined)

---

### 18. BottomSheet — After Photo Camera (`359:2506`)
Identical layout to Before Photo but titled "After photo".

---

### 19. BottomSheet — After Photo Saved (`367:2776`)
Identical to Before Photo Saved but titled "After photo".

---

### 20. BottomSheet — Add Note for Office (`357:2231`)
- Title: "Add note for office" + X dismiss
- Info banner: "Internal only — not visible to the customer."
- Multiline text area: placeholder "e.g. Conservatory panels needed extra attention…"
- CTA: **"Save note"** (teal)
- "Cancel" text link

---

### 21. BottomSheet — Record Cash Payment (`102:4248`)
- Title: "Record cash payment" + X dismiss
- Large bold amount: **£52**
- Customer name below
- Info row: "Confirm you've received £52 in cash before tapping confirm."
- CTA: **"Confirm £52 received"** (teal)
- "Cancel" text link

**Notable:** The amount is shown large and bold — clearly deliberate to prevent mistaken confirmation.

---

### 22. BottomSheet — Skip This Property (`367:3512` / `367:3192`)
Two states captured — one with "Other" selected (shows description field), one with "Gate locked" selected (no description field).

- Title: "Skip this property" + X dismiss
- Subtitle: "Skipping **[Customer Name]** — select a reason. The office will be notified."
- Radio options: Customer not home / Gate locked / Dog on premises / Customer refused / Unsafe conditions / Other
- Description field (required, shown only for "Other"): "What prevented access?"
- CTA: **"Confirm skip"** (teal)
- "Cancel" text link

---

### 23. BottomSheet — Report Access Problem (`367:3849`)
- Title: "Report access problem" + X dismiss
- Subtitle: "**[Customer Name]** — the office will contact the customer."
- Radio options: Gate locked / Dog loose / No rear access / Unsafe conditions / Wrong address / Other
- Description field (required): "What prevented access?"
- CTA: **"Report access problem"** (red/coral — danger action)
- "Cancel" text link

**Notable:** This is the only CTA in the app that uses red — signals a serious/escalation action distinct from the skip flow.

---

### 24. BottomSheet — Complete This Property? (`367:4009`)
Confirmation before marking a visit complete.

- Title: "Complete this property?" + X dismiss
- Summary table: Customer / Service / Price
- Info row: "Completing this visit notifies the customer and triggers payment collection."
- CTA: **"Confirm completion"** (teal)
- "Not yet" text link

---

### 25. Job Complete (`367:4271`)
Full-screen success state after confirming completion.

- Large teal circular checkmark (prominent, centred)
- Label: "JOB COMPLETE"
- Customer name (large)
- Address
- **NEXT PROPERTY** card: next customer name, address, round position badge (#4)
- CTA: **"Go to next property >"** (teal, full-width)
- Secondary link: "View round overview"

---

### 26. Notifications (`92:525`)
- Back arrow + "Notifications" heading
- Notification cards in reverse-chronological order
- Each card: icon (warning/info/check), bold title, subtitle with customer/round info, timestamp
- Unread indicator: orange/teal dot (top-right of card)
- Types seen: "Round updated" (amber), "Round dispatched" (teal), "Alnwick Tuesday set" (read/grey), "Payment confirmed" (teal check)

---

### 27. Completions (`421:280`)
Revenue summary screen (accessed from Home or bottom nav).

- Back arrow + "Completions" heading
- **Revenue card**: gradient teal background, "Your revenue", large £ amount (e.g. £58.00), eye toggle (hide/show), period filter dropdown ("Today"), round + date label, percentage change vs prior period
- Stats row: `2 Completed | 0 Skipped | 5 Total`
- **Recent Activity** list — job cards: customer, address, status badge, SERVICE / AMOUNT columns, timestamp + payment method, "View details" link

---

### 28. Settings (`611:406`)
- Back arrow + "Settings" heading
- **Account** section: Edit profile / Security / Notifications / Privacy
- **Support & About**: My Subscription / Help & Support / Terms and Policies
- **Actions**: Report a problem / Add account / Log out

---

## Component Patterns

| Component | Description |
|-----------|-------------|
| Progress tracker | 4-step horizontal stepper (Navigate → Arrived → Working → Done), teal filled circles for completed steps |
| Status badge | Small pill chip, teal (completed/active), grey (ready), red (overdue/debt) |
| Bottom sheet | Slides up with pill handle, dimmed overlay behind, always has X dismiss + Cancel link |
| Job card | White card, customer name + address, service, price, status badge, progress dots |
| Info note card | Icon (amber/teal/$) + label + body text, light tinted background |
| Action row | Full-width tappable row with title, subtitle, and chevron > |
| CTA button | Teal, rounded, full-width, always pinned to bottom of screen or sheet |
| Evidence photo slot | Dashed border placeholder, icon + label, replaced by thumbnail after capture |
