# Mobile Flows — RoundFlow B2C (Technician App)

> Describes the complete user journeys through the technician mobile app.
> Figma file: `RoundFlow-B2C` (key: `xfrwHHREaOuO5Jqd4fet8m`)

---

## Flow 1 — Onboarding via Magic Link (Invited Technician)

Admin sends invite from the web dashboard → technician receives email with magic link.

```
[Email with magic link]
    ↓ tap link
Enter Link screen
    ↓ link auto-fills / paste fallback
Account Created Successfully
    ↓ "Continue"
Home / Dashboard
```

**Notes:**
- The tech does not set a password on first login — the magic link authenticates them directly.
- If link expires or fails: "Account issues? Call the office on 01665 123 456"

---

## Flow 2 — Standard Email/Password Login

```
Login screen
    ↓ enter email + password → "Sign in"
Home / Dashboard

    OR
    ↓ "Forgot Password?"
Forgot Password — enter email
    ↓ "Send Code"
Enter Code — 4-digit OTP
    ↓ submit code
Reset Successful
    ↓ "Continue to Dashboard"
Home / Dashboard
```

**Notes:**
- Google and Apple SSO are also available from the Login screen.

---

## Flow 3 — Starting the Day (Home → Round → Job)

```
Home / Dashboard
    ↓ See Today's Round card ("Alnwick Monday")
    ↓ tap "Navigate" → opens device maps to first property
    OR
    ↓ tap "Track Jobs" → Track Jobs screen
        ↓ see all 5 jobs with statuses (Active/Pending/Completed/Skipped)
        ↓ tap a job card
Job Details — Ready
    ↓ review: Access Notes, Property Details, Payment method, Technician
    ↓ "Start visit" (sticky CTA)
Active Visit screen
```

**Notes:**
- The Home screen "Current Job" section appears once a visit is started.
- "All Jobs Today" list on Home gives a summary view without going into Track Jobs.

---

## Flow 4 — Completing a Visit (Standard)

```
Active Visit
    ↓ review Safety Note / Access Notes / Payment Due
    ↓ (optional) take before photo → Before Photo sheet → "Take photo"
        ↓ photo saved → "Done" or "Take another photo"
    ↓ (optional) take after photo → After Photo sheet
    ↓ (optional) "Add note for office" → Note sheet → text → "Save note"
    ↓ "Mark property complete"
        ↓ BottomSheet: "Complete this property?"
        ↓ review summary (Customer / Service / Price)
        ↓ "Confirm completion"
Job Complete screen
    ↓ "Go to next property >"   → Active Visit for next property
    OR
    ↓ "View round overview"     → Track Jobs
```

**Backend trigger:** Confirming completion calls `PATCH /visits/:id/complete`. For GoCardless customers with an active mandate, payment is auto-collected. For Direct Debit, the notification is sent.

---

## Flow 5 — Recording Cash Payment

```
Active Visit
    ↓ see PAYMENT DUE: "Cash payment due – £52."
    ↓ tap "Record cash payment" action row
        ↓ BottomSheet: "Record cash payment"
        ↓ large £52 amount displayed
        ↓ "Confirm you've received £52 in cash before tapping confirm."
        ↓ "Confirm £52 received"
    ↓ sheet closes (payment recorded)
    ↓ continue with "Mark property complete"
```

**Notes:**
- The cash confirmation must happen before completing the visit (or as part of the complete flow).
- Backend: `cashConfirmed: true` is sent with `PATCH /visits/:id/complete`.

---

## Flow 6 — Skipping a Property

```
Active Visit
    ↓ "Skip job" (ghost button in bottom bar)
        ↓ BottomSheet: "Skip this property"
        ↓ Skipping [Customer] — select a reason:
            • Customer not home
            • Gate locked
            • Dog on premises
            • Customer refused
            • Unsafe conditions
            • Other (shows description field)
        ↓ "Confirm skip"
[Returns to Home or next property]
```

**Notes:**
- The office is automatically notified on skip.
- "Other" reason requires a description before confirming.
- Skipped visits appear in the "Skipped" tab of Track Jobs and in Completions (0 Skipped count).

---

## Flow 7 — Reporting an Access Problem

```
Active Visit
    ↓ "Access issue" (red button in bottom bar)
        ↓ BottomSheet: "Report access problem"
        ↓ [Customer] — the office will contact the customer.
        ↓ Select reason:
            • Gate locked
            • Dog loose
            • No rear access
            • Unsafe conditions
            • Wrong address
            • Other
        ↓ Description field: "What prevented access?"
        ↓ "Report access problem" (red CTA — escalation action)
[Visit remains incomplete; office is alerted to contact customer]
```

**Notes:**
- This is distinct from Skip: "Access issue" triggers an office-to-customer contact chain. "Skip" is a silent technician action.
- The red CTA reinforces the severity of this action vs the standard teal CTA.

