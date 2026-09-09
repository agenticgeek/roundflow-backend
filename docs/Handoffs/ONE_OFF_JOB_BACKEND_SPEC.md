# Backend Spec — Add One-off Job (`POST /visits`)

> **For the implementing agent.** Everything you need is in this file. Read
> §2 before writing code — the schema already supports this feature and the
> main risk is re-inventing something that exists.

---

## 1. What we're building

The "Add One-off Job" Quick Action (sidebar, present on Round Planner and
Today's Work) needs to create a **single ad-hoc Visit** — an extra clean that
isn't part of a round's recurring schedule. Examples: a one-time gutter clean,
a make-good visit after a complaint, a paid extra a customer rang in for.

There is currently **no endpoint in the codebase that creates a Visit** outside
the setup wizard. That is the entire gap.

---

## 2. What already exists — do not rebuild these

### 2.1 The schema is already ready. No migration needed.

`Visit` in `prisma/tenant/schema.prisma` already has everything:

```prisma
model Visit {
  id            String         @id @default(cuid())
  date          DateTime
  status        VisitStatus    @default(SCHEDULED)
  paymentHold   Boolean        @default(false)
  price         Decimal        @db.Decimal(10, 2)
  isOneOff      Boolean        @default(false)   // ← already here, written by NOTHING
  serviceId     String?
  notes         String?
  skipReason    String?
  completedAt   DateTime?
  propertyId    String                            // ← only required FK
  roundId       String?                           // ← nullable
  servicePlanId String?                           // ← nullable
  technicianId  String?
  paymentMethod PaymentMethod?
  ...
}
```

**`isOneOff` is declared and never assigned anywhere in `src/`** (grep it — zero
hits). It was clearly added in anticipation of this feature. Use it. Do not add
a new column, a new model, or a new enum value.

`roundId` and `servicePlanId` being nullable is what makes a standalone one-off
possible.

### 2.2 The only existing visit-creation code

`SetupService.generateSchedule()` — `src/services/setup.service.ts:906`, a
`visit.createMany()` that bulk-generates the recurring cycle. Reachable only via
`POST /setup/step/11`, which is gated behind `assertSetupIncomplete()`, so it
returns 4xx once a tenant is live. **Read it for reference, don't extend it.**

### 2.3 Downstream consumers — these work for free once the row exists

Do not touch any of these. They all query `Visit` directly and will pick up a
one-off with no changes:

| Consumer | Why it works |
|---|---|
| `GET /today` (`today.service.ts`) | Queries all visits by date range; no round filter. |
| `GET /rounds/:id/today` | Filters `roundId` — a one-off appears **only if** `roundId` is set. |
| `GET /rounds/:id/planner/occurrences[/:date]` | Same: filters `roundId`. See §6. |
| `GET /invoices/preview?visitId=` + `POST /invoices` | Uses `visit.price`, `visit.property.customer`, `visit.service?.name` (falls back to `"Window Cleaning Service"`), `visit.round?.name` (optional). **No `servicePlan` dependency** — verified in `invoice.service.ts:290-330`. |
| `GET /reports/visits` | Filters by date only. |
| Debt board | Works off Invoices, not Visits. |

---

## 3. Files to create / change

| File | Action |
|---|---|
| `src/services/visit.service.ts` | **New.** `IVisitService` + `VisitService` class + `createVisitService(prisma)` factory. |
| `src/routes/visits.ts` | **New.** Thin router — validate → call service → respond. |
| `src/index.ts` | Add `import { visitsRouter }` and `app.use("/visits", visitsRouter)` alongside the others (~line 60). |
| `src/services/__tests__/visit.service.test.ts` | **New.** Vitest, mocked Prisma. |
| `src/swagger.ts` | Add the `/visits` path + `Visit`/`VisitCreateInput` schemas. |

---

## 4. Endpoint contract

```
POST /visits
Authorization: Bearer <supabase_access_token>
Content-Type: application/json
```

**Auth:** `requireAuth` → `requireTenantAccess` → `requireBusinessAccess()`.
That last one gives reads to any role and mutations to `ADMIN`/`MANAGER` only —
same as the rounds and properties routers. A `TECHNICIAN` POSTing gets `403`.

### Request body

| Field | Type | Required | Rules |
|---|---|---|---|
| `propertyId` | string | **yes** | Must exist → else `404 "Property not found"`. |
| `date` | string `YYYY-MM-DD` | **yes** | Stored as midnight **UTC** (`new Date(\`${date}T00:00:00.000Z\`)`) — every other date in this codebase is UTC-midnight; matching it is what makes the visit show up in the planner and Today buckets. |
| `price` | number | **yes** | `> 0`, max `9999.99`. |
| `serviceId` | string \| null | no | Must exist and be `active: true` → else `404`. |
| `technicianId` | string \| null | no | Must exist → else `404`. |
| `roundId` | string \| null | no | Must exist → else `404`. Default `null`. See §6. |
| `notes` | string \| null | no | Free text. |
| `paymentMethod` | enum \| null | no | `GOCARDLESS \| STRIPE \| CASH \| BACS \| CHEQUE`. |

Server always sets: `isOneOff: true`, `status: SCHEDULED`, `servicePlanId: null`,
`paymentHold: false`. **These are not client-settable.**

### Responses

- `201` — the created visit (shape in §5).
- `400` — validation failure (missing/!typed field, bad date format, price ≤ 0 or > 9999.99, unknown enum value).
- `403` — caller is a `TECHNICIAN`.
- `404` — `propertyId` / `serviceId` / `technicianId` / `roundId` not found.

### Example

```json
POST /visits
{
  "propertyId": "cle123...",
  "date": "2026-09-03",
  "price": 45.00,
  "serviceId": "csv456...",
  "technicianId": "ctn789...",
  "roundId": null,
  "notes": "One-off gutter clean — customer rang in",
  "paymentMethod": "CASH"
}
```

---

## 5. Response shape

```json
{
  "id": "clv...",
  "date": "2026-09-03",
  "status": "SCHEDULED",
  "isOneOff": true,
  "price": 45,
  "notes": "One-off gutter clean — customer rang in",
  "paymentMethod": "CASH",
  "propertyId": "cle...",
  "addressLine": "12 Market Street",
  "postcode": "NE66 1SS",
  "customerId": "cld...",
  "customerName": "John Smith",
  "roundId": null,
  "roundName": null,
  "serviceId": "csv...",
  "serviceName": "Gutter Clean",
  "technicianId": "ctn...",
  "technicianName": "James Fisher"
}
```

**`price` must be a number, not a string.** Prisma returns `Decimal` — call
`.toNumber()`. This matches the customers/planner responses; the Settings
service is the odd one out and returns strings. Do not copy Settings here.

`date` is `YYYY-MM-DD` (`.toISOString().slice(0, 10)`), consistent with the
planner and `GET /today`.

---

## 6. The one real design decision: `roundId`

A one-off with `roundId: null` will **not** appear in Round Planner, because
`listOccurrences` and `getOccurrence` both filter `where: { roundId }`
(`round.service.ts:341`, `:395`). It *will* appear in `GET /today`, which has no
round filter.

Ship it as: **`roundId` optional, defaults to `null`.** The UI can offer
"attach to a round" so the technician sees it on their round day. That's the
flexible option and needs no planner changes.

If a standalone one-off must also show in the planner calendar, that requires a
separate change to the planner queries — **out of scope here.** Flag it, don't
do it.

---

## 7. Code patterns to follow

Match `src/services/round.service.ts` exactly:

- Exported `interface VisitCreateInput` and output interface at the top of the file.
- `interface IVisitService` declaring the methods (OCP seam the codebase uses everywhere).
- `class VisitService implements IVisitService` with `constructor(private readonly prisma: TenantPrismaClient) {}`.
- `export function createVisitService(prisma: TenantPrismaClient): IVisitService` at the bottom.
- Methods are **`profileId`-first** (`create(profileId: string, input: VisitCreateInput)`) even though it's unused today — Phase 2 extensibility, every service does this.
- Throw `new AppError(status, message)` from `src/lib/app-error.ts`. Never `res.status().json()` from the service.
- Import enums from `../generated/tenant-client`, **not** `@prisma/client` (that's the public/control-plane schema; tenant enums live in the generated tenant client).

Route file — copy the header of `src/routes/rounds.ts` verbatim:

```ts
export const visitsRouter = Router();
visitsRouter.use(requireAuth);
visitsRouter.use(requireTenantAccess);
visitsRouter.use(requireBusinessAccess());

const actorIdOf = (req: Request): string => req.user!.supabaseUserId;
const svc = (req: Request) => {
  if (!req.tenantPrisma) throw new AppError(500, "Tenant client not initialised");
  return createVisitService(req.tenantPrisma);
};
```

Wrap every handler in `h(...)` from `src/lib/http.ts` — Express 4 does not
auto-catch rejected promises, and skipping `h` turns a 400 into a hung request.

**Use the existing validators. Do not hand-roll type checks:**

- `src/lib/http.ts` — `asObject`, `requireString`, `requireNumber`, `optString`, `optId`, `optNumber`
- `src/lib/validation.ts` — `assertPositive(v, field, max)`, `optPaymentMethod(v)`

`optId` is the right helper for the nullable FKs — it maps `""` → `null` rather
than treating an empty string as a literal id.

For the date, follow the guard already used in `rounds.ts:105-118`: regex-test
`/^\d{4}-\d{2}-\d{2}$/`, `400` if it fails, then build the UTC Date.

### Activity logging

Follow the fire-and-forget pattern used in `rounds.ts` and `properties.ts`:

```ts
void createReportsService(req.tenantPrisma!).logActivity(
  "ONE_OFF_JOB_ADDED",
  `One-off job added: ${input.date} — ${property.addressLine}`,
  req.profile?.id,
  req.profile?.role ?? undefined,
);
```

`ActivityLog.type` is a plain `String` column, **not** an enum — no migration
needed for the new type value. Note the `void` prefix: logging must never block
or fail the response.

---

## 8. Tests

`src/services/__tests__/visit.service.test.ts`, Vitest with a hand-mocked
Prisma — copy the `makePrisma()` pattern from
`src/services/__tests__/round.service.test.ts`:

```ts
function makePrisma() {
  return {
    visit: { create: vi.fn() },
    property: { findUnique: vi.fn() },
    service: { findUnique: vi.fn() },
    technician: { findUnique: vi.fn() },
    round: { findUnique: vi.fn() },
  } as unknown as Parameters<typeof createVisitService>[0];
}
```

Cover:
1. Creates with `isOneOff: true` and `status: SCHEDULED` — assert on the `visit.create` call args, not just the return value.
2. `servicePlanId` is `null` on the created row.
3. Unknown `propertyId` → `AppError` 404.
4. Unknown `technicianId` / `serviceId` / `roundId` → 404.
5. `price: 0` and `price: -5` → 400.
6. `date: "03-09-2026"` → 400.
7. Returns `price` as a `number`, not a `Decimal`/string.
8. `roundId` omitted → row is created with `roundId: null` (does not throw).

Run: `npm test`. Also `npm run typecheck` — the build script runs it and CI will
fail on a type error.

---

## 9. Swagger

`src/swagger.ts` is a hand-maintained OpenAPI document — the `paths` object
starts at line 1046. Add `/visits` following the existing entries (tags,
summary, description, `requestBody: jsonBody(ref("VisitCreateInput"))`,
`responses` using the `jsonResponse` / `errorResponse` / `ERR[...]` helpers).

This is not optional cosmetics: Schemathesis runs against this spec, and an
undocumented status code is reported as a failure.

---

## 10. Definition of done

- [ ] `POST /visits` returns `201` with the §5 shape; row has `isOneOff: true`, `status: SCHEDULED`, `servicePlanId: null`.
- [ ] All four 404 cases and all 400 cases behave as specified.
- [ ] `TECHNICIAN` gets `403`.
- [ ] Created visit appears in `GET /today` when dated today.
- [ ] Created visit appears in `GET /rounds/:id/planner/occurrences` when `roundId` was supplied.
- [ ] `GET /invoices/preview?visitId=<new id>` returns a valid preview.
- [ ] `npm test` and `npm run typecheck` both pass.
- [ ] `/visits` documented in `src/swagger.ts` and renders at `/docs`.
- [ ] No Prisma migration in the diff. If you wrote one, you went wrong — re-read §2.1.

---

## 11. Out of scope

- `GET /visits`, `PATCH /visits/:id`, `DELETE /visits/:id` — not needed for this Quick Action.
- Making a round-less one-off visible in Round Planner (§6).
- Customer notification on creation.
- Recurring / repeat one-offs.
