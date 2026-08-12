# Reports & History — Backend Handoff

## Auth

All endpoints require:
- `requireAuth` — valid JWT session
- `requireTenantAccess` — resolves `req.tenantPrisma`
- `requireRole("ADMIN", "MANAGER")`

---

## Endpoints

### GET /reports/summary

KPI tiles for the dashboard header.

**Query params:**

| Param | Values | Default |
|-------|--------|---------|
| `period` | `today` \| `last7` \| `last30` | `last30` |

**Response:**

```json
{
  "totalRevenue": 1820.00,
  "completedVisits": 52,
  "completedRounds": 4,
  "undonePayments": 315.00
}
```

- `totalRevenue` — sum of prices for COMPLETED visits in period
- `completedVisits` — count of COMPLETED visits in period
- `completedRounds` — distinct rounds that had at least one COMPLETED visit in period
- `undonePayments` — sum of all SENT invoice amounts (not period-filtered)

---

### GET /reports/revenue

Revenue chart data, grouped by day.

**Query params:**

| Param | Values | Default |
|-------|--------|---------|
| `period` | `today` \| `last7` \| `last30` | `last30` |
| `granularity` | `daily` | `daily` |

**Response:**

```json
[
  { "date": "2026-08-01", "amount": 245.00 },
  { "date": "2026-08-02", "amount": 180.00 }
]
```

---

### GET /reports/technicians

Per-technician performance breakdown.

**Query params:**

| Param | Values | Default |
|-------|--------|---------|
| `period` | `today` \| `last7` \| `last30` | `last30` |

**Response:**

```json
[
  {
    "technicianId": "cm8abc",
    "name": "James",
    "email": "james@example.com",
    "completed": 24,
    "skipped": 3,
    "efficiency": 89,
    "revenueImpact": 840.00
  }
]
```

- `efficiency` — `Math.round(completed / (completed + skipped) * 100)`
- `revenueImpact` — sum of COMPLETED visit prices for this technician

---

### GET /reports/visits

Pageable visit log for the history table.

**Query params:**

| Param | Values | Default |
|-------|--------|---------|
| `period` | `today` \| `last7` \| `last30` | `last30` |
| `status` | `COMPLETED` \| `SKIPPED` \| `SCHEDULED` | (all) |

**Response:**

```json
[
  {
    "visitId": "cm8xyz",
    "date": "2026-08-08T09:00:00.000Z",
    "property": "12 Castle View",
    "postcode": "NE61 1AB",
    "round": "Alnwick Monday",
    "technician": "James",
    "status": "COMPLETED",
    "amount": 35.00
  }
]
```

---

### GET /reports/activity

Activity log feed (audit trail).

**Query params:**

| Param | Description |
|-------|-------------|
| `type` | Filter by event type (e.g. `PROPERTY_ADDED`, `ROUND_UPDATED`) |

**Response:**

```json
[
  {
    "id": "cm8log1",
    "type": "PROPERTY_ADDED",
    "message": "Property added: 18 Green Lane",
    "actorRole": "Admin",
    "createdAt": "2026-08-08T10:30:00.000Z"
  }
]
```

Up to 100 entries, ordered by `createdAt DESC`.

---

## logActivity Helper

`createReportsService(prisma).logActivity(type, message, actorId?, actorRole?)` writes an `ActivityLog` row.

Call it from any other route handler where you want an audit trail:

```typescript
const svc = createReportsService(req.tenantPrisma);
await svc.logActivity("PROPERTY_ADDED", `Property added: ${addressLine}`, req.profile.id, req.profile.role);
```

### Recommended event types

| Type | Where to wire |
|------|---------------|
| `PROPERTY_ADDED` | POST /properties |
| `ROUND_UPDATED` | PATCH /rounds/:id |
| `TECHNICIAN_ASSIGNED` | POST /rounds/:id/technicians |
| `VISITS_GENERATED` | POST /rounds/:id/generate |
| `DAY_CLOSED` | POST /today/close |

---

## Schema Changes

| Migration | Change |
|-----------|--------|
| `20260812000001_customer_hold_next_clean` | `Customer.holdNextClean Boolean DEFAULT false` |
| `20260812000002_activity_log_actor` | `ActivityLog.actorId TEXT`, `ActivityLog.actorRole TEXT` |

---

## Period Ranges

| Value | Range |
|-------|-------|
| `today` | midnight today → now |
| `last7` | 7 days ago → now |
| `last30` | 30 days ago → now |
