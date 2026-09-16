# GHL Automation Owner Handoff

> **Audience:** The person setting up GHL-side workflows and custom fields (not a developer task).
> **Scope:** Everything you need to configure inside GoHighLevel so RoundFlow can send messages through it.

---

## 1. Custom Fields to Create

Create these as **Contact custom fields** inside each RoundFlow sub-account. Use the exact key names shown — the backend writes to these keys by name.

| Field Label | Key (internal name) | Type | Set by |
|---|---|---|---|
| Last Clean Date | `last_clean_date` | Date | When a job is completed |
| Next Clean Date | `next_clean_date` | Date | When next visit is scheduled |
| Balance Owed | `balance_owed` | Number | When invoice raised or payment collected |
| Round Name | `round_name` | Text | When a job is completed |
| Technician Name | `technician_name` | Text | When a job is completed |

> If you're using a GHL snapshot for new sub-accounts, add these fields to the snapshot so they're pre-created on every new RoundFlow client account.

---

## 2. Tags RoundFlow Writes

These tags are added by RoundFlow. Build your GHL Workflows to trigger on them.

| Tag | When added | When removed |
|---|---|---|
| `visit-completed` | Job marked complete by technician | — |
| `debt-overdue` | Customer balance goes overdue | When payment collected (`payment.collected` event) |
| `has-open-complaint` | Complaint logged in RoundFlow | When complaint is resolved |
| `payment-failed` | GoCardless payment fails (Zapier → RoundFlow → GHL) | When payment is retried and confirmed |

---

## 3. GHL Workflows to Build

### Workflow 1 — Pre-Clean Reminder
- **Trigger:** `next_clean_date` = today (date-based trigger, fires same day or day before — your call on timing)
- **Action:** Send SMS / WhatsApp — e.g. *"Hi [name], your window clean is scheduled for tomorrow. Let us know if anything changes."*

### Workflow 2 — Job Complete Notification
- **Trigger:** Tag `visit-completed` added to contact
- **Action 1:** Send SMS / WhatsApp / Email — *"Your windows have been cleaned today. A payment of £[balance_owed] is being collected by Direct Debit and will leave your account within 3 working days."*
- **Action 2:** Remove `visit-completed` tag (keep the contact clean)
- Note: GoCardless charge is created by RoundFlow backend automatically — no Zapier action needed here

### Workflow 3 — Debt Chase Sequence
- **Trigger:** Tag `debt-overdue` added to contact
- **Action:** Multi-step chase — Day 1 friendly reminder, Day 3 follow-up, Day 7 escalation. Mark decides the cadence.
- **Stop condition:** Tag `debt-overdue` is removed (RoundFlow removes it when payment is collected)

### Workflow 4 — Payment Failed Chase
- **Trigger:** Tag `payment-failed` added to contact
- **Action:** Send SMS / WhatsApp — *"We were unable to collect your payment of £[balance_owed]. Please contact us to arrange payment."*
- **Follow-up:** Escalating chase sequence over the next few days (same as debt chase, coordinate with Mark on wording)

### Workflow 5 — Lead Handoff to RoundFlow
- **Trigger:** Contact tagged `ready-for-roundflow` (or reaches a specific pipeline stage — whichever you prefer)
- **Action:** Webhook — POST to the RoundFlow webhook URL (see Section 4)

---

## 4. Webhook URL (Lead Handoff)

When a lead is ready to come into RoundFlow, GHL sends a webhook. You'll get the exact URL from the backend team once the GHL connection is set up — it will look like:

```
POST https://api.roundflow.ai/webhooks/ghl?tenantId=<TENANT_ID>&secret=<TENANT_SECRET>
```

The `tenantId` and `secret` are generated when the tenant connects their GHL account in RoundFlow Settings. The backend team will give you these values per sub-account at connection time.

### Payload

GHL's standard webhook body is fine — RoundFlow reads:

```json
{
  "contactId": "abc123",
  "firstName": "John",
  "lastName": "Smith",
  "email": "john@example.com",
  "phone": "+447700123456",
  "address1": "123 High Street",
  "city": "London",
  "postalCode": "SW1A 1AA"
}
```

Send whatever GHL includes in the contact object — the backend extracts what it needs.

> **Important:** GHL retries webhooks if it doesn't get a `200 OK` response within ~20 seconds. The backend acknowledges immediately and processes async, so retries are handled safely.

---

## 5. WhatsApp

Mark's existing GHL sub-accounts already have WhatsApp Business approved through Meta. When setting up a **new** RoundFlow client sub-account, WhatsApp approval must be done before the chase and reminder workflows can send WhatsApp messages. SMS and email work immediately without any approval. Plan around a 1–7 day Meta approval window for new sub-accounts.

---

## 6. GoCardless — Deploy Cutover (Mark's account only)

> **⚠️ This applies to Mark Coates's account specifically.** GoCardless charges are currently being created via a Zapier automation. RoundFlow takes over charge creation entirely using the GoCardless SDK. The Zapier flow must be **disabled at the exact moment** RoundFlow's GoCardless integration goes live — not before (payments stop), not after (customers get double-charged).

Coordinate with Mark and the backend team:
1. Backend confirms GoCardless integration is deployed and tested on staging
2. You (automation owner) disable the Zapier GoCardless scenario on Mark's account
3. Backend team enables the live `POST /webhooks/gocardless` endpoint
4. Monitor for 48 hours to confirm no missed or duplicate charges

After cutover, GoCardless is fully managed by RoundFlow. No Zapier involvement in payments.

---

## 7. Snapshot Checklist

Before going live with a new RoundFlow client, confirm the following are in their GHL sub-account:

- [ ] All 5 custom fields created (Section 1)
- [ ] All 5 workflows built and active (Section 3)
- [ ] Webhook URL configured in the lead handoff workflow (Section 4) with the correct `tenantId` + `secret` from backend
- [ ] WhatsApp approved (or workflows set to SMS/Email fallback until approved)
- [ ] **For Mark's account only:** Zapier GoCardless scenario disabled at cutover (Section 6)
- [ ] Test contact run through the full sequence end-to-end before going live

---

## 8. Coordination with Backend

The backend needs two things from you before it can go live with a sub-account:

1. **Custom field IDs** — once you create the fields in GHL, the backend fetches the field IDs automatically via the GHL API. Nothing to hand over manually.
2. **Webhook URL confirmation** — confirm you've pasted the correct webhook URL into the lead handoff workflow (Section 4). The backend team will tell you the URL when the tenant connects.

Backend will give you back:
- The `tenantId` and `secret` for each sub-account's webhook URL
- A test payload you can use to trigger the lead handoff manually and confirm RoundFlow receives it