---

## Flow 8 — Evidence Photo Sub-Flow

Triggered from Active Visit by tapping either photo slot.

```
Active Visit — "Take Before Photo" slot
    ↓ Before Photo sheet opens
    ↓ Camera preview displayed
    ↓ (gallery thumbnail shown for reference)
    ↓ "Take photo"
        ↓ Photo saved confirmation: "Photo saved" (teal checkmark)
        ↓ "Take another photo" — loops back to camera
        ↓ "Done (2 photos)" — closes sheet, thumbnails appear in visit screen
    ↓ Repeat for "Take After Photo"
```

**Notes:**
- Photos are optional — the visit can be completed without them.
- Before and after photos are separate slots but the same camera sheet with different labels.
- The thumbnail strip in the sheet shows camera roll for quick reference.

---

## Flow 9 — Adding an Internal Note

```
Active Visit
    ↓ "Add note for office" action row
        ↓ BottomSheet: "Add note for office"
        ↓ Info: "Internal only — not visible to the customer."
        ↓ Text area (e.g. "Conservatory panels needed extra attention…")
        ↓ "Save note"
    ↓ Sheet closes; note is saved internally
```

**Notes:**
- Notes are internal only (not sent to customer).
- Multiple notes can presumably be added (no UI restriction shown).

---

## Flow 10 — Viewing Notifications

```
Home → bell icon (top right) OR notifications entry point
    ↓
Notifications screen
    ↓ Scroll through reverse-chronological list
    ↓ Types:
        • Round updated — orange dot (unread)
        • Round dispatched — teal dot (unread)
        • Alnwick Tuesday set — grey (read)
        • Payment confirmed — grey (read)
```

**Notes:**
- Unread indicator is a coloured dot top-right of card.
- Read notifications are greyed out but remain visible.
- No "mark all read" control visible in this design.

---

## Flow 11 — Viewing Completions / Revenue

```
Home → "See all" on Recent Completions
    OR  bottom nav → Completions
    ↓
Completions screen
    ↓ Revenue card (teal gradient):
        • £58.00 total
        • Alnwick Monday · 7 Jul 2025
        • +14.2% vs prior period
        • Period filter: "Today" dropdown
    ↓ Stats: 2 Completed | 0 Skipped | 5 Total
    ↓ Recent Activity list:
        • Sarah Brown — £28 — Direct Debit — 10:45 AM
        • Mary Johnson — £30 — Direct Debit — 10:45 AM
        ↓ "View details" → Job Details — Completed
```

---

## Flow 12 — Viewing Settings

```
Home → Profile tab (bottom nav)
    ↓ Settings screen
        • Account: Edit profile / Security / Notifications / Privacy
        • Support & About: My Subscription / Help & Support / Terms and Policies
        • Actions: Report a problem / Add account / Log out
```

---

## Flow 13 — Track Jobs Deep Dive

```
Home → "Track Jobs" on round card  OR  "See all" on All Jobs Today
    ↓
Track Jobs (round-specific list)
    ↓ Tabs: All | Active | Pending | Completed | Skipped
    ↓ Search / filter
    ↓ Tap a job card
        → Job Details — Ready (not started)
        → Job Details — In Progress (visit started)
        → Job Details — Completed (visit done)
```

---

## Flow 14 — In Debt / Overdue Customer Flow

Triggered when a customer has an overdue payment (shown with red badge on Home job card).

```
Home
    ↓ See red "Overdue" badge on Michelle Roe's job card
    ↓ Tap card → [In Debt Flow screens in Figma section "In Debt Flow"]
    ↓ Technician sees debt status prominently before the visit
```

**Notes:**
- The overdue state is surfaced on the Home dashboard — technician is aware before starting.
- Exact in-debt flow screens (547:xxxx series) contain debt-specific bottom sheets — these were not fully captured in this audit but the Home variant (`513:513`) confirms the entry point.

---

## Screen → API Endpoint Map

| Screen / Action | API Call |
|-----------------|----------|
| Login | Supabase auth |
| Magic link accept | Supabase magic link |
| Home load | `GET /rounds/today`, `GET /visits?date=today` |
| Track Jobs | `GET /visits?roundId=X` |
| Job Details | `GET /visits/:id` |
| Start visit | `PATCH /visits/:id` (status → IN_PROGRESS) |
| Take photo | `POST /visits/:id/photos` |
| Add note | `POST /visits/:id/notes` |
| Record cash | included in complete call (`cashConfirmed: true`) |
| Mark complete | `PATCH /visits/:id/complete` |
| Skip property | `PATCH /visits/:id/skip` |
| Report access issue | `POST /visits/:id/access-issue` |
| Notifications | `GET /notifications` |
| Completions | `GET /reports/completions?date=today` |
