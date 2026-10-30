/**
 * OpenAPI 3.0 specification — the frontend/backend contract for RoundFlow.
 *
 * This is the single source of truth for the HTTP API. It is served as an
 * interactive UI at `GET /docs` and as raw JSON at `GET /openapi.json`
 * (wired up in src/index.ts).
 *
 * Structure (top → bottom):
 *   1. Meta          — info, servers, tags, security scheme
 *   2. Enums         — every Prisma enum as a reusable schema component
 *   3. Models        — response entity schemas (Profile, Round, …)
 *   4. Inputs        — request-body schemas (Setup Wizard steps)
 *   5. Responses     — reusable error responses (401/400/403/409/500)
 *   6. Paths         — every endpoint, grouped by tag
 *   7. Document      — assembled + exported `openApiDocument`
 *
 * Conventions worth knowing for the frontend:
 *   • Auth: every route except `/health` and the docs needs
 *     `Authorization: Bearer <Supabase ES256 JWT>`.
 *   • Money fields (`defaultPrice`, `price`, `amount`) are returned as STRINGS
 *     (Postgres `money` / Prisma `Decimal`) but sent as NUMBERS in requests.
 *   • Multi-tenant: each signup provisions a dedicated Postgres schema
 *     (`t_<hex>`); BusinessSettings is one row per tenant schema.
 *   • Webhooks (`/webhooks/*`) are unauthenticated and verified by signature
 *     and/or a per-tenant URL secret instead of a Bearer token.
 */

import type { OpenAPIV3 } from "openapi-types";

// ---------------------------------------------------------------------------
// Supabase Auth (external) — used only to document the token-fetch step.
// The anon key is the PUBLIC (publishable) key — safe to expose, NOT a secret.
// ---------------------------------------------------------------------------

const SUPABASE_URL = "https://suspoztkyfnnuyodbxov.supabase.co";
const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InN1c3BvenRreWZubnV5b2RieG92Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODcwNzkwODEsImV4cCI6MjEwMjY1NTA4MX0.cQsgFPWRXpITMwIvy7gi2zdfnLaV-jwzJAZY1iNi25k";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A `$ref` to a component schema. */
const ref = (name: string): OpenAPIV3.ReferenceObject => ({
  $ref: `#/components/schemas/${name}`,
});

/** A nullable reference to an enum/object schema (OpenAPI 3.0 `allOf` trick). */
const nullableRef = (name: string): OpenAPIV3.SchemaObject => ({
  allOf: [ref(name)],
  nullable: true,
});

/** Request body that accepts either a raw array or `{ [key]: [...] }`. */
const arrayOrWrapped = (
  itemRef: string,
  key: string
): OpenAPIV3.SchemaObject => ({
  description: `Either a raw JSON array of ${itemRef}, or an object \`{ "${key}": [ ... ] }\`.`,
  oneOf: [
    { type: "array", items: ref(itemRef) },
    {
      type: "object",
      required: [key],
      properties: { [key]: { type: "array", items: ref(itemRef) } },
    },
  ],
});

const jsonBody = (
  schema: OpenAPIV3.SchemaObject | OpenAPIV3.ReferenceObject,
  required = true
): OpenAPIV3.RequestBodyObject => ({
  required,
  content: { "application/json": { schema } },
});

const jsonResponse = (
  description: string,
  schema: OpenAPIV3.SchemaObject | OpenAPIV3.ReferenceObject
): OpenAPIV3.ResponseObject => ({
  description,
  content: { "application/json": { schema } },
});

// Common error-response refs, reused across operations.
const ERR = {
  400: { $ref: "#/components/responses/BadRequest" },
  401: { $ref: "#/components/responses/Unauthorized" },
  403: { $ref: "#/components/responses/Forbidden" },
  404: { $ref: "#/components/responses/NotFound" },
  409: { $ref: "#/components/responses/Conflict" },
  410: { $ref: "#/components/responses/Gone" },
  500: { $ref: "#/components/responses/ServerError" },
} as const;

// Technician app (/mobile) 403s — role/ownership codes (D-3, A8).
const MOBILE_ERR_403: OpenAPIV3.ResponseObject = {
  description:
    "`code` is one of: NO_PROFILE (no Profile for the signed-in user yet), TECHNICIAN_ONLY (caller isn't a TECHNICIAN), NO_TECHNICIAN (no Technician row linked), NOT_YOUR_VISIT (visit assigned to someone else / nobody), NOT_YOUR_ROUND (chat on a round the caller isn't on), " +
    "IDEMPOTENCY_KEY_CONFLICT (X-Idempotency-Key belongs to another technician), or a debt-gate block on start.",
  content: { "application/json": { schema: { $ref: "#/components/schemas/Error" }, example: { error: "This job is not assigned to you", code: "NOT_YOUR_VISIT" } } },
};

// ---------------------------------------------------------------------------
// 2. Enums — mirror prisma/schema.prisma. Included in full for reference even
//    where a given endpoint doesn't use one yet.
// ---------------------------------------------------------------------------

const stringEnum = (values: string[], description?: string): OpenAPIV3.SchemaObject => ({
  type: "string",
  enum: values,
  ...(description ? { description } : {}),
});

const enumSchemas: Record<string, OpenAPIV3.SchemaObject> = {
  UserRole: stringEnum(["ADMIN", "MANAGER", "TECHNICIAN"]),
  LifecycleStatus: stringEnum(["ACTIVE", "PAUSED", "CANCELLED"]),
  RoundStatus: stringEnum(["ACTIVE", "DRAFT", "ARCHIVED"]),
  DayOfWeek: stringEnum(["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"]),
  CleaningFrequency: stringEnum([
    "FOUR_WEEKLY",
    "SIX_WEEKLY",
    "EIGHT_WEEKLY",
    "TWELVE_WEEKLY",
  ]),
  VisitStatus: stringEnum(["SCHEDULED", "IN_PROGRESS", "COMPLETED", "SKIPPED", "CANCELLED"], "CANCELLED visits carry `cancelReason` (e.g. \"PAUSED\" when a plan pause cancels them) and are excluded from today/planner counts."),
  PaymentStatus: stringEnum(["NOT_DUE", "PENDING", "PAID", "FAILED", "OVERDUE", "CANCELLED"]),
  PaymentMethod: stringEnum(["GOCARDLESS", "CASH", "CHEQUE", "BACS", "STRIPE"]),
  MessageChannel: stringEnum(["SMS", "WHATSAPP", "EMAIL"]),
  MessageDirection: stringEnum(["OUTBOUND", "INBOUND"]),
  Severity: stringEnum(["LOW", "MEDIUM", "HIGH"]),
  ComplaintStatus: stringEnum(["OPEN", "IN_REVIEW", "REVISIT_BOOKED", "RESOLVED"]),
  ServiceCategory: stringEnum([
    "DEFAULT",
    "WINDOW_CLEANING",
    "GUTTER_FASCIA",
    "EXTERIOR_CLEANING",
    "SPECIALIST",
  ]),
  InvoiceStatus: stringEnum(["DRAFT", "SENT", "PAID", "VOID"]),
  IssueType: stringEnum([
    "ACCESS_PROBLEM",
    "GATE_LOCKED",
    "PAYMENT_ISSUE",
    "DOG_LOOSE",
    "NO_REAR_ACCESS",
    "UNSAFE_CONDITIONS",
    "WRONG_ADDRESS",
    "OTHER",
  ]),
  PhotoType: stringEnum(["PROPERTY", "BEFORE", "AFTER", "ACCESS_ISSUE"], "ACCESS_ISSUE: photo attached to a technician's access-issue report (POST /mobile/visits/{id}/access-issues `photoPaths`)."),
  PaymentTiming: stringEnum(["COLLECT_AFTER_VISIT", "COLLECT_BEFORE_VISIT", "COLLECT_ON_DATE", "COLLECT_DAILY_BATCH"]),
  NoteType: stringEnum(["INTERNAL", "RISK_WARNING", "CUSTOMER"]),
  ReminderMode: stringEnum(["EVENING_BEFORE", "MORNING_OF", "NONE"], "Pre-clean reminder timing, sent at BusinessSettings.reminderTime (tenant-local): the evening before, or the morning of, the visit."),
  CleanMethod: stringEnum(["TRADITIONAL", "WATER_FED_POLE", "BOTH"]),
  NoDirectDebitAction: stringEnum(["SEND_INVOICE", "SEND_PAYMENT_LINK"], "What to do after a visit for a customer with no active Direct Debit mandate."),
  IncidentType: stringEnum(["STRIKE", "DAMAGE", "UPSELL"]),
  KpiOperator: stringEnum(["GT", "LT"]),
  CustomerPaymentStatus: stringEnum(
    ["NONE", "PAID", "UNPAID", "OVERDUE", "ON_HOLD", "FAILED"],
    "Derived customer payment status (uppercase, D-2)."
  ),
};

// ---------------------------------------------------------------------------
// 3. Models — response entity shapes. Money fields are strings on the wire.
// ---------------------------------------------------------------------------

const dateTime: OpenAPIV3.SchemaObject = { type: "string", format: "date-time" };
const money: OpenAPIV3.SchemaObject = {
  type: "string",
  description: "Decimal money value serialised as a string, e.g. \"35\".",
  example: "35",
};

const modelSchemas: Record<string, OpenAPIV3.SchemaObject> = {
  Error: {
    type: "object",
    required: ["error"],
    properties: {
      error: { type: "string" },
      code: {
        type: "string",
        description: "Machine-readable reason, present on some errors (e.g. INVITE_ACCEPTED, INVITE_EXPIRED, NO_MATCHING_ROUND). See the API description for the full list.",
      },
    },
    additionalProperties: true,
    description: "Typed errors may carry extra fields, forwarded as-is by the central error handler (e.g. `fields` on INVALID_ALLOCATION, `suggestions` + `proposedName` on NO_MATCHING_ROUND).",
    example: { error: "Unauthorized" },
  },

  Profile: {
    type: "object",
    description: "Public-schema mirror of a Supabase auth.users record.",
    required: ["id", "supabaseUserId", "role", "name", "createdAt", "updatedAt"],
    properties: {
      id: { type: "string" },
      supabaseUserId: { type: "string", description: "→ auth.users.id" },
      role: ref("UserRole"),
      name: { type: "string" },
      createdAt: dateTime,
      updatedAt: dateTime,
    },
    example: {
      id: "6d432b38-676d-4791-b486-2be40a1dea7e",
      supabaseUserId: "87d11631-fdcb-41b7-8484-2431dc3feb56",
      role: "ADMIN",
      name: "maazk101103",
      createdAt: "2026-07-01T23:29:00.354Z",
      updatedAt: "2026-07-01T23:29:00.354Z",
    },
  },

  BankDetails: {
    type: "object",
    description: "Bank transfer payment details printed in the invoice footer.",
    required: ["accountName", "accountNumber", "sortCode"],
    properties: {
      accountName: { type: "string", minLength: 1, example: "Northumberland Window Cleaning Ltd" },
      bankName: { type: "string", nullable: true, example: "Lloyds Bank" },
      accountNumber: { type: "string", minLength: 1, example: "12345678" },
      sortCode: { type: "string", minLength: 1, example: "30-80-12" },
    },
    example: { accountName: "Northumberland Window Cleaning Ltd", bankName: "Lloyds Bank", accountNumber: "12345678", sortCode: "30-80-12" },
  },

  BusinessSettings: {
    type: "object",
    description:
      "The tenant's business config — one row per tenant schema. Every endpoint that returns it (GET/PATCH /settings/*, GET/POST /setup/step/1|2|4) strips the encrypted provider tokens/secrets (any `*Encrypted` column) and returns `vatRate` as a number.",
    properties: {
      id: { type: "string" },
      uniqueId: { type: "string", example: "singleton", description: "Always \"singleton\" — unique within the tenant's own schema." },
      businessName: { type: "string", nullable: true },
      phone: { type: "string", nullable: true },
      email: { type: "string", nullable: true },
      companyNumber: { type: "string", nullable: true },
      vatRegistration: { type: "string", nullable: true },
      vatRegistered: { type: "boolean" },
      defaultWorkingDays: { type: "array", items: { type: "string", enum: ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"] } },
      timezone: { type: "string", nullable: true },
      currency: { type: "string", nullable: true },
      defaultCycleLength: {
        type: "integer",
        nullable: true,
        description: "Cycle length in days.",
      },
      bankDetails: { ...nullableRef("BankDetails"), description: "Printed in the invoice footer for bank transfer customers." },
      paymentRule: nullableRef("PaymentTiming"),
      debtHoldEnabled: { type: "boolean" },
      vatInInvoices: { type: "boolean" },
      debtHoldMaxInvoices: { type: "integer", nullable: true },
      debtHoldMaxAmount: { ...money, nullable: true },
      gocardlessConnected: { type: "boolean" },
      gocardlessEnvironment: { type: "string", nullable: true },
      stripeConnected: { type: "boolean" },
      stripeConnectAccountId: { type: "string", nullable: true },
      stripePublishableKey: { type: "string", nullable: true },
      ghlConnected: { type: "boolean" },
      ghlLocationId: { type: "string", nullable: true },
      ghlTokenExpiresAt: { ...dateTime, nullable: true },
      setupCompleted: { type: "boolean" },
      lastClosedDate: { type: "string", nullable: true, description: "YYYY-MM-DD of the last closed operational day." },
      preCleanReminderTimings: { type: "array", items: { type: "string" }, deprecated: true, description: "Deprecated — superseded by reminderMode." },
      termsUrl: { type: "string", nullable: true },
      privacyUrl: { type: "string", nullable: true },
      addressLine1: { type: "string", nullable: true },
      addressLine2: { type: "string", nullable: true },
      town: { type: "string", nullable: true },
      postcode: { type: "string", nullable: true },
      vatRate: { type: "number", description: "VAT percentage (0–100) as a JSON number.", example: 20 },
      reminderMode: ref("ReminderMode"),
      reminderTime: { type: "string", example: "19:00", description: "HH:mm, tenant-local (timezone)." },
      defaultCleanMethod: nullableRef("CleanMethod"),
      autoCreateNextVisit: { type: "boolean" },
      defaultPaymentMethod: nullableRef("PaymentMethod"),
      invoiceDueDays: { type: "integer", minimum: 1, maximum: 90, example: 7 },
      noDirectDebitAction: ref("NoDirectDebitAction"),
      completedSteps: { type: "array", items: { type: "integer" }, description: "Setup wizard steps saved at least once (drives GET /setup/status)." },
      updatedAt: dateTime,
    },
  },

  Service: {
    type: "object",
    properties: {
      id: { type: "string" },
      name: { type: "string" },
      category: ref("ServiceCategory"),
      description: { type: "string", nullable: true },
      defaultPrice: money,
      active: { type: "boolean" },
      createdAt: dateTime,
      updatedAt: dateTime,
    },
  },

  Technician: {
    type: "object",
    description:
      "A field operative. Invite-pending rows have profileId = null until the invite is accepted.",
    properties: {
      id: { type: "string" },
      profileId: { type: "string", nullable: true },
      name: {
        type: "string",
        nullable: true,
        description: "Admin display label; Profile.name wins once the invite is accepted.",
      },
      role: { type: "string", nullable: true, description: "Operational role, e.g. Senior." },
      phone: { type: "string", nullable: true },
      active: { type: "boolean" },
      avatarUrl: { type: "string", nullable: true },
      createdAt: dateTime,
      updatedAt: dateTime,
    },
  },

  ServiceArea: {
    type: "object",
    properties: {
      id: { type: "string" },
      name: { type: "string" },
      postcodeSector: { type: "string", nullable: true },
      isDefault: { type: "boolean" },
      createdAt: dateTime,
      updatedAt: dateTime,
    },
  },

  TenantInvite: {
    type: "object",
    description: "A pending invitation for a technician or manager to join the tenant.",
    required: ["id", "tenantId", "email", "role", "token", "expiresAt", "createdAt"],
    properties: {
      id: { type: "string" },
      tenantId: { type: "string" },
      email: { type: "string", format: "email" },
      role: ref("UserRole"),
      token: { type: "string" },
      expiresAt: dateTime,
      acceptedAt: { ...dateTime, nullable: true },
      technicianId: { type: "string", nullable: true },
      createdAt: dateTime,
    },
  },

  Round: {
    type: "object",
    properties: {
      id: { type: "string" },
      name: { type: "string" },
      defaultDay: nullableRef("DayOfWeek"),
      frequency: nullableRef("CleaningFrequency"),
      description: { type: "string", nullable: true },
      status: ref("RoundStatus"),
      serviceAreaId: { type: "string", nullable: true },
      defaultServiceId: { type: "string", nullable: true, description: "Fallback service for invoice line text (visit service → plan service → round default service → \"Window cleaning\"). No endpoint sets it yet." },
      createdAt: dateTime,
      updatedAt: dateTime,
    },
  },

  ServiceAreaWithRounds: {
    allOf: [
      ref("ServiceArea"),
      {
        type: "object",
        properties: {
          linkedRounds: {
            type: "object",
            description: "Derived, read-only summary of Rounds referencing this area.",
            properties: {
              count: { type: "integer" },
              names: { type: "array", items: { type: "string" } },
            },
          },
        },
      },
    ],
  },

  TechnicianWithDisplayName: {
    allOf: [
      ref("Technician"),
      {
        type: "object",
        properties: {
          profile: nullableRef("Profile"),
          displayName: {
            type: "string",
            nullable: true,
            description: "profile?.name ?? technician.name ?? null.",
          },
          appStatus: stringEnum(["PENDING_INVITE", "ACTIVE", "INACTIVE"]),
        },
      },
    ],
  },

  ProviderConnectResponse: {
    type: "object",
    description:
      "Result of a token-based provider connect (POST /settings/payment/gocardless/connect, POST /settings/ghl/connect-private).",
    required: ["status", "webhookUrl"],
    properties: {
      status: { type: "string", enum: ["connected"], example: "connected" },
      method: { type: "string", enum: ["private"], description: "GHL private-integration connect only." },
      webhookUrl: {
        type: "string",
        description:
          "`${PUBLIC_API_URL}/webhooks/<provider>?tenantId=…&secret=…` — the admin must register this URL in the provider's dashboard by hand. The `secret` query param is a fresh random route token generated on every connect.",
        example: "https://api.roundflow.app/webhooks/gocardless?tenantId=ten_123&secret=3f9a…",
      },
    },
  },

  OAuthAuthorizeUrl: {
    type: "object",
    required: ["url"],
    properties: { url: { type: "string", example: "https://connect.stripe.com/oauth/authorize?response_type=code&client_id=ca_…&scope=read_write&state=…" } },
  },

  StripeCallbackResult: {
    type: "object",
    required: ["status", "stripeConnectAccountId"],
    properties: {
      status: { type: "string", enum: ["connected"] },
      stripeConnectAccountId: { type: "string", example: "acct_1Abc" },
    },
  },

  GhlCallbackResult: {
    type: "object",
    required: ["status", "method", "locationId", "webhookUrl"],
    properties: {
      status: { type: "string", enum: ["connected"] },
      method: { type: "string", enum: ["oauth"] },
      locationId: { type: "string" },
      webhookUrl: { type: "string", description: "Register this in GHL: `${PUBLIC_API_URL}/webhooks/ghl?tenantId=…&secret=…`." },
    },
  },

  GhlStatus: {
    type: "object",
    required: ["connected", "method", "locationId", "locationName", "webhookUrl", "connectedAt"],
    properties: {
      connected: { type: "boolean" },
      method: { type: "string", enum: ["oauth", "private"], nullable: true },
      locationId: { type: "string", nullable: true },
      locationName: { type: "string", nullable: true },
      webhookUrl: { type: "string", nullable: true },
      connectedAt: { ...dateTime, nullable: true, description: "Not stored yet — always null." },
    },
    example: { connected: true, method: "oauth", locationId: "loc_123", locationName: "Acme Windows", webhookUrl: "https://api.roundflow.app/webhooks/ghl?tenantId=ten_1&secret=…", connectedAt: null },
  },

  GhlTestResult: {
    type: "object",
    required: ["ok", "locationName"],
    properties: { ok: { type: "boolean", enum: [true] }, locationName: { type: "string", nullable: true } },
  },

  KpiThreshold: {
    type: "object",
    required: ["id", "metric", "operator", "value"],
    properties: {
      id: { type: "string" },
      metric: { type: "string", enum: ["strikes", "damages", "upsells", "revenuePerHour", "timeOnJobMinutes"] },
      operator: ref("KpiOperator"),
      value: { type: "number" },
    },
    example: { id: "kpi_1", metric: "revenuePerHour", operator: "LT", value: 30 },
  },

  KpiThresholdInput: {
    type: "object",
    required: ["metric", "operator", "value"],
    properties: {
      metric: { type: "string", enum: ["strikes", "damages", "upsells", "revenuePerHour", "timeOnJobMinutes"] },
      operator: ref("KpiOperator"),
      value: { type: "number", minimum: 0, maximum: 99999999 },
    },
  },

  ProviderStatusResult: {
    type: "object",
    required: ["status"],
    properties: {
      status: { type: "string", enum: ["disconnected", "saved"], example: "disconnected" },
    },
  },

  MessageTemplateView: {
    type: "object",
    required: ["id", "name", "channel", "body", "createdAt", "updatedAt"],
    properties: {
      id: { type: "string" },
      name: { type: "string" },
      channel: { type: "string", nullable: true, enum: ["SMS", "WHATSAPP", "EMAIL", null] },
      subject: { type: "string", nullable: true },
      body: { type: "string" },
      createdAt: { type: "string", format: "date-time" },
      updatedAt: { type: "string", format: "date-time" },
    },
  },

  MessageTemplateInput: {
    type: "object",
    required: ["name", "channel", "body"],
    properties: {
      name: { type: "string", minLength: 1 },
      channel: { type: "string", enum: ["SMS", "WHATSAPP", "EMAIL"] },
      body: { type: "string", minLength: 1 },
      subject: { type: "string", nullable: true, description: "Required for EMAIL channel." },
    },
  },

  StepStatus: {
    type: "object",
    required: ["step", "complete", "deferred"],
    properties: {
      step: { type: "integer", minimum: 1, maximum: 12 },
      complete: { type: "boolean" },
      deferred: {
        type: "boolean",
        description: "True only for step 10 (Assign Technicians to Rounds) — `complete` still reflects reality, but it doesn't block POST /setup/complete.",
      },
    },
  },

  SetupStatus: {
    type: "object",
    required: ["setupCompleted", "allRequiredComplete", "steps", "wizardSteps"],
    properties: {
      setupCompleted: { type: "boolean" },
      allRequiredComplete: {
        type: "boolean",
        description: "True when every non-deferred step before 12 (1–9 and 11) is complete. Step 12 is the completion action itself.",
      },
      steps: { type: "array", items: ref("StepStatus") },
      wizardSteps: {
        type: "array",
        description:
          "GAP-002: the web's 10-step wizard in display order. `complete` = that backend step was saved at least once (BusinessSettings.completedSteps), not a row count. " +
          "key → step: business-profile 1, service-area 7, round-settings 4, first-round 8, service-catalogue 3, technician-management 6, payment-setup 2, sms-templates 5, add-property 9, generate-visits 11.",
        items: {
          type: "object",
          required: ["key", "step", "complete"],
          properties: { key: { type: "string", example: "business-profile" }, step: { type: "integer" }, complete: { type: "boolean" } },
        },
      },
    },
    example: {
      setupCompleted: false,
      allRequiredComplete: false,
      wizardSteps: [
        { key: "business-profile", step: 1, complete: true },
        { key: "service-area", step: 7, complete: false },
      ],
      steps: [
        { step: 1, complete: false, deferred: false },
        { step: 2, complete: false, deferred: false },
        { step: 3, complete: false, deferred: false },
        { step: 4, complete: false, deferred: false },
        { step: 5, complete: false, deferred: false },
        { step: 6, complete: false, deferred: false },
        { step: 7, complete: false, deferred: false },
        { step: 8, complete: false, deferred: false },
        { step: 9, complete: false, deferred: false },
        { step: 10, complete: false, deferred: true },
        { step: 11, complete: false, deferred: false },
        { step: 12, complete: false, deferred: false },
      ],
    },
  },

  HealthStatus: {
    type: "object",
    required: ["status", "timestamp"],
    properties: {
      status: { type: "string", example: "ok" },
      timestamp: dateTime,
    },
  },

  HealthMigrating: {
    type: "object",
    required: ["status"],
    properties: { status: { type: "string", enum: ["migrating"] } },
  },

  // --- Supabase Auth (external) ---
  SupabaseLoginInput: {
    type: "object",
    required: ["email", "password"],
    properties: {
      email: { type: "string", format: "email" },
      password: { type: "string", format: "password" },
    },
    example: { email: "you@example.com", password: "your-password" },
  },

  SupabaseSession: {
    type: "object",
    description: "Supabase session. Use `access_token` as the Bearer token.",
    properties: {
      access_token: {
        type: "string",
        description: "ES256 JWT — paste into Authorize as the Bearer token.",
      },
      token_type: { type: "string", example: "bearer" },
      expires_in: { type: "integer", example: 3600 },
      expires_at: { type: "integer" },
      refresh_token: { type: "string" },
      user: {
        type: "object",
        additionalProperties: true,
        description: "The Supabase user object.",
      },
    },
  },

  ComplaintMessage: {
    type: "object",
    description: "A message in a complaint thread.",
    required: ["id", "direction", "channel", "body", "complaintId", "createdAt"],
    properties: {
      id: { type: "string" },
      direction: { type: "string", enum: ["INBOUND", "OUTBOUND"], example: "OUTBOUND" },
      channel: { type: "string", enum: ["SMS", "WHATSAPP", "EMAIL"], example: "EMAIL" },
      body: { type: "string" },
      complaintId: { type: "string" },
      createdAt: dateTime,
    },
  },

  Complaint: {
    type: "object",
    description: "A customer service complaint record. GET /complaints/{id} (and every mutation response) includes the derived propertyAddress/technicianName/messageCount fields alongside the stored columns.",
    required: ["id", "status", "severity", "title", "customerId", "customerName", "messageCount", "createdAt"],
    properties: {
      id: { type: "string" },
      status: { type: "string", enum: ["OPEN", "IN_REVIEW", "REVISIT_BOOKED", "RESOLVED"], example: "OPEN" },
      severity: { type: "string", enum: ["LOW", "MEDIUM", "HIGH"], example: "MEDIUM" },
      title: { type: "string", example: "Missed conservatory roof" },
      description: { type: "string", nullable: true },
      issueType: { type: "string", nullable: true, example: "Missed Clean" },
      customerId: { type: "string" },
      customerName: { type: "string", example: "David Harris" },
      propertyId: { type: "string", nullable: true },
      propertyAddress: { type: "string", nullable: true, description: "Derived from the linked Property, when there is one." },
      technicianId: { type: "string", nullable: true },
      technicianName: { type: "string", nullable: true, description: "Derived from the linked Technician, when there is one." },
      revisitDate: { type: "string", format: "date", nullable: true, example: "2026-09-10" },
      messageCount: { type: "integer", description: "Total messages in this complaint's thread." },
      resolvedAt: { ...dateTime, nullable: true, description: "Set by POST .../resolve; cleared by POST .../reopen." },
      resolvedBy: {
        type: "object",
        nullable: true,
        description: "BREAKING (was a Profile id string): the Profile that resolved it.",
        required: ["id", "name"],
        properties: { id: { type: "string" }, name: { type: "string", nullable: true } },
      },
      upheld: { type: "boolean", nullable: true, description: "Set by POST .../resolve; an upheld complaint with a technician counts as a strike. Cleared by reopen." },
      notes: { type: "string", nullable: true, description: "Optional resolution notes, set via the `notes` field of POST .../resolve." },
      createdAt: dateTime,
    },
    example: {
      id: "cmp1abc",
      status: "OPEN",
      severity: "MEDIUM",
      title: "Missed conservatory roof",
      description: "Second time this month the conservatory roof was not cleaned.",
      issueType: "Missed Clean",
      customerId: "cld123",
      customerName: "David Harris",
      propertyId: "prp456",
      propertyAddress: "12 Market Street",
      technicianId: null,
      technicianName: null,
      revisitDate: null,
      messageCount: 2,
      resolvedAt: null,
      resolvedBy: null,
      upheld: null,
      notes: null,
      createdAt: "2026-09-01T09:14:00.000Z",
    },
  },

  ComplaintsListResult: {
    type: "object",
    description: "GET /complaints — paginated.",
    required: ["rows", "pagination"],
    properties: {
      rows: { type: "array", items: ref("Complaint") },
      pagination: ref("Pagination"),
    },
  },

  // ---- Emergencies ----
  EmergencyRow: {
    type: "object",
    required: ["id", "technicianId", "roundId", "remainingStops", "status", "reportedAt"],
    properties: {
      id: { type: "string" },
      technicianId: { type: "string" },
      technicianName: { type: "string", nullable: true, example: "James Wilson" },
      roundId: { type: "string" },
      roundName: { type: "string", example: "Alnwick Monday" },
      remainingStops: { type: "integer", description: "Number of properties the technician could not reach.", example: 3 },
      lastLocation: { type: "string", nullable: true, description: "Free-text last known location.", example: "Alnwick High St Hub" },
      scheduledWindowEnd: { type: "string", format: "date-time", nullable: true, description: "When the service window closes.", example: "2026-09-15T20:30:00.000Z" },
      notes: { type: "string", nullable: true },
      status: { type: "string", enum: ["ACTIVE", "RESOLVED"], example: "ACTIVE" },
      assignedTechnicianId: { type: "string", nullable: true, description: "Set when resolved — the technician who took over." },
      assignedTechnicianName: { type: "string", nullable: true, example: "Sarah Jenkins" },
      resolvedAt: { type: "string", format: "date-time", nullable: true },
      reportedAt: { type: "string", format: "date-time", example: "2026-09-15T18:24:00.000Z" },
    },
    example: {
      id: "emg1abc",
      technicianId: "t1",
      technicianName: "James Wilson",
      roundId: "r1",
      roundName: "Alnwick Monday",
      remainingStops: 3,
      lastLocation: "Alnwick High St Hub",
      scheduledWindowEnd: "2026-09-15T20:30:00.000Z",
      notes: null,
      status: "ACTIVE",
      assignedTechnicianId: null,
      assignedTechnicianName: null,
      resolvedAt: null,
      reportedAt: "2026-09-15T18:24:00.000Z",
    },
  },

  AvailableTechnicianRow: {
    type: "object",
    required: ["technicianId", "jobsRemaining", "availability"],
    properties: {
      technicianId: { type: "string" },
      technicianName: { type: "string", nullable: true, example: "Sarah Jenkins" },
      avatarUrl: { type: "string", nullable: true },
      jobsRemaining: { type: "integer", description: "SCHEDULED or IN_PROGRESS visits for this technician today.", example: 0 },
      availability: { type: "string", enum: ["AVAILABLE", "BUSY"], description: "AVAILABLE when jobsRemaining = 0, BUSY otherwise.", example: "AVAILABLE" },
    },
    example: {
      technicianId: "t2",
      technicianName: "Sarah Jenkins",
      avatarUrl: null,
      jobsRemaining: 0,
      availability: "AVAILABLE",
    },
  },

  // ---- Dashboard ----
  DashboardKpis: {
    type: "object",
    required: ["jobsScheduledToday", "openComplaints", "openComplaintsByPriority", "cleanUnpaidAmount", "cleanUnpaidCount", "monthlyRevenue"],
    properties: {
      jobsScheduledToday: { type: "integer", description: "Visits scheduled for today (any non-cancelled status).", example: 48 },
      openComplaints: { type: "integer", description: "Open complaints (not RESOLVED).", example: 2 },
      openComplaintsByPriority: {
        type: "object",
        required: ["high", "medium", "low"],
        properties: {
          high: { type: "integer", example: 1 },
          medium: { type: "integer", example: 1 },
          low: { type: "integer", example: 0 },
        },
      },
      cleanUnpaidAmount: { type: "number", description: "Sum of price for completed-but-unpaid visits this month.", example: 1240 },
      cleanUnpaidCount: { type: "integer", description: "Distinct customers with unpaid visits this month.", example: 18 },
      monthlyRevenue: { type: "number", description: "Sum of price for all completed visits this calendar month.", example: 12400 },
    },
    example: {
      jobsScheduledToday: 48,
      openComplaints: 2,
      openComplaintsByPriority: { high: 1, medium: 1, low: 0 },
      cleanUnpaidAmount: 1240,
      cleanUnpaidCount: 18,
      monthlyRevenue: 12400,
    },
  },

  DashboardAlerts: {
    type: "object",
    required: ["skippedNeedingReview", "failedPayments", "complaintRevisitsDue", "kpiAlerts"],
    properties: {
      skippedNeedingReview: { type: "integer", description: "Visits skipped today.", example: 4 },
      failedPayments: { type: "integer", description: "Payments with status FAILED or OVERDUE.", example: 7 },
      complaintRevisitsDue: { type: "integer", description: "Open complaints with a revisit date on or before end of this week.", example: 2 },
      kpiAlerts: {
        type: "array",
        description: "KPI thresholds crossed this month (raised by the nightly KPI check, one per technician + metric + month), newest first.",
        items: ref("KpiThresholdAlert"),
      },
    },
    example: { skippedNeedingReview: 4, failedPayments: 7, complaintRevisitsDue: 2, kpiAlerts: [] },
  },

  KpiThresholdAlert: {
    type: "object",
    required: ["type", "id", "technicianId", "technicianName", "metric", "value", "threshold", "operator", "periodKey", "createdAt"],
    properties: {
      type: { type: "string", enum: ["KPI_THRESHOLD"] },
      id: { type: "string" },
      technicianId: { type: "string" },
      technicianName: { type: "string", nullable: true },
      metric: { type: "string", example: "revenuePerHour" },
      value: { type: "number", example: 22.5 },
      threshold: { type: "number", example: 30 },
      operator: ref("KpiOperator"),
      periodKey: { type: "string", example: "2026-10" },
      createdAt: dateTime,
    },
  },

  DashboardRoundRow: {
    type: "object",
    required: ["roundId", "roundName", "status", "total", "completed", "skipped", "issueCount", "paymentHolds", "value"],
    properties: {
      roundId: { type: "string" },
      roundName: { type: "string", example: "Alnwick Monday" },
      technicianId: { type: "string", nullable: true },
      technicianName: { type: "string", nullable: true, example: "James" },
      status: { type: "string", enum: ["not_started", "in_progress", "completed"], example: "in_progress" },
      total: { type: "integer", description: "Total visits in this round today.", example: 12 },
      completed: { type: "integer", example: 8 },
      skipped: { type: "integer", example: 1 },
      issueCount: { type: "integer", example: 1 },
      paymentHolds: { type: "integer", example: 0 },
      scheduledValue: { type: "number", description: "Sum of every non-cancelled stop's price today (GAP-035).", example: 300 },
      completedValue: { type: "number", description: "Sum of COMPLETED stops' prices today.", example: 220 },
      value: { type: "number", deprecated: true, description: "Same as completedValue; kept for one release (GAP-035). Same row as GET /today (TodayRoundRow).", example: 220 },
      etaMinutes: { type: "integer", nullable: true, description: "Always null — no real estimate yet (the old remaining × 20 guess was removed).", example: null },
    },
  },

  TechnicianKpi: {
    type: "object",
    required: ["technicianId", "jobsCompleted", "valueCompleted", "openComplaints", "issueCount"],
    properties: {
      technicianId: { type: "string" },
      technicianName: { type: "string", nullable: true, example: "James" },
      jobsCompleted: { type: "integer", description: "Completed visits in the requested period.", example: 42 },
      valueCompleted: { type: "number", description: "Sum of prices for completed visits in the period.", example: 840 },
      openComplaints: { type: "integer", description: "Non-resolved complaints linked to this technician.", example: 1 },
      issueCount: { type: "integer", description: "Issues raised on visits completed in the period.", example: 3 },
      timeOnJobMinutes: { type: "number", nullable: true, description: "Σ(completedAt − startedAt) over completed visits with both timestamps; null when none has timing data.", example: 1260 },
      revenuePerHour: { type: "number", nullable: true, description: "Value of the timed visits ÷ their hours; null without timing data.", example: 40 },
      strikes: { type: "integer", description: "STRIKE incidents + upheld complaints in the period.", example: 0 },
      damages: { type: "integer", example: 0 },
      upsells: { type: "integer", example: 2 },
      upsellValue: { type: "number", example: 30 },
    },
    example: {
      technicianId: "t1",
      technicianName: "James",
      jobsCompleted: 42,
      valueCompleted: 840,
      openComplaints: 1,
      issueCount: 3,
      timeOnJobMinutes: 1260,
      revenuePerHour: 40,
      strikes: 0,
      damages: 0,
      upsells: 2,
      upsellValue: 30,
    },
  },

  DashboardChartData: {
    type: "object",
    required: ["months", "valueCompleted", "issueCount", "revenuePerHour"],
    properties: {
      months: { type: "array", items: { type: "string" }, description: "Ordered month labels (e.g. 'Apr', 'May'). Same length as valueCompleted and issueCount.", example: ["Apr", "May", "Jun", "Jul", "Aug", "Sep"] },
      valueCompleted: { type: "array", items: { type: "number" }, description: "Sum of completed-visit prices per month, parallel to months.", example: [1200, 1400, 980, 1100, 1600, 1340] },
      issueCount: { type: "array", items: { type: "integer" }, description: "Issue count per month, parallel to months.", example: [3, 5, 2, 4, 6, 3] },
      revenuePerHour: { type: "number", nullable: true, description: "Phase 2 stub — always null.", example: null },
    },
    example: {
      months: ["Apr", "May", "Jun", "Jul", "Aug", "Sep"],
      valueCompleted: [1200, 1400, 980, 1100, 1600, 1340],
      issueCount: [3, 5, 2, 4, 6, 3],
      revenuePerHour: null,
    },
  },

  Visit: {
    type: "object",
    description: "A single ad-hoc (one-off) visit returned from POST /visits.",
    required: ["id", "date", "status", "isOneOff", "price", "propertyId", "addressLine", "postcode", "customerId", "customerName"],
    properties: {
      id: { type: "string" },
      date: { type: "string", format: "date", example: "2026-09-03" },
      status: { type: "string", enum: ["SCHEDULED", "IN_PROGRESS", "COMPLETED", "SKIPPED", "CANCELLED"], example: "SCHEDULED" },
      cancelReason: { type: "string", nullable: true, description: "Set when status = CANCELLED, e.g. \"PAUSED\"." },
      isOneOff: { type: "boolean", example: true },
      price: { type: "number", example: 45 },
      notes: { type: "string", nullable: true },
      paymentMethod: { type: "string", nullable: true, enum: ["GOCARDLESS", "STRIPE", "CASH", "BACS", "CHEQUE"] },
      propertyId: { type: "string" },
      addressLine: { type: "string", example: "12 Market Street" },
      postcode: { type: "string", example: "NE66 1SS" },
      latitude: { type: "number", nullable: true, example: 55.4042, description: "Null until the next geocoding backfill tick picks up the new postcode." },
      longitude: { type: "number", nullable: true, example: -1.7073 },
      customerId: { type: "string" },
      customerName: { type: "string", example: "John Smith" },
      roundId: { type: "string", nullable: true },
      roundName: { type: "string", nullable: true },
      serviceId: { type: "string", nullable: true },
      serviceName: { type: "string", nullable: true },
      technicianId: { type: "string", nullable: true },
      technicianName: { type: "string", nullable: true },
    },
  },

  // ---- Shared ----
  Pagination: {
    type: "object",
    description: "Shared page-metadata shape returned alongside `rows` by every paginated list endpoint.",
    required: ["page", "pageSize", "total", "totalPages"],
    properties: {
      page: { type: "integer" },
      pageSize: { type: "integer" },
      total: { type: "integer" },
      totalPages: { type: "integer" },
    },
  },

  // ---- Rounds ----
  RoundSummary: {
    type: "object",
    description: "One row from GET /rounds — Round plus derived counts (no technician list; see RoundDetail for that).",
    required: ["id", "name", "status", "technicianCount", "propertyCount"],
    properties: {
      id: { type: "string" },
      name: { type: "string" },
      frequency: nullableRef("CleaningFrequency"),
      defaultDay: nullableRef("DayOfWeek"),
      status: ref("RoundStatus"),
      serviceAreaId: { type: "string", nullable: true },
      serviceAreaName: { type: "string", nullable: true },
      technicianCount: { type: "integer" },
      propertyCount: { type: "integer" },
    },
  },

  TechnicianRef: {
    type: "object",
    description: "Minimal technician reference embedded in RoundDetail.technicians.",
    required: ["id", "active"],
    properties: {
      id: { type: "string" },
      name: { type: "string", nullable: true },
      active: { type: "boolean" },
    },
  },

  RoundDetail: {
    type: "object",
    description: "GET /rounds/{id}, and the create/update/set-technicians responses — adds the full technician list in place of RoundSummary's count.",
    required: ["id", "name", "status", "technicians", "propertyCount"],
    properties: {
      id: { type: "string" },
      name: { type: "string" },
      frequency: nullableRef("CleaningFrequency"),
      defaultDay: nullableRef("DayOfWeek"),
      description: { type: "string", nullable: true },
      status: ref("RoundStatus"),
      serviceAreaId: { type: "string", nullable: true },
      serviceAreaName: { type: "string", nullable: true },
      technicians: { type: "array", items: ref("TechnicianRef") },
      propertyCount: { type: "integer" },
    },
  },

  OccurrenceTechnicianRef: {
    type: "object",
    required: ["id"],
    properties: {
      id: { type: "string" },
      name: { type: "string", nullable: true },
    },
  },

  OccurrenceSummary: {
    type: "object",
    description: "One calendar day's aggregate stats for a round (planner calendar view).",
    required: ["date", "stopCount", "totalValue", "completedCount", "completionPct", "holdCount", "issueCount", "technicians"],
    properties: {
      date: { type: "string", format: "date", description: "UTC calendar date (YYYY-MM-DD)." },
      stopCount: { type: "integer" },
      totalValue: { type: "number" },
      completedCount: { type: "integer" },
      completionPct: { type: "integer", description: "0–100, rounded. 0 when stopCount is 0." },
      holdCount: { type: "integer" },
      issueCount: { type: "integer" },
      technicians: { type: "array", items: ref("OccurrenceTechnicianRef"), description: "Every distinct technician with ≥ 1 stop on this date, deduped by id." },
    },
  },

  PlannerStopIssue: {
    type: "object",
    required: ["id", "type"],
    properties: {
      id: { type: "string" },
      type: ref("IssueType"),
      note: { type: "string", nullable: true },
    },
  },

  PlannerStop: {
    type: "object",
    description: "One property stop within a planner occurrence (list/map view).",
    required: ["visitId", "propertyId", "addressLine", "postcode", "price", "status", "paymentHold", "issues"],
    properties: {
      visitId: { type: "string" },
      propertyId: { type: "string" },
      propertyName: { type: "string", nullable: true },
      addressLine: { type: "string" },
      postcode: { type: "string" },
      latitude: { type: "number", nullable: true, description: "Null until the next geocoding backfill tick picks up the new postcode." },
      longitude: { type: "number", nullable: true },
      customerName: { type: "string", nullable: true },
      price: { type: "number" },
      status: ref("VisitStatus"),
      paymentHold: { type: "boolean" },
      technicianId: { type: "string", nullable: true },
      technicianName: { type: "string", nullable: true },
      issues: { type: "array", items: ref("PlannerStopIssue") },
      completedAt: { ...dateTime, nullable: true },
    },
  },

  OccurrenceDetail: {
    type: "object",
    description: "GET /rounds/{id}/planner/occurrences/{date} — every stop for one calendar day, plus the same aggregate stats as OccurrenceSummary (minus date, given separately here).",
    required: ["roundId", "roundName", "date", "stops", "summary"],
    properties: {
      roundId: { type: "string" },
      roundName: { type: "string" },
      date: { type: "string", format: "date" },
      stops: { type: "array", items: ref("PlannerStop") },
      summary: {
        type: "object",
        required: ["stopCount", "totalValue", "completedCount", "completionPct", "holdCount", "issueCount", "technicians"],
        properties: {
          stopCount: { type: "integer" },
          totalValue: { type: "number" },
          completedCount: { type: "integer" },
          completionPct: { type: "integer" },
          holdCount: { type: "integer" },
          issueCount: { type: "integer" },
          technicians: { type: "array", items: ref("OccurrenceTechnicianRef") },
        },
      },
    },
  },

  RoundOccurrenceBatchItem: {
    type: "object",
    description: "One round's occurrence list within the batched GET /rounds/planner/occurrences response. An unknown/stale round id simply gets an empty occurrences array — the call never 404s because one id is invalid.",
    required: ["roundId", "occurrences"],
    properties: {
      roundId: { type: "string" },
      occurrences: { type: "array", items: ref("OccurrenceSummary") },
    },
  },

  DayStopsForRound: {
    type: "object",
    description: "One round's stops within the batched GET /rounds/planner/occurrences/{date} response. An unknown/stale round id gets an empty stops array.",
    required: ["roundId", "stops"],
    properties: {
      roundId: { type: "string" },
      stops: { type: "array", items: ref("PlannerStop") },
    },
  },

  GenerateVisitsResult: {
    type: "object",
    required: ["visitsGenerated"],
    properties: {
      visitsGenerated: { type: "integer", description: "Visits created for this round right now, instead of waiting for the next nightly generation run." },
    },
  },

  TodayPanelStop: {
    type: "object",
    required: ["visitId", "addressLine", "status", "paymentHold", "hasIssue"],
    properties: {
      visitId: { type: "string" },
      customerName: { type: "string", nullable: true },
      addressLine: { type: "string" },
      latitude: { type: "number", nullable: true, description: "Null until the next geocoding backfill tick picks up the new postcode." },
      longitude: { type: "number", nullable: true },
      status: ref("VisitStatus"),
      paymentHold: { type: "boolean" },
      hasIssue: { type: "boolean" },
      issueFlag: { type: "string", nullable: true, description: "First issue's note text; null when there's no note text or no issues." },
    },
  },

  TodayPanel: {
    type: "object",
    description: "GET /rounds/{id}/today — a single round's Today panel (Screen 13).",
    required: ["roundId", "roundName", "status", "progress", "stops"],
    properties: {
      roundId: { type: "string" },
      roundName: { type: "string" },
      technicianId: { type: "string", nullable: true },
      technicianName: { type: "string", nullable: true },
      status: { type: "string", enum: ["not_started", "in_progress", "completed"] },
      progress: {
        type: "object",
        required: ["total", "completed", "skipped", "issues"],
        properties: {
          total: { type: "integer" },
          completed: { type: "integer" },
          skipped: { type: "integer" },
          issues: { type: "integer" },
        },
      },
      stops: { type: "array", items: ref("TodayPanelStop") },
    },
  },

  ReassignResult: {
    type: "object",
    required: ["updated"],
    properties: { updated: { type: "integer", description: "Visits whose technicianId was switched (BREAKING — was updatedCount)." } },
  },

  AllocationEntry: {
    type: "object",
    required: ["technicianId", "name", "propertyIds", "stops", "value"],
    properties: {
      technicianId: { type: "string" },
      name: { type: "string", nullable: true },
      propertyIds: { type: "array", items: { type: "string" } },
      stops: { type: "integer" },
      value: { type: "string", description: "Sum of the properties' ACTIVE plan prices, e.g. \"37.00\"." },
    },
  },

  SetTechniciansResult: {
    type: "object",
    required: ["roundId", "allocation", "visitsUpdated"],
    properties: {
      roundId: { type: "string" },
      allocation: { type: "array", items: ref("AllocationEntry") },
      visitsUpdated: { type: "integer", description: "Future SCHEDULED visits restamped (or that would be, on a dry run)." },
    },
    example: { roundId: "rnd_1", allocation: [{ technicianId: "t1", name: "James", propertyIds: ["p1", "p2"], stops: 2, value: "37.00" }], visitsUpdated: 6 },
  },

  RoundAllocation: {
    type: "object",
    required: ["mode", "allocation"],
    properties: {
      mode: { type: "string", enum: ["SINGLE", "AUTO", "MANUAL"] },
      allocation: { type: "array", items: ref("AllocationEntry") },
    },
  },

  PushMissedResult: {
    type: "object",
    required: ["pushedCount"],
    properties: { pushedCount: { type: "integer", description: "SCHEDULED visits moved to the new date." } },
  },

  // ---- Today's Work (GET /today, POST /today/close) ----
  TodayKpi: {
    type: "object",
    required: ["totalStops", "inProgress", "completed", "skipped", "issues", "paymentHolds", "valueCompleted"],
    properties: {
      totalStops: { type: "integer" },
      inProgress: { type: "integer" },
      completed: { type: "integer" },
      skipped: { type: "integer" },
      issues: { type: "integer", description: "Visits today with ≥ 1 issue." },
      paymentHolds: { type: "integer" },
      valueCompleted: { type: "number" },
    },
  },

  TodayRoundRow: {
    type: "object",
    required: ["roundId", "roundName", "status", "total", "completed", "skipped", "issueCount", "paymentHolds", "value"],
    properties: {
      roundId: { type: "string" },
      roundName: { type: "string" },
      technicianId: { type: "string", nullable: true },
      technicianName: { type: "string", nullable: true },
      status: { type: "string", enum: ["not_started", "in_progress", "completed"] },
      total: { type: "integer" },
      completed: { type: "integer" },
      skipped: { type: "integer" },
      issueCount: { type: "integer" },
      paymentHolds: { type: "integer" },
      scheduledValue: { type: "number", description: "Sum of every non-cancelled stop's price today (GAP-035)." },
      completedValue: { type: "number", description: "Sum of COMPLETED stops' prices today." },
      value: { type: "number", deprecated: true, description: "Same as completedValue; kept for one release (GAP-035)." },
      etaMinutes: { type: "integer", nullable: true, description: "Always null — no real estimate yet." },
    },
  },

  TodayTechnicianCard: {
    type: "object",
    required: ["technicianId", "completed", "remaining", "issueCount", "onTrack"],
    properties: {
      technicianId: { type: "string" },
      technicianName: { type: "string", nullable: true },
      completed: { type: "integer" },
      remaining: { type: "integer" },
      roundName: { type: "string", nullable: true },
      issueCount: { type: "integer" },
      onTrack: { type: "boolean", description: "True when issueCount is 0." },
    },
  },

  TodaysWorkAggregate: {
    type: "object",
    description: "GET /today — Today's Work aggregate (Screen 12): KPI tiles, rounds table, technician workload cards.",
    required: ["date", "generatedAt", "dayClosed", "kpi", "rounds", "technicians"],
    properties: {
      date: { type: "string", format: "date" },
      generatedAt: { ...dateTime, description: "When this aggregate was computed (for \"Updated HH:mm\")." },
      dayClosed: { type: "boolean", description: "True once POST /today/close has run for this date." },
      kpi: ref("TodayKpi"),
      rounds: { type: "array", items: ref("TodayRoundRow") },
      technicians: { type: "array", items: ref("TodayTechnicianCard") },
    },
  },

  CloseDaySummary: {
    type: "object",
    description: "POST /today/close response — a snapshot of the day right before closing.",
    required: ["completedJobs", "skippedJobs", "outstanding", "issues", "paymentHolds", "revenue"],
    properties: {
      completedJobs: { type: "integer" },
      skippedJobs: { type: "integer", description: "Includes visits just marked SKIPPED by this call when unfinishedAction is mark_as_skipped." },
      outstanding: { type: "integer", description: "Visits pushed to the next working day; 0 when unfinishedAction is mark_as_skipped." },
      issues: { type: "integer" },
      paymentHolds: { type: "integer" },
      revenue: { type: "number", description: "Sum of completed-visit prices for the day." },
    },
  },

  // ---- Technicians (new directory router — distinct from /settings/technicians) ----
  TechnicianServiceAreaRow: {
    type: "object",
    required: ["serviceAreaId", "serviceAreaName", "assignedAt"],
    properties: {
      serviceAreaId: { type: "string" },
      serviceAreaName: { type: "string" },
      assignedAt: dateTime,
    },
  },

  TechnicianListItem: {
    type: "object",
    description: "Base shape shared by GET /technicians/{id}, and the response of POST /technicians / PATCH /technicians/{id}. Distinct from the Settings → /settings/technicians directory (TechnicianWithDisplayName) — this router adds email/notes/serviceAreas and today/round derived data.",
    required: ["id", "active", "appStatus", "serviceAreas", "createdAt"],
    properties: {
      id: { type: "string" },
      name: { type: "string", nullable: true },
      phone: { type: "string", nullable: true },
      role: { type: "string", nullable: true },
      email: { type: "string", nullable: true },
      notes: { type: "string", nullable: true },
      active: { type: "boolean" },
      appStatus: { type: "string", enum: ["PENDING_INVITE", "ACTIVE", "INACTIVE"] },
      serviceAreas: { type: "array", items: ref("TechnicianServiceAreaRow") },
      createdAt: dateTime,
    },
  },

  TodayStats: {
    type: "object",
    required: ["total", "completed", "skipped", "remaining"],
    properties: {
      total: { type: "integer" },
      completed: { type: "integer" },
      skipped: { type: "integer" },
      remaining: { type: "integer" },
    },
  },

  TechnicianListRow: {
    description: "GET /technicians row — TechnicianListItem plus round names and today's job stats, computed up front so the frontend doesn't have to fan out one GET /technicians/{id} call per row.",
    allOf: [
      ref("TechnicianListItem"),
      {
        type: "object",
        required: ["roundNames", "todayStats"],
        properties: {
          roundNames: { type: "array", items: { type: "string" } },
          todayStats: ref("TodayStats"),
        },
      },
    ],
  },

  WorkloadRoundRow: {
    type: "object",
    required: ["roundId", "roundName", "total", "completed", "skipped", "remaining"],
    properties: {
      roundId: { type: "string" },
      roundName: { type: "string" },
      total: { type: "integer" },
      completed: { type: "integer" },
      skipped: { type: "integer" },
      remaining: { type: "integer" },
    },
  },

  TechnicianDetail: {
    description: "GET /technicians/{id} — TechnicianListItem plus round names and a per-round breakdown of today's workload.",
    allOf: [
      ref("TechnicianListItem"),
      {
        type: "object",
        required: ["roundNames", "todayWorkload"],
        properties: {
          roundNames: { type: "array", items: { type: "string" } },
          todayWorkload: { type: "array", items: ref("WorkloadRoundRow") },
        },
      },
    ],
  },

  // ---- Messages ----
  MessageSendResult: {
    type: "object",
    required: ["status", "messageId", "channel"],
    properties: {
      status: { type: "string", enum: ["sent"] },
      messageId: { type: "string", description: "The recorded OUTBOUND Message id." },
      channel: ref("MessageChannel"),
    },
  },

  MessageBulkResult: {
    type: "object",
    required: ["queued"],
    properties: {
      queued: {
        type: "integer",
        description: "Number of recipients the message was actually sent to. Best-effort: a per-recipient failure is logged and skipped, not surfaced as an error.",
      },
    },
  },

  // ---- Setup steps 9–12 ----
  Customer: {
    type: "object",
    description: "Raw Customer row, as created by Setup step 9 (not the transformed CustomerListRow/CustomerDetail shapes used elsewhere).",
    properties: {
      id: { type: "string" },
      name: { type: "string" },
      phone: { type: "string", nullable: true },
      landline: { type: "string", nullable: true },
      email: { type: "string", nullable: true },
      status: ref("LifecycleStatus"),
      ghlContactId: { type: "string", nullable: true },
      stripeCustomerId: { type: "string", nullable: true },
      stripeDefaultPaymentMethodId: { type: "string", nullable: true },
      gocardlessCustomerId: { type: "string", nullable: true },
      gocardlessMandateId: { type: "string", nullable: true },
      gocardlessMandateStatus: { type: "string", nullable: true },
      paymentMethod: nullableRef("PaymentMethod"),
      badDebt: { type: "boolean" },
      holdNextClean: { type: "boolean" },
      holdReason: { type: "string", nullable: true },
      holdSince: { ...dateTime, nullable: true },
      messagesOptOut: { type: "boolean", description: "Opted out of automated messages (pre-clean reminders, visit-completed)." },
      createdAt: dateTime,
      updatedAt: dateTime,
    },
  },

  ServicePlan: {
    type: "object",
    description: "Raw ServicePlan row (PATCH /service-plans/{id}, pause/resume, and the plans created by Setup step 9).",
    properties: {
      id: { type: "string" },
      propertyId: { type: "string" },
      serviceId: { type: "string", nullable: true },
      price: money,
      cleanMethod: { type: "string", nullable: true },
      paymentMethod: nullableRef("PaymentMethod"),
      cleaningFrequency: nullableRef("CleaningFrequency"),
      status: ref("LifecycleStatus"),
      nextDueDate: { ...dateTime, nullable: true },
      lastCompleted: { ...dateTime, nullable: true },
      pauseStartDate: { ...dateTime, nullable: true },
      pauseEndDate: { ...dateTime, nullable: true },
      createdAt: dateTime,
      updatedAt: dateTime,
    },
  },

  SetupPropertyResult: {
    type: "object",
    description: "One property added during Setup step 9 — the created Customer, Property, and its ServicePlan(s).",
    required: ["customer", "property", "servicePlan", "servicePlans"],
    properties: {
      customer: ref("Customer"),
      property: ref("Property"),
      servicePlan: ref("ServicePlan"),
      servicePlans: { type: "array", items: ref("ServicePlan"), description: "Every plan created for this row — length > 1 only when serviceIds had more than one entry. servicePlan above is always servicePlans[0] (kept for backward compatibility)." },
      customerMatched: { type: "boolean", description: "GAP-010: true when the property was attached to an existing customer (explicit customerId, or matched by mobile/email) instead of creating one." },
    },
  },

  SetupPropertyRowError: {
    type: "object",
    required: ["row", "field", "error", "message"],
    properties: {
      row: { type: "integer", description: "0-based index into the submitted properties[] array." },
      field: { type: "string" },
      error: { type: "string", description: "The contract field (GAP-009)." },
      message: { type: "string", deprecated: true, description: "Same text as `error`, kept for one release." },
    },
  },

  BulkSetupPropertyResult: {
    type: "object",
    required: ["created", "failed", "results", "errors"],
    properties: {
      created: { type: "integer" },
      failed: { type: "integer" },
      results: { type: "array", items: ref("SetupPropertyResult") },
      errors: { type: "array", items: ref("SetupPropertyRowError") },
      idempotent: {
        type: "boolean",
        description: "True when this exact idempotencyKey was already processed by an earlier call. `results` is empty in that case (not reconstructed), but `created` reflects the original run's count.",
      },
    },
  },

  RoundAssignmentResult: {
    type: "object",
    required: ["roundId", "roundName", "propertyCount", "technicianIds", "technicians"],
    properties: {
      roundId: { type: "string" },
      roundName: { type: "string" },
      defaultDay: { type: "string", nullable: true },
      serviceAreaName: { type: "string", nullable: true },
      propertyCount: { type: "integer" },
      technicianIds: { type: "array", items: { type: "string" } },
      technicians: {
        type: "array",
        items: { type: "object", properties: { id: { type: "string" }, name: { type: "string", nullable: true } } },
      },
    },
  },

  WorkloadEntry: {
    type: "object",
    required: ["technicianId", "roundCount"],
    properties: {
      technicianId: { type: "string" },
      name: { type: "string", nullable: true },
      roundCount: { type: "integer" },
    },
  },

  Step10Result: {
    type: "object",
    description: "GET and POST /setup/step/10 share this shape — the full round/technician assignment board.",
    required: ["totalRounds", "technicianCount", "unassignedCount", "assignments", "workload"],
    properties: {
      totalRounds: { type: "integer" },
      technicianCount: { type: "integer", description: "Active technicians only." },
      unassignedCount: { type: "integer", description: "ACTIVE rounds with zero technicians assigned." },
      assignments: { type: "array", items: ref("RoundAssignmentResult") },
      workload: { type: "array", items: ref("WorkloadEntry") },
    },
  },

  ActivationStatus: {
    type: "object",
    required: ["activated", "visitsGenerated"],
    properties: {
      activated: { type: "boolean", description: "True once at least one SCHEDULED visit exists." },
      visitsGenerated: { type: "integer" },
    },
  },

  ActivationPreview: {
    type: "object",
    required: ["rounds", "total"],
    properties: {
      rounds: {
        type: "array",
        items: {
          type: "object",
          required: ["roundId", "name", "firstVisit", "visits"],
          properties: {
            roundId: { type: "string" },
            name: { type: "string" },
            firstVisit: { type: "string", format: "date", nullable: true },
            visits: { type: "integer" },
          },
        },
      },
      total: { type: "integer" },
    },
    example: { rounds: [{ roundId: "rnd_1", name: "Alnwick Monday", firstVisit: "2026-11-02", visits: 42 }], total: 42 },
  },

  ActivationResult: {
    type: "object",
    required: ["visitsGenerated"],
    properties: { visitsGenerated: { type: "integer" } },
  },

  ReviewChecklistItem: {
    type: "object",
    required: ["label", "complete"],
    properties: {
      label: { type: "string" },
      complete: { type: "boolean" },
    },
  },

  ReviewChecklist: {
    type: "object",
    required: ["checklist", "allComplete"],
    properties: {
      checklist: { type: "array", items: ref("ReviewChecklistItem") },
      allComplete: { type: "boolean" },
    },
  },

  // ---- Debt ----
  DebtKpis: {
    type: "object",
    required: ["totalOutstandings", "totalOutstandingsCount", "badDebt", "badDebtCount", "failedGoCardless", "dueBeforeClean", "holdNextClean"],
    properties: {
      totalOutstandings: { type: "number", description: "Sum of SENT invoice amounts, excluding bad-debt customers." },
      totalOutstandingsCount: { type: "integer", description: "Non-bad-debt customers with at least one SENT invoice." },
      badDebt: { type: "number", description: "Sum of SENT invoice amounts for customers flagged badDebt." },
      badDebtCount: { type: "integer", description: "Bad-debt customers with at least one SENT invoice." },
      failedGoCardless: { type: "integer" },
      dueBeforeClean: { type: "integer" },
      holdNextClean: { type: "integer", description: "Distinct customers currently on hold." },
    },
  },

  DebtBoardRow: {
    type: "object",
    required: ["invoiceId", "invoiceNumber", "amount", "customerId", "customerName", "addressLine", "badDebt", "holdNextClean"],
    description:
      "One SENT invoice per row — except bucket ON_HOLD, which lists one row per held customer (matching its count, even without SENT invoices): there `invoiceId`/`invoiceNumber`/`dueDate` describe the customer's oldest SENT invoice (null when none) and `amount` is the customer's total outstanding; sorted by holdSince, then createdAt.",
    properties: {
      invoiceId: { type: "string", nullable: true, description: "Null only in the ON_HOLD bucket (customer without a SENT invoice)." },
      invoiceNumber: { type: "string", nullable: true },
      amount: { type: "number" },
      dueDate: { ...dateTime, nullable: true },
      customerId: { type: "string" },
      customerName: { type: "string" },
      addressLine: { type: "string", description: "Empty string when the invoice has no linked visit." },
      postcode: { type: "string", nullable: true },
      paymentMethod: nullableRef("PaymentMethod"),
      lastContactedAt: { ...dateTime, nullable: true, description: "Most recent OUTBOUND message to this customer, across any channel." },
      badDebt: { type: "boolean" },
      holdNextClean: { type: "boolean" },
    },
  },

  DebtBoardResult: {
    type: "object",
    required: ["rows", "pagination"],
    properties: {
      rows: { type: "array", items: ref("DebtBoardRow") },
      pagination: ref("Pagination"),
    },
  },

  DebtBucketCounts: {
    type: "object",
    description: "All 7 bucket-tab counts in one call — replaces the old one-GET-/debt/board-per-tab pattern.",
    required: ["BAD_DEBT", "ON_HOLD", "FAILED_GC", "DUE_BEFORE_CLEAN", "SEVEN_DAYS_OVER", "FOURTEEN_DAYS_OVER", "ALL"],
    properties: {
      BAD_DEBT: { type: "integer" },
      ON_HOLD: { type: "integer" },
      FAILED_GC: { type: "integer" },
      DUE_BEFORE_CLEAN: { type: "integer" },
      SEVEN_DAYS_OVER: { type: "integer" },
      FOURTEEN_DAYS_OVER: { type: "integer" },
      ALL: { type: "integer", description: "Catch-all bucket: everything not already in one of the other 6." },
    },
  },

  DebtInvoiceDetail: {
    type: "object",
    description: "GET /debt/{id} — the fields the board row doesn't carry (phone/email/round/next visit/mandate/recent visits).",
    required: ["invoiceId", "invoiceNumber", "amount", "status", "customerId", "customerName", "recentVisits"],
    properties: {
      invoiceId: { type: "string" },
      invoiceNumber: { type: "string" },
      amount: { type: "number" },
      dueDate: { ...dateTime, nullable: true },
      status: ref("InvoiceStatus"),
      customerId: { type: "string" },
      customerName: { type: "string" },
      phone: { type: "string", nullable: true },
      email: { type: "string", nullable: true },
      roundId: { type: "string", nullable: true },
      roundName: { type: "string", nullable: true },
      nextVisitDate: { ...dateTime, nullable: true, description: "Next SCHEDULED/IN_PROGRESS visit for this customer." },
      mandateId: { type: "string", nullable: true },
      mandateStatus: { type: "string", nullable: true },
      recentVisits: {
        type: "array",
        description: "Most recent 5 visits for this customer, newest first.",
        items: {
          type: "object",
          properties: {
            visitId: { type: "string" },
            date: dateTime,
            status: ref("VisitStatus"),
            amount: { type: "number" },
          },
        },
      },
    },
  },

  PaymentLinkResult: {
    type: "object",
    required: ["url", "messageId", "channel", "id", "paymentUrl", "provider", "expiresAt"],
    properties: {
      url: { type: "string", description: "Stripe Checkout URL." },
      messageId: { type: "string", description: "The recorded OUTBOUND Message." },
      channel: ref("MessageChannel"),
      id: { type: "string", deprecated: true, description: "Same as messageId (kept for one release)." },
      paymentUrl: { type: "string", deprecated: true, description: "Same as url (kept for one release)." },
      provider: { type: "string", enum: ["stripe"], deprecated: true },
      expiresAt: { ...dateTime, nullable: true },
    },
  },

  ReminderResult: {
    type: "object",
    required: ["id", "messageId", "channel"],
    properties: {
      messageId: { type: "string", description: "The recorded OUTBOUND Message." },
      channel: ref("MessageChannel"),
      id: { type: "string", deprecated: true, description: "Same as messageId." },
    },
  },

  BadDebtFlagResult: {
    type: "object",
    required: ["customerId", "badDebt"],
    properties: {
      customerId: { type: "string" },
      badDebt: { type: "boolean" },
    },
  },

  HoldFlagResult: {
    type: "object",
    required: ["customerId", "holdNextClean"],
    properties: {
      customerId: { type: "string" },
      holdNextClean: { type: "boolean" },
      holdReason: { type: "string", nullable: true },
      holdSince: { ...dateTime, nullable: true },
      visitsUpdated: { type: "integer", description: "Upcoming SCHEDULED visits whose paymentHold was set (hold) or cleared (release)." },
    },
  },

  // ---- Reports ----
  ActivityLogRow: {
    type: "object",
    required: ["id", "type", "message", "createdAt"],
    properties: {
      id: { type: "string" },
      type: { type: "string", example: "ROUND_UPDATED" },
      message: { type: "string" },
      actorRole: { type: "string", nullable: true },
      actorName: { type: "string", nullable: true, description: "Resolved from the public-schema Profile matching the log's actorId." },
      createdAt: dateTime,
    },
  },

  ReportsActivityResult: {
    type: "object",
    required: ["rows", "pagination"],
    properties: {
      rows: { type: "array", items: ref("ActivityLogRow") },
      pagination: ref("Pagination"),
    },
  },

  ReportsVisitRow: {
    type: "object",
    required: ["visitId", "date", "property", "status", "amount"],
    properties: {
      visitId: { type: "string" },
      date: dateTime,
      property: { type: "string" },
      postcode: { type: "string", nullable: true },
      round: { type: "string", nullable: true },
      technician: { type: "string", nullable: true },
      status: ref("VisitStatus"),
      amount: { type: "number" },
    },
  },

  ReportsVisitsResult: {
    type: "object",
    required: ["rows", "pagination"],
    properties: {
      rows: { type: "array", items: ref("ReportsVisitRow") },
      pagination: ref("Pagination"),
    },
  },

  ReportsTechnicianRow: {
    type: "object",
    required: ["technicianId", "completed", "skipped", "efficiency", "revenueImpact"],
    properties: {
      technicianId: { type: "string" },
      name: { type: "string", nullable: true },
      email: { type: "string", nullable: true },
      completed: { type: "integer" },
      skipped: { type: "integer" },
      efficiency: { type: "integer", description: "completed / (completed + skipped) × 100, rounded. 0 when there are no completed-or-skipped visits." },
      revenueImpact: { type: "number", description: "Sum of completed-visit prices for this technician in the period." },
    },
  },

  ReportsTechniciansResult: {
    type: "object",
    required: ["rows", "pagination"],
    properties: {
      rows: { type: "array", items: ref("ReportsTechnicianRow") },
      pagination: ref("Pagination"),
    },
  },

  ReportsRevenueRow: {
    type: "object",
    required: ["date", "amount"],
    properties: {
      date: { type: "string", format: "date" },
      amount: { type: "number" },
    },
  },

  ReportsSummary: {
    type: "object",
    required: ["totalRevenue", "completedVisits", "completedRounds", "undonePayments"],
    properties: {
      totalRevenue: { type: "number", description: "Sum of completed-visit prices in the period." },
      completedVisits: { type: "integer" },
      completedRounds: { type: "integer", description: "Distinct rounds with ≥ 1 completed visit in the period." },
      undonePayments: { type: "number", description: "Sum of SENT invoice amounts (all time, not period-scoped)." },
    },
  },

  // ---- Invoices ----
  InvoiceLineItem: {
    type: "object",
    required: ["description", "amount"],
    properties: {
      description: { type: "string" },
      technicianName: { type: "string", nullable: true },
      amount: { type: "number" },
    },
  },

  InvoicePreview: {
    type: "object",
    description: "GET /invoices/preview and /invoices/preview/pdf — a not-yet-saved invoice computed live from a visit. 409 if the visit already has an invoice.",
    required: ["invoiceNumber", "invoiceDate", "visitDate", "lineItems", "subtotal", "vatAmount", "total", "amount", "currency"],
    properties: {
      invoiceNumber: { type: "string" },
      invoiceDate: { type: "string", format: "date" },
      visitDate: { type: "string", format: "date" },
      dueDate: { type: "string", format: "date", nullable: true, description: "Always null for a preview — only set once created via POST /invoices." },
      paymentMethod: nullableRef("PaymentMethod"),
      customer: {
        type: "object",
        properties: {
          name: { type: "string" },
          addressLine: { type: "string" },
          postcode: { type: "string", nullable: true },
          email: { type: "string", nullable: true },
          phone: { type: "string", nullable: true },
        },
      },
      lineItems: { type: "array", items: ref("InvoiceLineItem") },
      subtotal: { type: "number" },
      vatAmount: { type: "number", description: "0 when BusinessSettings.vatInInvoices is false." },
      total: { type: "number" },
      amount: { type: "number", description: "Alias of total, for convenience." },
      currency: { type: "string", description: "Business currency symbol, e.g. \"£\".", example: "£" },
      business: {
        type: "object",
        properties: {
          name: { type: "string", nullable: true },
          email: { type: "string", nullable: true },
        },
      },
    },
  },

  InvoiceDetail: {
    type: "object",
    description: "GET /invoices/{id} — the saved invoice with line items, technician, visit date, and a VAT/subtotal breakdown. Degrades gracefully (visitId/visitDate/technicianName/roundName all null, lineItems empty) when the invoice has no linked visit — unlike the PDF route, which 409s in that case.",
    required: ["id", "invoiceNumber", "status", "amount", "sentToCustomer", "createdAt", "customerId", "lineItems", "subtotal", "vatAmount"],
    properties: {
      id: { type: "string" },
      invoiceNumber: { type: "string" },
      status: ref("InvoiceStatus"),
      amount: { type: "number" },
      dueDate: { type: "string", format: "date", nullable: true },
      notes: { type: "string", nullable: true },
      sentToCustomer: { type: "boolean" },
      sentAt: { ...dateTime, nullable: true },
      createdAt: dateTime,
      customerId: { type: "string" },
      visitId: { type: "string", nullable: true },
      visitDate: { ...dateTime, nullable: true },
      technicianName: { type: "string", nullable: true },
      roundName: { type: "string", nullable: true },
      paymentMethod: nullableRef("PaymentMethod"),
      customer: {
        type: "object",
        properties: {
          name: { type: "string" },
          email: { type: "string", nullable: true },
          phone: { type: "string", nullable: true },
          addressLine: { type: "string", nullable: true },
          postcode: { type: "string", nullable: true },
        },
      },
      lineItems: { type: "array", items: ref("InvoiceLineItem") },
      subtotal: { type: "number" },
      vatAmount: { type: "number" },
    },
  },

  InvoiceActionResult: {
    type: "object",
    description: "Shared response shape for POST /invoices (create) and POST /invoices/{id}/send.",
    required: ["id", "invoiceNumber", "status", "sentToCustomer"],
    properties: {
      id: { type: "string" },
      invoiceNumber: { type: "string" },
      status: ref("InvoiceStatus"),
      sentToCustomer: { type: "boolean" },
      sentAt: { ...dateTime, nullable: true },
    },
  },

  // ---- Payments ----
  StripeSessionResult: {
    type: "object",
    required: ["url", "sessionId"],
    properties: {
      url: { type: "string", description: "Hosted Stripe Checkout URL to redirect the customer to." },
      sessionId: { type: "string", description: "The persisted StripeSession row id (not Stripe's own session id)." },
    },
  },

  Payment: {
    type: "object",
    description: "Raw Payment row (Decimal `amount` serialised as a string).",
    properties: {
      id: { type: "string" },
      customerId: { type: "string" },
      visitId: { type: "string", nullable: true },
      amount: money,
      method: ref("PaymentMethod"),
      status: ref("PaymentStatus"),
      gocardlessId: { type: "string", nullable: true },
      stripeId: { type: "string", nullable: true },
      stripeReceiptUrl: { type: "string", nullable: true },
      contactedAt: { ...dateTime, nullable: true },
      paidAt: { ...dateTime, nullable: true },
      reference: { type: "string", nullable: true, description: "Manual-payment reference: cheque number (mobile completion / debt payment) or the reference given to POST /invoices/{id}/mark-paid." },
      createdAt: dateTime,
      updatedAt: dateTime,
    },
  },

  VisitCompleteResult: {
    type: "object",
    required: ["id", "status", "payment"],
    properties: {
      id: { type: "string" },
      status: ref("VisitStatus"),
      payment: {
        type: "object",
        nullable: true,
        description: "The Payment created by this completion (null when none was created, e.g. already completed or STRIPE/no method).",
        required: ["id", "method", "status", "amount"],
        properties: { id: { type: "string" }, method: ref("PaymentMethod"), status: ref("PaymentStatus"), amount: { type: "number" } },
      },
    },
    example: { id: "vis_example", status: "COMPLETED", payment: { id: "pay_1", method: "CASH", status: "PAID", amount: 18 } },
  },

  CompletionPaymentInput: {
    type: "object",
    required: ["method"],
    description: "What the technician collected on site. CASH → PAID payment; CHEQUE → PENDING payment with the cheque number on Payment.reference; NONE → fall back to the effective method.",
    properties: {
      method: { type: "string", enum: ["CASH", "CHEQUE", "NONE"] },
      amount: { type: "number", exclusiveMinimum: true, minimum: 0, maximum: 9999.99, description: "Defaults to the visit price." },
      chequeNumber: { type: "string", maxLength: 50, description: "Required for CHEQUE (400 CHEQUE_NUMBER_REQUIRED)." },
    },
    example: { method: "CHEQUE", chequeNumber: "000123" },
  },

  VisitPhotosResult: {
    type: "object",
    required: ["rows", "pagination"],
    properties: {
      rows: { type: "array", items: ref("PhotoRow") },
      pagination: ref("Pagination"),
    },
  },

  // ---- Customers: invoices / properties / GoCardless mandate ----
  CustomerInvoiceRow: {
    type: "object",
    required: ["id", "invoiceNumber", "status", "amount", "sentToCustomer", "createdAt", "payment"],
    properties: {
      id: { type: "string" },
      invoiceNumber: { type: "string" },
      status: ref("InvoiceStatus"),
      amount: { type: "number" },
      dueDate: { ...dateTime, nullable: true },
      paidAt: { ...dateTime, nullable: true },
      sentToCustomer: { type: "boolean" },
      sentAt: { ...dateTime, nullable: true },
      createdAt: dateTime,
      visitId: { type: "string", nullable: true },
      payment: {
        type: "object",
        nullable: true,
        description: "The linked visit's Payment, if any.",
        required: ["id", "status", "method"],
        properties: { id: { type: "string" }, status: ref("PaymentStatus"), method: ref("PaymentMethod") },
      },
    },
  },

  CustomerPropertyAddResult: {
    type: "object",
    required: ["propertyId", "servicePlanId", "assigned"],
    properties: {
      propertyId: { type: "string" },
      servicePlanId: { type: "string" },
      assigned: { type: "boolean", description: "True when a `roundId` was supplied." },
    },
  },

  MandateRedirectResult: {
    type: "object",
    required: ["url"],
    properties: {
      url: { type: "string", description: "GoCardless hosted redirect-flow URL to send the customer to." },
    },
  },

  MandateCompleteResult: {
    type: "object",
    required: ["mandateId", "status"],
    properties: {
      mandateId: { type: "string" },
      status: { type: "string", enum: ["pending_customer_approval"] },
    },
  },

  // ---- Auth: per-user UI preferences ----
  PreferencesResult: {
    type: "object",
    required: ["preferences"],
    properties: {
      preferences: {
        type: "object",
        additionalProperties: true,
        description: "Free-form JSON blob owned by the frontend; `{}` when nothing is stored.",
      },
    },
    example: { preferences: { rememberMe: true, debtBoardFilter: "overdue" } },
  },

  // ---- Mobile (technician app) ----
  MobileMe: {
    type: "object",
    required: ["name", "email", "dateOfBirth", "avatarUrl", "avatarSignedUrl", "areaName"],
    properties: {
      name: { type: "string" },
      email: { type: "string", nullable: true, description: "From the JWT." },
      dateOfBirth: { type: "string", format: "date", nullable: true },
      avatarUrl: { type: "string", nullable: true, description: "Stored value (storage path from /mobile/me/avatar/upload-url) from the caller's Technician row; null if none." },
      avatarSignedUrl: {
        type: "string",
        nullable: true,
        description: "1-hour signed read URL for `avatarUrl` — use this to display the image. External URLs pass through unchanged; null when no avatar, the path is outside the caller's tenant, or signing failed.",
      },
      areaName: { type: "string", nullable: true, description: "Name of the technician's first linked service area." },
    },
  },

  SignedUploadUrl: {
    type: "object",
    required: ["signedUrl", "path"],
    description: "Supabase Storage signed upload URL. PUT the file bytes to `signedUrl`, then record the resulting URL with the matching POST endpoint.",
    properties: {
      signedUrl: { type: "string" },
      path: { type: "string", description: "Object path inside the storage bucket, e.g. `<tenantId>/visits/<visitId>/before-1696248000000.jpg`." },
    },
  },

  MobileNotification: {
    type: "object",
    required: ["id", "profileId", "type", "title", "body", "read", "createdAt"],
    properties: {
      id: { type: "string" },
      profileId: { type: "string" },
      type: { type: "string", example: "ROUND_UPDATE" },
      title: { type: "string" },
      body: { type: "string", nullable: true },
      read: { type: "boolean" },
      createdAt: dateTime,
    },
  },

  MobileNotificationPage: {
    type: "object",
    required: ["notifications", "unreadCount", "nextCursor"],
    properties: {
      notifications: { type: "array", items: ref("MobileNotification"), description: "Newest first, 30 per page." },
      unreadCount: { type: "integer" },
      nextCursor: { type: "string", nullable: true, description: "Pass as `?cursor=` for the next page; null on the last page." },
    },
  },

  MobileCompany: {
    type: "object",
    required: ["name", "phone", "email", "termsUrl", "privacyUrl"],
    properties: {
      name: { type: "string", nullable: true },
      phone: { type: "string", nullable: true },
      email: { type: "string", nullable: true },
      termsUrl: { type: "string", nullable: true },
      privacyUrl: { type: "string", nullable: true },
    },
  },

  MobileVisitRow: {
    type: "object",
    required: ["visitId", "status", "price", "paymentMethod", "customerName", "addressLine", "postcode", "latitude", "longitude", "roundId", "roundName", "serviceName", "notes", "issueCount", "propertyNotes", "startedAt", "arrivedAt", "completedAt", "hasDebt", "position"],
    properties: {
      visitId: { type: "string" },
      status: ref("VisitStatus"),
      price: { type: "number" },
      paymentMethod: { ...nullableRef("PaymentMethod"), description: "Effective method: visit override → service plan → customer default; null only when none of those is set." },
      customerName: { type: "string" },
      addressLine: { type: "string" },
      postcode: { type: "string" },
      latitude: { type: "number", nullable: true },
      longitude: { type: "number", nullable: true },
      roundId: { type: "string", nullable: true },
      roundName: { type: "string", nullable: true },
      serviceName: { type: "string", nullable: true },
      notes: { type: "string", nullable: true },
      issueCount: { type: "integer" },
      propertyNotes: {
        type: "array",
        items: { type: "object", required: ["type", "body"], properties: { type: ref("NoteType"), body: { type: "string" } } },
      },
      startedAt: { ...dateTime, nullable: true, description: "Set by PATCH /mobile/visits/{id}/start." },
      arrivedAt: { ...dateTime, nullable: true, description: "Set by PATCH /mobile/visits/{id}/arrive." },
      completedAt: { ...dateTime, nullable: true },
      hasDebt: { type: "boolean", description: "Customer.badDebt." },
      position: { type: "integer", nullable: true, description: "1-based order within its round today (date asc, createdAt asc); null for visits with no round." },
    },
  },

  MobileRoundSummary: {
    type: "object",
    required: ["roundId", "roundName", "totalCount", "completedCount", "expectedRevenue", "earnedRevenue", "date"],
    properties: {
      roundId: { type: "string" },
      roundName: { type: "string" },
      totalCount: { type: "integer" },
      completedCount: { type: "integer" },
      expectedRevenue: { type: "number" },
      earnedRevenue: { type: "number" },
      date: dateTime,
    },
  },

  MobileCompletions: {
    type: "object",
    required: ["revenueToday", "revenueByMethod", "revenueChangePercent", "completedCount", "skippedCount", "totalCount", "roundName", "visits"],
    properties: {
      revenueToday: { type: "number" },
      revenueByMethod: {
        type: "object",
        required: ["cash", "directDebit", "other"],
        description: "Split by the visit's own `paymentMethod` (CASH → cash, GOCARDLESS → directDebit, anything else incl. null → other).",
        properties: { cash: { type: "number" }, directDebit: { type: "number" }, other: { type: "number" } },
      },
      revenueChangePercent: { type: "integer", nullable: true, description: "vs the same day last week; null when last week's revenue was 0." },
      completedCount: { type: "integer" },
      skippedCount: { type: "integer" },
      totalCount: { type: "integer" },
      roundName: { type: "string", nullable: true },
      visits: { type: "array", items: ref("MobileVisitRow"), description: "Today's COMPLETED visits only." },
    },
  },

  MobileVisitDetail: {
    type: "object",
    description:
      "The raw Visit row (Decimal fields as strings) with `property` (incl. customer + DRAFT/SENT invoices + notes), `round`, `service`, `technician`, `photos` and `_count.issues` included, plus the computed fields below.",
    additionalProperties: true,
    properties: {
      id: { type: "string" },
      date: dateTime,
      status: ref("VisitStatus"),
      price: money,
      originalPrice: { ...money, nullable: true, description: "Set once the price has been adjusted; null at full price." },
      priceAdjustmentReason: { type: "string", nullable: true },
      paymentMethod: { ...nullableRef("PaymentMethod"), description: "Effective method: visit override → service plan → customer default; null only when none of those is set." },
      photos: { type: "array", items: ref("MobileVisitPhoto"), description: "Every photo recorded on the visit (BEFORE/AFTER/ACCESS_ISSUE), oldest first." },
      startedAt: { ...dateTime, nullable: true },
      arrivedAt: { ...dateTime, nullable: true },
      completedAt: { ...dateTime, nullable: true },
      property: { type: "object", additionalProperties: true },
      round: { type: "object", nullable: true, properties: { id: { type: "string" }, name: { type: "string" } } },
      service: { type: "object", nullable: true, properties: { id: { type: "string" }, name: { type: "string" } } },
      technician: { type: "object", nullable: true, properties: { name: { type: "string", nullable: true }, role: { type: "string", nullable: true } } },
      lastClean: { ...dateTime, nullable: true, description: "completedAt of the property's previous COMPLETED visit." },
      roundPosition: {
        type: "object",
        nullable: true,
        properties: { position: { type: "integer" }, total: { type: "integer" } },
      },
      activityLog: {
        type: "array",
        items: {
          type: "object",
          properties: {
            event: { type: "string", enum: ["dispatched", "started", "arrived", "completed"] },
            timestamp: dateTime,
          },
        },
      },
      outstandingInvoices: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            invoiceNumber: { type: "string" },
            amount: { type: "number" },
            dueDate: { ...dateTime, nullable: true },
          },
        },
      },
      debtAmount: { type: "number", description: "Sum of DRAFT/SENT invoice amounts." },
      canStart: { type: "boolean", description: "Debt-gate result (see PATCH /mobile/visits/{id}/start)." },
      blockReason: { type: "string", nullable: true },
    },
  },

  MobileVisitPhoto: {
    type: "object",
    required: ["id", "type", "url", "signedUrl", "issueId", "createdAt"],
    properties: {
      id: { type: "string" },
      type: ref("PhotoType"),
      url: { type: "string", description: "Stored value (storage path from the upload-url step)." },
      signedUrl: { type: "string", nullable: true, description: "1-hour signed read URL — use this to display the photo. null if signing failed." },
      issueId: { type: "string", nullable: true, description: "Set for ACCESS_ISSUE photos: the access-issue report they belong to." },
      createdAt: dateTime,
    },
  },

  MobileAccessIssueResult: {
    type: "object",
    required: ["recorded", "id", "photoCount"],
    properties: {
      recorded: { type: "boolean", enum: [true] },
      id: { type: "string", description: "The new Issue id." },
      photoCount: { type: "integer", description: "Number of ACCESS_ISSUE photos attached." },
    },
  },

  MobileStatusResult: {
    type: "object",
    required: ["status"],
    properties: { status: ref("VisitStatus") },
  },

  MobileDebtPaymentResult: {
    type: "object",
    required: ["cleared", "amountPaid", "amountPending", "method"],
    properties: {
      cleared: { type: "boolean", description: "false for CHEQUE (invoices stay open until the cheque clears)." },
      amountPaid: { type: "number", description: "CASH total; 0 for CHEQUE or when nothing was outstanding." },
      amountPending: { type: "number", description: "CHEQUE total awaiting clearance; 0 otherwise." },
      method: { type: "string", enum: ["CASH", "CHEQUE"] },
    },
  },

  MobileUpsell: {
    type: "object",
    required: ["id", "type", "amount", "note", "visitId", "createdAt"],
    properties: {
      id: { type: "string" },
      type: { type: "string", enum: ["UPSELL"] },
      amount: { type: "number" },
      note: { type: "string", nullable: true, description: "The description." },
      visitId: { type: "string", nullable: true },
      createdAt: dateTime,
    },
  },

  ChatMessage: {
    type: "object",
    required: ["id", "roundId", "senderProfileId", "isMine", "body", "type", "visitId", "photoUrls", "photoSignedUrls", "createdAt"],
    properties: {
      id: { type: "string" },
      roundId: { type: "string" },
      senderProfileId: {
        type: "string",
        description: "The sender's Profile id (D-4). Rows written before that fix hold the sender's Supabase user id.",
      },
      isMine: { type: "boolean", description: "Sent by the signed-in technician (matches either id form)." },
      body: { type: "string", nullable: true },
      type: { type: "string", enum: ["TEXT", "WORK_PHOTOS", "PHOTOS"] },
      visitId: { type: "string", nullable: true },
      photoUrls: { type: "array", items: { type: "string" }, description: "Stored values (storage paths from /mobile/messages/attachments/upload-url)." },
      photoSignedUrls: {
        type: "array",
        items: { type: "string", nullable: true },
        description: "1-hour signed read URLs, index-aligned with `photoUrls` — use these to display the images. An entry is null when the path is outside the caller's tenant or signing failed.",
      },
      createdAt: dateTime,
    },
  },

  SupportReportResult: {
    type: "object",
    required: ["id", "createdAt"],
    properties: { id: { type: "string" }, createdAt: dateTime },
  },
};

// ---------------------------------------------------------------------------
// 4. Inputs — Setup Wizard request bodies.
// ---------------------------------------------------------------------------

const inputSchemas: Record<string, OpenAPIV3.SchemaObject> = {
  BusinessProfileInput: {
    type: "object",
    required: ["businessName"],
    properties: {
      businessName: { type: "string", minLength: 1 },
      phone: { type: "string" },
      email: { type: "string" },
      companyNumber: { type: "string" },
      vatRegistered: { type: "boolean" },
      vatRegistration: { type: "string" },
      defaultWorkingDays: { type: "array", items: { type: "string", enum: ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"] } },
      timezone: { type: "string" },
      currency: { type: "string" },
      bankDetails: { ...nullableRef("BankDetails"), description: "Pass null to clear. Omit to leave unchanged." },
      addressLine1: { type: "string", nullable: true },
      addressLine2: { type: "string", nullable: true },
      town: { type: "string", nullable: true },
      postcode: { type: "string", nullable: true },
      vatRate: { type: "number", minimum: 0, maximum: 100, description: "VAT percentage; 400 outside 0–100." },
    },
    example: {
      businessName: "Acme Window Co",
      phone: "+44 1665 111111",
      vatRegistered: true,
      defaultWorkingDays: ["MON", "TUE", "WED", "THU", "FRI"],
      timezone: "Europe/London",
      currency: "GBP",
    },
  },

  RoundSettingsInput: {
    type: "object",
    required: ["defaultCycleLength"],
    properties: {
      defaultCycleLength: { type: "integer", description: "Cycle length in days." },
      defaultWorkingDays: { type: "array", items: { type: "string", enum: ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"] } },
      reminderMode: ref("ReminderMode"),
      reminderTime: { type: "string", example: "19:00", description: "24-hour HH:mm (400 otherwise)." },
      defaultCleanMethod: nullableRef("CleanMethod"),
      autoCreateNextVisit: { type: "boolean" },
    },
    example: { defaultCycleLength: 28, reminderMode: "EVENING_BEFORE", reminderTime: "19:00" },
  },

  PaymentSetupInput: {
    type: "object",
    description:
      "Setup step 2 (Payment Setup). All fields optional. `gocardlessConnected`/`stripeConnected` were removed (A6): sending either is a 400 with code `FIELD_REMOVED`. Providers are connected through the real flows under /settings (GoCardless token, Stripe Connect, GHL), which the wizard may call before setup is complete.",
    properties: {
      paymentRule: ref("PaymentTiming"),
      debtHoldEnabled: { type: "boolean", description: "Block service if payment is overdue." },
      vatInInvoices: { type: "boolean", description: "Include VAT in invoices by default." },
      defaultPaymentMethod: nullableRef("PaymentMethod"),
      invoiceDueDays: { type: "integer", minimum: 1, maximum: 90 },
      noDirectDebitAction: ref("NoDirectDebitAction"),
    },
    example: { paymentRule: "COLLECT_AFTER_VISIT", debtHoldEnabled: true, vatInInvoices: true },
  },

  ServiceInput: {
    type: "object",
    required: ["name", "defaultPrice"],
    properties: {
      name: { type: "string", minLength: 1 },
      defaultPrice: { type: "number", minimum: 0, maximum: 9999.99, description: "Sent as a number; returned as a string." },
      category: ref("ServiceCategory"),
      description: { type: "string" },
      active: { type: "boolean" },
    },
    example: {
      name: "Full exterior window clean",
      category: "WINDOW_CLEANING",
      defaultPrice: 35,
      active: true,
    },
  },

  TechnicianInput: {
    type: "object",
    description: "Creates an invite-pending technician (profileId = null).",
    properties: {
      name: {
        type: "string",
        description:
          "Admin display label ('invited as…'); persisted to Technician.name. Profile.name wins once the invite is accepted.",
      },
      role: { type: "string" },
      phone: { type: "string" },
      active: { type: "boolean" },
    },
    example: { name: "James Fisher", role: "Senior", phone: "+44 7700 900111" },
  },

  ServiceAreaInput: {
    type: "object",
    required: ["name"],
    properties: {
      name: { type: "string", minLength: 1 },
      postcodeSector: { type: "string" },
      isDefault: { type: "boolean" },
    },
    example: { name: "Alnwick", postcodeSector: "NE66", isDefault: true },
  },

  FirstRoundInput: {
    type: "object",
    required: ["name"],
    properties: {
      name: { type: "string", minLength: 1 },
      defaultDay: ref("DayOfWeek"),
      frequency: ref("CleaningFrequency"),
      serviceAreaId: { type: "string" },
    },
    example: {
      name: "Alnwick Monday",
      defaultDay: "MON",
      frequency: "FOUR_WEEKLY",
      serviceAreaId: "clx...",
    },
  },

  // --- Settings (partial updates: omitted = untouched, null clears) ---
  BusinessProfileUpdateInput: {
    type: "object",
    description: "Partial update — all fields optional. Step-1 fields only; does not touch round-settings fields.",
    properties: {
      businessName: { type: "string", nullable: true },
      phone: { type: "string", nullable: true },
      email: { type: "string", nullable: true },
      companyNumber: { type: "string", nullable: true },
      vatRegistered: { type: "boolean" },
      vatRegistration: { type: "string", nullable: true },
      timezone: { type: "string", nullable: true },
      currency: { type: "string", nullable: true },
      defaultWorkingDays: { type: "array", items: { type: "string", enum: ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"] } },
      bankDetails: { ...nullableRef("BankDetails"), description: "Pass null to clear. Omit to leave unchanged." },
      addressLine1: { type: "string", nullable: true },
      addressLine2: { type: "string", nullable: true },
      town: { type: "string", nullable: true },
      postcode: { type: "string", nullable: true },
      vatRate: { type: "number", minimum: 0, maximum: 100, description: "VAT percentage; 400 outside 0–100." },
    },
    example: { businessName: "Northumberland Window Cleaning", currency: "GBP" },
  },

  RoundSettingsUpdateInput: {
    type: "object",
    description: "Partial update — round-settings fields only.",
    properties: {
      defaultCycleLength: { type: "integer", nullable: true, minimum: 1, maximum: 365, description: "Cycle length in days." },
      defaultWorkingDays: { type: "array", items: { type: "string", enum: ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"] } },
      reminderMode: ref("ReminderMode"),
      reminderTime: { type: "string", example: "19:00", description: "24-hour HH:mm, tenant-local (400 otherwise)." },
      defaultCleanMethod: nullableRef("CleanMethod"),
      autoCreateNextVisit: { type: "boolean" },
      preCleanReminderTimings: {
        type: "array",
        items: { type: "string", enum: ["EVENING_BEFORE", "TWO_HOURS_BEFORE"] },
        maxItems: 2,
        deprecated: true,
        description: "Deprecated (B2) — use reminderMode. Mapped onto reminderMode when reminderMode is omitted.",
      },
    },
    example: { defaultCycleLength: 28, reminderMode: "EVENING_BEFORE", reminderTime: "19:00" },
  },

  ServiceCreateInput: {
    type: "object",
    required: ["name", "defaultPrice"],
    properties: {
      name: { type: "string", minLength: 1 },
      defaultPrice: { type: "number", minimum: 0, maximum: 9999.99, description: "Sent as a number; returned as a string. Zero is valid for free services." },
      category: ref("ServiceCategory"),
      description: { type: "string", nullable: true },
      active: { type: "boolean" },
    },
    example: { name: "Gutter clear", category: "GUTTER_FASCIA", defaultPrice: 60 },
  },

  ServiceUpdateInput: {
    type: "object",
    description: "Partial update — all fields optional.",
    properties: {
      name: { type: "string", minLength: 1 },
      defaultPrice: { type: "number", minimum: 0, maximum: 9999.99 },
      category: ref("ServiceCategory"),
      description: { type: "string", nullable: true },
      active: { type: "boolean" },
    },
  },

  ServiceAreaCreateInput: {
    type: "object",
    required: ["name"],
    properties: {
      name: { type: "string", minLength: 1 },
      postcodeSector: { type: "string", nullable: true },
      isDefault: { type: "boolean" },
    },
    example: { name: "Morpeth", postcodeSector: "NE61" },
  },

  ServiceAreaUpdateInput: {
    type: "object",
    description: "Partial update — all fields optional.",
    properties: {
      name: { type: "string", minLength: 1 },
      postcodeSector: { type: "string", nullable: true },
      isDefault: { type: "boolean" },
    },
  },

  TechnicianCreateInput: {
    type: "object",
    description: "Single invite-pending technician (profileId = null).",
    properties: {
      name: { type: "string", nullable: true, description: "Admin display label." },
      phone: { type: "string", nullable: true },
      role: { type: "string", nullable: true },
      active: { type: "boolean" },
      serviceAreaIds: { type: "array", items: { type: "string" } },
      serviceAreaId: { type: "string", deprecated: true, description: "GAP-004: a singular id from older clients is folded into serviceAreaIds (deduped)." },
    },
    example: { name: "James Fisher", role: "Senior", phone: "+44 7700 900111" },
  },

  TechnicianUpdateInput: {
    type: "object",
    description: "Partial update — all fields optional.",
    properties: {
      name: { type: "string", nullable: true },
      phone: { type: "string", nullable: true },
      role: { type: "string", nullable: true },
      active: { type: "boolean" },
      serviceAreaIds: { type: "array", items: { type: "string" } },
      serviceAreaId: { type: "string", deprecated: true, description: "GAP-004: folded into serviceAreaIds (deduped)." },
    },
  },

  PaymentRulesUpdateInput: {
    type: "object",
    description: "Partial update of payment RULES only — does not touch the connect flags.",
    properties: {
      paymentRule: nullableRef("PaymentTiming"),
      vatInInvoices: { type: "boolean" },
      debtHoldEnabled: { type: "boolean" },
      debtHoldMaxInvoices: { type: "integer", nullable: true, description: "Mobile debt gate: max unpaid (DRAFT/SENT) invoices before Start is blocked. null = any unpaid invoice blocks (when debtHoldEnabled)." },
      debtHoldMaxAmount: { type: "number", nullable: true, description: "Mobile debt gate: max unpaid total before Start is blocked. null = any unpaid amount blocks (when debtHoldEnabled)." },
      defaultPaymentMethod: nullableRef("PaymentMethod"),
      invoiceDueDays: { type: "integer", minimum: 1, maximum: 90 },
      noDirectDebitAction: ref("NoDirectDebitAction"),
    },
    example: { paymentRule: "COLLECT_AFTER_VISIT", vatInInvoices: true, invoiceDueDays: 14 },
  },

  // ---- M2: Customers & Properties — entities & response shapes ----
  Property: {
    type: "object",
    properties: {
      id: { type: "string" },
      customerId: { type: "string" },
      propertyName: { type: "string", nullable: true },
      addressLine: { type: "string" },
      postcode: { type: "string" },
      latitude: { type: "number", nullable: true, description: "Geocoded from postcode; null until the next geocoding backfill tick." },
      longitude: { type: "number", nullable: true },
      serviceAreaId: { type: "string", nullable: true },
      propertyType: { type: "string", nullable: true },
      accessNotes: { type: "string", nullable: true },
      riskNotes: { type: "string", nullable: true },
      status: ref("LifecycleStatus"),
      roundId: { type: "string", nullable: true },
      assignedTechnicianId: { type: "string", nullable: true, description: "A1: this property's technician within a multi-technician round (null = the round's sole technician / round-robin)." },
      createdAt: dateTime,
      updatedAt: dateTime,
    },
  },
  PropertyNote: {
    type: "object",
    properties: {
      id: { type: "string" },
      propertyId: { type: "string" },
      type: ref("NoteType"),
      body: { type: "string" },
      authorProfileId: { type: "string", nullable: true },
      authorName: { type: "string", nullable: true, description: "Derived from the author Profile (list/detail reads)." },
      createdAt: dateTime,
    },
  },
  ServicePlanView: {
    type: "object",
    properties: {
      id: { type: "string" },
      serviceId: { type: "string", nullable: true },
      serviceName: { type: "string", nullable: true },
      price: { type: "number", nullable: true, description: "Numeric (Decimal serialised to a number here, unlike raw money-string fields)." },
      cleanMethod: { type: "string", nullable: true },
      paymentMethod: nullableRef("PaymentMethod"),
      status: ref("LifecycleStatus"),
      nextDueDate: { ...dateTime, nullable: true },
      lastCompleted: { ...dateTime, nullable: true },
      pauseStartDate: { ...dateTime, nullable: true },
      pauseEndDate: { ...dateTime, nullable: true },
      paymentRule: nullableRef("PaymentTiming"),
    },
  },
  CustomerListRow: {
    type: "object",
    properties: {
      customerId: { type: "string" },
      customerName: { type: "string" },
      status: ref("LifecycleStatus"),
      propertyId: { type: "string" },
      addressLine: { type: "string" },
      postcode: { type: "string" },
      latitude: { type: "number", nullable: true, description: "Null until the next geocoding backfill tick picks up the new postcode." },
      longitude: { type: "number", nullable: true },
      roundId: { type: "string", nullable: true },
      roundName: { type: "string", nullable: true },
      frequency: nullableRef("CleaningFrequency"),
      price: { type: "number", nullable: true },
      technicianId: { type: "string", nullable: true },
      technicianName: { type: "string", nullable: true },
      nextDueDate: { ...dateTime, nullable: true },
      nextDue: { ...dateTime, nullable: true, description: "GAP-021: the plan's nextDueDate, else the next open visit's date." },
      paymentStatus: ref("CustomerPaymentStatus"),
      onHold: { type: "boolean" },
      badDebt: { type: "boolean" },
      amountDue: { type: "number", description: "Sum of the customer's unpaid SENT invoices. Omitted for TECHNICIAN viewers." },
    },
  },
  CustomerListResult: {
    type: "object",
    properties: {
      summary: {
        type: "object",
        properties: {
          totalCustomers: { type: "integer" },
          active: { type: "integer" },
          paymentHolds: { type: "integer" },
          amountDue: { type: "number", description: "Sum of unpaid SENT invoices across ACTIVE customers. Omitted for TECHNICIAN viewers." },
        },
      },
      customers: { type: "array", items: ref("CustomerListRow") },
      pagination: ref("Pagination"),
    },
  },
  VisitHistoryRow: {
    type: "object",
    properties: {
      visitId: { type: "string" },
      date: dateTime,
      roundName: { type: "string", nullable: true },
      status: ref("VisitStatus"),
      cancelReason: { type: "string", nullable: true },
      paymentStatus: nullableRef("PaymentStatus"),
      notes: { type: "string", nullable: true },
    },
  },
  CustomerVisitsPage: {
    type: "object",
    required: ["rows", "pagination"],
    properties: {
      rows: { type: "array", items: ref("VisitHistoryRow") },
      pagination: ref("Pagination"),
    },
  },
  CustomerSearchRow: {
    type: "object",
    required: ["id", "name", "phone", "email", "propertyCount", "postcode"],
    properties: {
      id: { type: "string" },
      name: { type: "string" },
      phone: { type: "string", nullable: true },
      email: { type: "string", nullable: true },
      propertyCount: { type: "integer", description: "Non-cancelled properties." },
      postcode: { type: "string", nullable: true, description: "The first non-cancelled property's postcode." },
    },
  },
  PinnedNote: {
    type: "object",
    required: ["pinned", "source", "body"],
    description: "GAP-022: the property's access/risk notes, listed ahead of PropertyNotes.",
    properties: {
      pinned: { type: "boolean", enum: [true] },
      source: { type: "string", enum: ["ACCESS", "RISK"] },
      body: { type: "string" },
    },
  },
  PaymentRow: {
    type: "object",
    properties: {
      visitId: { type: "string" },
      visitDate: dateTime,
      technicianName: { type: "string", nullable: true },
      amount: { type: "number", nullable: true },
      paymentStatus: nullableRef("PaymentStatus"),
      paymentId: { type: "string", nullable: true },
      invoiceStatus: nullableRef("InvoiceStatus"),
      invoiceId: { type: "string", nullable: true },
      invoiceNumber: { type: "string", nullable: true },
      transactionId: { type: "string", nullable: true, description: "Payment.gocardlessId ?? stripeId." },
      canGenerate: { type: "boolean" },
      canDownload: { type: "boolean" },
    },
  },
  CustomerDetail: {
    type: "object",
    description: "Full Customer Detail aggregate (Screen 15, all 6 tabs). Surfaces ONE property — the first ACTIVE one (else the first) — even though POST /customers/{id}/properties can add more; round/technician/next-visit fields are null when that property is unassigned (Property.roundId = null).",
    properties: {
      customer: {
        type: "object",
        properties: {
          id: { type: "string" }, name: { type: "string" },
          phone: { type: "string", nullable: true }, email: { type: "string", nullable: true },
          status: ref("LifecycleStatus"), ghlContactId: { type: "string", nullable: true },
          badDebt: { type: "boolean" },
        },
      },
      property: {
        type: "object",
        nullable: true,
        properties: {
          id: { type: "string" }, addressLine: { type: "string" }, postcode: { type: "string" },
          latitude: { type: "number", nullable: true, description: "Null until the next geocoding backfill tick picks up the new postcode." },
          longitude: { type: "number", nullable: true },
          propertyType: { type: "string", nullable: true }, accessNotes: { type: "string", nullable: true },
          riskNotes: { type: "string", nullable: true }, status: ref("LifecycleStatus"),
          roundId: { type: "string", nullable: true }, roundName: { type: "string", nullable: true },
          serviceAreaId: { type: "string", nullable: true },
        },
      },
      servicePlans: { type: "array", items: ref("ServicePlanView") },
      standingInfo: {
        type: "object",
        properties: {
          frequency: nullableRef("CleaningFrequency"),
          assignedRound: { type: "string", nullable: true },
          technicianName: { type: "string", nullable: true },
          paymentStatus: ref("CustomerPaymentStatus"),
          outstandingBalance: { type: "number", deprecated: true, description: "Same as amountDue (kept for existing clients). Omitted for TECHNICIAN viewers." },
          amountDue: { type: "number", description: "Sum of unpaid SENT invoices. Omitted for TECHNICIAN viewers." },
          nextDue: { ...dateTime, nullable: true, description: "Primary plan nextDueDate, else the next open visit date." },
          lastPaymentDate: { ...dateTime, nullable: true },
          issuesCount: { type: "integer" },
          nextVisitStatus: nullableRef("VisitStatus"),
        },
      },
      tabs: {
        type: "object",
        properties: {
          overview: { type: "object", nullable: true, additionalProperties: true },
          servicePlans: { type: "array", items: ref("ServicePlanView") },
          visitHistory: { type: "array", items: ref("VisitHistoryRow"), description: "Excludes CANCELLED visits — use GET /customers/{id}/visits for the full history." },
          payments: { type: "object", description: "Full payment history including processor transaction IDs. Omitted for TECHNICIAN viewers.", properties: { rows: { type: "array", items: ref("PaymentRow") } } },
          notes: { type: "array", items: ref("PropertyNote") },
          photos: { type: "array", items: { type: "object", additionalProperties: true } },
        },
      },
    },
  },

  // ---- M2: request bodies ----
  PropertyCreateInput: {
    type: "object",
    required: ["customerName", "addressLine", "postcode", "price", "serviceAreaId"],
    properties: {
      customerName: { type: "string", minLength: 1 },
      phone: { type: "string", nullable: true },
      landline: { type: "string", nullable: true },
      email: { type: "string", nullable: true },
      addressLine: { type: "string", minLength: 1 },
      postcode: { type: "string", minLength: 1 },
      propertyName: { type: "string", nullable: true },
      propertyType: { type: "string", nullable: true, enum: ["HOUSE", "FLAT_APARTMENT", "COMMERCIAL", "OFFICE", "CONSERVATORY", null] },
      serviceAreaId: { type: "string", minLength: 1, description: "Required. Must exist (404 if not)." },
      serviceId: { type: "string", nullable: true },
      price: { type: "number", description: "Positive number.", minimum: 0, exclusiveMinimum: true, maximum: 9999.99 },
      cleanMethod: { type: "string", nullable: true },
      paymentMethod: nullableRef("PaymentMethod"),
      nextDueDate: { type: "string", format: "date", nullable: true },
      lastCleanedDate: { type: "string", format: "date", nullable: true, description: "When nextDueDate is omitted and a round is given: nextDueDate = one cycle after this, on the round day (else the round's next day)." },
      accessNotes: { type: "string", nullable: true },
      riskNotes: { type: "string", nullable: true },
      roundId: { type: "string", nullable: true, description: "null = Save & Assign Later (unassigned); an id must exist (404 if not)." },
    },
    example: { customerName: "John Smith", addressLine: "12 Market Street", postcode: "NE66 1SS", price: 35, serviceAreaId: "csa_example", cleanMethod: "Water Fed Pole", paymentMethod: "GOCARDLESS", roundId: null },
  },
  PropertyUpdateInput: {
    type: "object",
    description:
      "Partial update. roundId: null = unassign, an id = assign/reassign (Move Round). `cleaningFrequency` (without roundId) runs the same B3 move as PATCH /service-plans/{id}: " +
      "the plan moves to a matching ACTIVE round, or 409 NO_MATCHING_ROUND (with `suggestions` + `proposedName`) unless `createRoundIfMissing: true`. A property with no service plan ignores the frequency.",
    properties: {
      cleaningFrequency: nullableRef("CleaningFrequency"),
      createRoundIfMissing: { type: "boolean", description: "Defaults to false." },
      addressLine: { type: "string", minLength: 1 },
      postcode: { type: "string", minLength: 1 },
      propertyName: { type: "string", nullable: true },
      propertyType: { type: "string", nullable: true, enum: ["HOUSE", "FLAT_APARTMENT", "COMMERCIAL", "OFFICE", "CONSERVATORY", null] },
      serviceAreaId: { type: "string", nullable: true },
      accessNotes: { type: "string", nullable: true },
      riskNotes: { type: "string", nullable: true },
      roundId: { type: "string", nullable: true },
    },
  },
  CustomerUpdateInput: {
    type: "object",
    description: "M19 Edit Customer Record — partial update across Customer + Property + ServicePlan (atomic). Assigned Technician is deferred to M3.",
    properties: {
      name: { type: "string", minLength: 1 },
      phone: { type: "string", nullable: true },
      landline: { type: "string", nullable: true },
      email: { type: "string", nullable: true },
      addressLine: { type: "string", minLength: 1 },
      postcode: { type: "string", minLength: 1 },
      propertyType: { type: "string", nullable: true, enum: ["HOUSE", "FLAT_APARTMENT", "COMMERCIAL", "OFFICE", "CONSERVATORY", null] },
      accessNotes: { type: "string", nullable: true },
      riskNotes: { type: "string", nullable: true },
      roundId: { type: "string", nullable: true },
      price: { type: "number", minimum: 0, exclusiveMinimum: true, maximum: 9999.99 },
      cleanMethod: { type: "string", nullable: true },
      paymentMethod: nullableRef("PaymentMethod"),
      messagesOptOut: { type: "boolean", description: "Opt the customer out of automated messages (pre-clean reminders, visit-completed). 400 if not a boolean." },
    },
  },
  PauseServiceInput: {
    type: "object",
    required: ["reason", "pauseStartDate"],
    additionalProperties: false,
    properties: {
      reason: { type: "string", minLength: 1, description: "Required by the UI; not persisted (no column)." },
      pauseStartDate: { type: "string", format: "date" },
      pauseEndDate: { type: "string", format: "date", nullable: true, description: "null = indefinite pause. Must be after pauseStartDate when provided." },
    },
    example: { reason: "Customer Holiday/Away", pauseStartDate: "2026-05-22", pauseEndDate: "2026-06-22" },
  },
  NoteCreateInput: {
    type: "object",
    required: ["type", "body"],
    properties: {
      type: ref("NoteType"),
      body: { type: "string", minLength: 1 },
    },
    example: { type: "INTERNAL", body: "Prefers morning slots." },
  },

  // ---- Auth ----
  SignupInput: {
    type: "object",
    required: ["name"],
    description: "Called after Supabase confirms the session and GET /auth/me returns 404.",
    properties: {
      name: { type: "string", minLength: 1, description: "Full name for the admin Profile." },
      companyName: {
        description: "Optional — accepted but not persisted here; collected by Setup Wizard step 1.",
      },
    },
    example: { name: "Maaz Kashif", companyName: "Northumberland Window Cleaning" },
  },

  SignupResponse: {
    type: "object",
    required: ["profile", "tenantId"],
    properties: {
      profile: ref("Profile"),
      tenantId: { type: "string" },
    },
  },

  // ---- Invites ----
  InviteSendInput: {
    type: "object",
    required: ["email"],
    properties: {
      email: { type: "string", format: "email" },
      role: {
        allOf: [ref("UserRole")],
        description: "Defaults to TECHNICIAN if omitted.",
      },
      technicianId: {
        type: "string",
        nullable: true,
        description: "If provided, links the invite to an existing invite-pending Technician row. On accept, that row's profileId is set to the new Profile's id.",
      },
    },
    example: { email: "james@example.com", role: "TECHNICIAN", technicianId: "clx..." },
  },

  PendingInvite: {
    type: "object",
    description: "An invite that hasn't been accepted yet (GET /invites). Token omitted.",
    required: ["id", "email", "role", "expiresAt", "createdAt", "expired"],
    properties: {
      id: { type: "string" },
      email: { type: "string", format: "email" },
      role: ref("UserRole"),
      technicianId: { type: "string", nullable: true },
      expiresAt: dateTime,
      createdAt: dateTime,
      expired: { type: "boolean", description: "True once expiresAt has passed — resend to revive it." },
    },
  },

  InviteTokenInfo: {
    type: "object",
    required: ["email", "role", "tenantId", "expiresAt"],
    description: "Public — returned before auth so the frontend can pre-fill the signup form.",
    properties: {
      email: { type: "string", format: "email" },
      role: ref("UserRole"),
      tenantId: { type: "string" },
      expiresAt: dateTime,
    },
  },

  InviteAcceptInput: {
    type: "object",
    required: ["name"],
    properties: {
      name: { type: "string", minLength: 1, description: "Display name for the new Profile." },
    },
    example: { name: "James Fisher" },
  },

  ComplaintCreateInput: {
    type: "object",
    required: ["customerId", "title"],
    properties: {
      customerId: { type: "string", minLength: 1, description: "ID of an existing customer." },
      title: { type: "string", minLength: 1, example: "Missed conservatory roof" },
      description: { type: "string", nullable: true, example: "Second time this month the conservatory roof was not cleaned." },
      issueType: { type: "string", nullable: true, example: "Missed Clean" },
      severity: { type: "string", nullable: true, enum: ["LOW", "MEDIUM", "HIGH"], default: "LOW" },
      propertyId: { type: "string", nullable: true },
      technicianId: { type: "string", nullable: true, description: "Must have accepted their invite." },
    },
    example: {
      customerId: "cld123abc",
      title: "Missed conservatory roof",
      description: "Second time this month the conservatory roof was not cleaned.",
      issueType: "Missed Clean",
      severity: "MEDIUM",
      propertyId: "prp456def",
      technicianId: null,
    },
  },

  ScheduleRevisitInput: {
    type: "object",
    required: ["revisitDate"],
    properties: {
      revisitDate: { type: "string", format: "date", description: "Revisit date in YYYY-MM-DD format.", example: "2026-09-10" },
    },
  },

  AssignTechnicianInput: {
    type: "object",
    required: ["technicianId"],
    properties: {
      technicianId: { type: "string", minLength: 1, description: "Must have accepted their invite." },
    },
  },

  AddMessageInput: {
    type: "object",
    required: ["body"],
    properties: {
      body: { type: "string", minLength: 1, description: "The reply text to send." },
    },
  },

  VisitCreateInput: {
    type: "object",
    required: ["propertyId", "date", "price"],
    properties: {
      propertyId: { type: "string", minLength: 1, description: "ID of an existing property." },
      date: { type: "string", format: "date", description: "Visit date in YYYY-MM-DD format. Stored as midnight UTC.", example: "2026-09-03" },
      price: { type: "number", minimum: 0.01, maximum: 9999.99, example: 45 },
      serviceId: { type: "string", nullable: true, description: "Must be an active service. null = no service attached." },
      technicianId: { type: "string", nullable: true },
      roundId: { type: "string", nullable: true, description: "Attach to a round so the visit appears in the Round Planner. null = Today only." },
      notes: { type: "string", nullable: true, example: "One-off gutter clean — customer rang in" },
      paymentMethod: {
        type: "string",
        nullable: true,
        enum: ["GOCARDLESS", "STRIPE", "CASH", "BACS", "CHEQUE"],
      },
    },
    example: {
      propertyId: "cle123abc",
      date: "2026-09-03",
      price: 45,
      serviceId: "csv456def",
      technicianId: "ctn789ghi",
      roundId: null,
      notes: "One-off gutter clean — customer rang in",
      paymentMethod: "CASH",
    },
  },

  // ---- Rounds ----
  RoundCreateInput: {
    type: "object",
    required: ["name", "frequency", "serviceAreaId"],
    properties: {
      name: { type: "string", minLength: 1 },
      frequency: ref("CleaningFrequency"),
      serviceAreaId: { type: "string", description: "Must exist (404 if not)." },
      defaultDay: nullableRef("DayOfWeek"),
      description: { type: "string", nullable: true },
    },
    example: { name: "Alnwick Monday", frequency: "FOUR_WEEKLY", serviceAreaId: "csa_example", defaultDay: "MON" },
  },

  RoundUpdateInput: {
    type: "object",
    description: "Partial update. frequency: null clears it. serviceAreaId: null unassigns the area. Omitted fields are left unchanged.",
    properties: {
      name: { type: "string", minLength: 1 },
      frequency: nullableRef("CleaningFrequency"),
      serviceAreaId: { type: "string", nullable: true },
      defaultDay: nullableRef("DayOfWeek"),
      description: { type: "string", nullable: true },
      status: ref("RoundStatus"),
    },
  },

  SetRoundTechniciansInput: {
    type: "object",
    required: ["technicianIds"],
    properties: {
      technicianIds: {
        type: "array",
        items: { type: "string" },
        description: "Replaces the round's technician list wholesale (empty array clears it). Every id must reference an active, invite-accepted technician.",
      },
      split: {
        type: "object",
        required: ["mode"],
        properties: {
          mode: { type: "string", enum: ["SINGLE", "AUTO", "MANUAL"] },
          allocations: {
            type: "array",
            description: "MANUAL only.",
            items: { type: "object", required: ["propertyId", "technicianId"], properties: { propertyId: { type: "string" }, technicianId: { type: "string" } } },
          },
        },
      },
    },
    example: { technicianIds: ["t1", "t2"], split: { mode: "AUTO" } },
  },

  ReassignTechnicianInput: {
    type: "object",
    required: ["toTechnicianId", "scope"],
    properties: {
      date: { type: "string", format: "date", description: "Visit date to reassign; default today." },
      fromTechnicianId: { type: "string", nullable: true, description: "null/omitted = the date's unassigned visits." },
      toTechnicianId: { type: "string", description: "Must be an active, invite-accepted technician." },
      scope: { type: "string", enum: ["REMAINING", "ALL"], description: "REMAINING = SCHEDULED/IN_PROGRESS visits only; ALL = also COMPLETED/SKIPPED. Lowercase accepted." },
      permanent: { type: "boolean", default: false, description: "Also move the properties' allocation (future visits follow)." },
      note: { type: "string", nullable: true },
      notify: { type: "boolean", default: false },
    },
    example: { date: "2026-10-30", fromTechnicianId: "t1", toTechnicianId: "t2", scope: "REMAINING", notify: false },
  },

  PushMissedVisitsInput: {
    type: "object",
    required: ["newDate", "reason"],
    properties: {
      newDate: { type: "string", format: "date", description: "Must be strictly after today." },
      reason: { type: "string", minLength: 1 },
      technicianId: { type: "string", nullable: true, description: "Reassign the pushed visits to this technician. Omit to leave the technician unchanged." },
      notifyCustomers: { type: "boolean", default: false },
      message: { type: "string", nullable: true, description: "Custom SMS text. Falls back to a default rescheduled-clean message mentioning reason." },
    },
    example: { newDate: "2026-09-20", reason: "Heavy rain", notifyCustomers: true },
  },

  // ---- Technicians (new directory router) ----
  TechnicianDirectoryCreateInput: {
    type: "object",
    description: "POST /technicians — distinct from TechnicianCreateInput (used by /settings/technicians): adds email/notes/serviceAreaId and an optional invite send.",
    properties: {
      name: { type: "string", nullable: true },
      phone: { type: "string", nullable: true },
      role: { type: "string", nullable: true },
      email: { type: "string", nullable: true, description: "Required when sendInvite is true." },
      notes: { type: "string", nullable: true },
      serviceAreaIds: { type: "array", items: { type: "string" }, description: "Every id must exist (404 if not)." },
      serviceAreaId: { type: "string", nullable: true, deprecated: true, description: "Singular form from older clients — appended to serviceAreaIds." },
      sendInvite: { type: "boolean", default: false, description: "When true, also creates a TenantInvite and emails it. 409 if a pending invite for this email already exists; 503 if the email fails to send." },
    },
    example: { name: "James Fisher", role: "Senior", phone: "+44 7700 900111", email: "james@example.com", sendInvite: true },
  },

  TechnicianDirectoryUpdateInput: {
    type: "object",
    description: "PATCH /technicians/{id} — partial update, all fields optional. Email is re-validated and lower-cased.",
    properties: {
      name: { type: "string", nullable: true },
      phone: { type: "string", nullable: true },
      role: { type: "string", nullable: true },
      email: { type: "string", nullable: true },
      notes: { type: "string", nullable: true },
      active: { type: "boolean" },
      serviceAreaIds: { type: "array", items: { type: "string" }, description: "Replaces the technician's service areas ([] clears). Every id must exist (404 if not)." },
      serviceAreaId: { type: "string", nullable: true, deprecated: true, description: "Singular form from older clients — appended to serviceAreaIds." },
    },
  },

  // ---- Messages ----
  MessageSendInput: {
    type: "object",
    required: ["body"],
    description: "Either propertyId or customerId is required (a property resolves to its customer).",
    properties: {
      propertyId: { type: "string", nullable: true },
      customerId: { type: "string", nullable: true },
      channel: { type: "string", enum: ["AUTO", "SMS", "EMAIL", "WHATSAPP"], description: "Case-insensitive. Omitted/null/AUTO = SMS when the customer has a mobile, else EMAIL." },
      body: { type: "string", minLength: 1 },
    },
    example: { customerId: "cld123", channel: "sms", body: "Reminder: your clean is scheduled for tomorrow." },
  },

  MessageBulkInput: {
    type: "object",
    required: ["roundId", "channel", "body"],
    properties: {
      roundId: { type: "string" },
      channel: { type: "string", enum: ["sms", "email", "whatsapp"], description: "Case-insensitive." },
      body: { type: "string", minLength: 1 },
      excludePaymentHold: { type: "boolean", default: false, description: "Drop any customer whose round properties all have a payment-hold visit." },
    },
    example: { roundId: "r1", channel: "sms", body: "Your clean has been rescheduled due to weather.", excludePaymentHold: true },
  },

  // ---- Setup steps 9–12 ----
  SetupPropertyInput: {
    type: "object",
    description: "Setup step 9 — one-time property creation during the wizard. Does not reuse POST /properties.",
    required: ["customerName", "fullAddress", "postcode", "serviceAreaId", "price", "roundId"],
    properties: {
      customerName: { type: "string", minLength: 1 },
      propertyName: { type: "string", nullable: true },
      phone: { type: "string", nullable: true },
      landline: { type: "string", nullable: true },
      email: { type: "string", nullable: true },
      fullAddress: { type: "string", minLength: 1 },
      postcode: { type: "string", minLength: 1 },
      serviceAreaId: { type: "string" },
      propertyType: { type: "string", nullable: true },
      price: { type: "number", minimum: 0, description: "Combined/total price across whichever service(s) this row represents." },
      cleaningFrequency: ref("CleaningFrequency"),
      paymentMethod: ref("PaymentMethod"),
      serviceId: { type: "string", nullable: true },
      serviceIds: {
        type: "array",
        items: { type: "string" },
        nullable: true,
        description: "When given (non-empty), one ServicePlan is created per id instead of a single plan for serviceId, splitting price evenly across them (remainder pence on the last plan).",
      },
      accessNotes: { type: "string", nullable: true },
      riskNotes: { type: "string", nullable: true },
      roundId: { type: "string", description: "Required during setup so the property is schedulable. Must reference an ACTIVE round." },
      customerId: { type: "string", nullable: true, description: "GAP-010: attach to this existing customer (404 / row error if unknown). Omitted = match by mobile/email, else create." },
      lastCleanedDate: { type: "string", format: "date", nullable: true, description: "ISO date; seeds nextDueDate = one cycle later on the round day. 400 / row error if invalid." },
    },
    example: {
      customerName: "John Smith",
      fullAddress: "12 Market Street",
      postcode: "NE66 1SS",
      serviceAreaId: "csa_example",
      price: 35,
      roundId: "rnd_example",
    },
  },

  SetupPropertyBulkInput: {
    type: "object",
    required: ["properties"],
    description: "Setup step 9 bulk import. Accepts up to 1000 rows, processed in batches of 100 (each batch its own transaction) — a row or batch that fails is reported in `errors[]` by its original row index and does not abort the others.",
    properties: {
      properties: { type: "array", items: ref("SetupPropertyInput"), maxItems: 1000 },
      idempotencyKey: {
        type: "string",
        nullable: true,
        description: "Pass to make a retried call (e.g. after a client timeout) safe: a repeat call with the same key returns the original result (created count) instead of re-creating the same rows. Sent in the JSON body — not an Idempotency-Key header.",
      },
      allowFrequencyMismatch: { type: "boolean", default: false, description: "Import rows whose cleaningFrequency differs from the round's frequency (row error otherwise)." },
    },
  },

  RoundTechnicianAssignmentInput: {
    type: "object",
    required: ["roundId", "technicianIds"],
    properties: {
      roundId: { type: "string", description: "Must reference an ACTIVE round." },
      technicianIds: {
        type: "array",
        items: { type: "string" },
        description: "Every id must reference an active technician. Replaces this round's assignments; a round not included in the request is left untouched.",
      },
    },
    example: { roundId: "rnd_example", technicianIds: ["t1", "t2"] },
  },

  ActivationInput: {
    type: "object",
    required: ["startDate", "cycleWeeks"],
    description: "Setup step 11 — generates the initial batch of SCHEDULED visits. roundIds is required (and must be non-empty) when generateAll is false.",
    properties: {
      generateAll: { type: "boolean", default: true, description: "true = every ACTIVE round; false = only roundIds." },
      startDate: { type: "string", format: "date", description: "Must be today or in the future." },
      cycleWeeks: { type: "integer", minimum: 1, maximum: 52, description: "How many weeks of visits to generate up front." },
      roundIds: { type: "array", items: { type: "string" }, description: "Required when generateAll is false." },
    },
    example: { generateAll: true, startDate: "2026-10-01", cycleWeeks: 4 },
  },

  // ---- Debt ----
  DebtRemindInput: {
    type: "object",
    description: "All optional. Empty/blank `message` = use the template.",
    properties: {
      channel: { type: "string", enum: ["AUTO", "SMS", "EMAIL", "WHATSAPP"], description: "Case-insensitive; omitted = AUTO." },
      message: { type: "string", description: "Overrides the template body ({{var}} placeholders still render)." },
    },
    example: { channel: "SMS" },
  },

  DebtPaymentLinkInput: {
    type: "object",
    description: "All optional. Empty/blank `message` = use the \"Payment Link\" template.",
    properties: {
      channel: { type: "string", enum: ["AUTO", "SMS", "EMAIL", "WHATSAPP"], description: "Case-insensitive; omitted = AUTO." },
      message: { type: "string" },
    },
    example: { channel: "AUTO" },
  },

  DebtBadDebtInput: {
    type: "object",
    required: ["flag"],
    properties: { flag: { type: "boolean" } },
    example: { flag: true },
  },

  DebtHoldInput: {
    type: "object",
    required: ["flag"],
    properties: {
      flag: { type: "boolean" },
      reason: { type: "string", nullable: true, description: "Only applied when flag is true." },
      date: { type: "string", format: "date", nullable: true, description: "holdSince. Defaults to now when flag is true and omitted." },
      notify: { type: "boolean", description: "Send an SMS to the customer. Only applies when flag is true." },
      message: { type: "string", nullable: true, description: "Custom SMS text when notify is true. Falls back to a default hold message." },
    },
    example: { flag: true, reason: "2 payments overdue", notify: true },
  },

  // ---- Today ----
  CloseDayInput: {
    type: "object",
    required: ["unfinishedAction"],
    properties: {
      unfinishedAction: {
        type: "string",
        enum: ["push_to_tomorrow", "mark_as_skipped"],
        description: "What to do with today's still-SCHEDULED/IN_PROGRESS visits.",
      },
    },
    example: { unfinishedAction: "push_to_tomorrow" },
  },

  // ---- Invoices ----
  InvoiceCreateInput: {
    type: "object",
    required: ["visitId"],
    properties: {
      visitId: { type: "string", description: "The visit must not already have an invoice (409 if it does)." },
      notes: { type: "string", nullable: true },
      dueDate: { type: "string", format: "date", nullable: true },
      sendEmail: { type: "boolean", default: false, description: "Accepted but ignored — no delivery is performed (invoice email delivery is not implemented)." },
    },
    example: { visitId: "vis_example", dueDate: "2026-10-15" },
  },

  // ---- Payments ----
  StripeCheckoutInput: {
    type: "object",
    required: ["invoiceId"],
    description: "Creates a one-time Stripe Checkout session for an invoice. Returns the existing PENDING session's URL instead of creating a duplicate if one already exists.",
    properties: { invoiceId: { type: "string" } },
    example: { invoiceId: "inv_example" },
  },

  StripeSetupInput: {
    type: "object",
    required: ["customerId"],
    description: "Creates a Stripe Checkout Session in 'setup' mode to save a card for future automatic charges.",
    properties: { customerId: { type: "string" } },
    example: { customerId: "cld123" },
  },

  // ---- Service Plans ----
  ServicePlanUpdateInput: {
    type: "object",
    description: "PATCH /service-plans/{id} — partial update, all fields optional. Targets one ServicePlan directly by id (a property with 2+ plans can have each edited independently).",
    properties: {
      price: { type: "number", minimum: 0, exclusiveMinimum: true, maximum: 9999.99 },
      cleanMethod: { type: "string", nullable: true },
      paymentMethod: nullableRef("PaymentMethod"),
      cleaningFrequency: nullableRef("CleaningFrequency"),
      createRoundIfMissing: { type: "boolean", description: "Defaults to false. Create the proposed round instead of answering 409 NO_MATCHING_ROUND." },
    },
    example: { price: 40, cleaningFrequency: "SIX_WEEKLY" },
  },

  // ---- Phase 1: invoices / payments ----
  InvoiceListRow: {
    type: "object",
    required: ["id", "invoiceNumber", "customer", "total", "status", "issuedAt", "dueDate", "paidAt", "paymentMethod", "visitId"],
    properties: {
      id: { type: "string" },
      invoiceNumber: { type: "string" },
      customer: { type: "object", properties: { id: { type: "string" }, name: { type: "string" } } },
      total: { type: "number" },
      status: ref("InvoiceStatus"),
      issuedAt: dateTime,
      dueDate: { ...dateTime, nullable: true },
      paidAt: { ...dateTime, nullable: true },
      paymentMethod: nullableRef("PaymentMethod"),
      visitId: { type: "string", nullable: true },
    },
  },
  InvoiceBulkInput: {
    type: "object",
    required: ["date"],
    properties: {
      date: { type: "string", format: "date" },
      excludeVisitIds: { type: "array", items: { type: "string" } },
    },
    example: { date: "2026-10-30", excludeVisitIds: [] },
  },
  InvoiceBulkPreview: {
    type: "object",
    required: ["items", "skipped", "totals"],
    properties: {
      items: {
        type: "array",
        items: {
          type: "object",
          properties: {
            visitId: { type: "string" },
            customerName: { type: "string" },
            address: { type: "string" },
            amount: { type: "number" },
            vat: { type: "number" },
            total: { type: "number" },
            paymentMethod: nullableRef("PaymentMethod"),
          },
        },
      },
      skipped: {
        type: "array",
        items: {
          type: "object",
          properties: {
            visitId: { type: "string" },
            customerName: { type: "string" },
            reason: { type: "string", enum: ["ALREADY_INVOICED", "NOT_COMPLETED", "ON_HOLD"] },
          },
        },
      },
      totals: { type: "object", properties: { count: { type: "integer" }, amount: { type: "string", example: "126.00" } } },
    },
  },
  InvoiceBulkResult: {
    type: "object",
    required: ["created", "failed", "totals"],
    properties: {
      created: {
        type: "array",
        items: {
          type: "object",
          properties: {
            visitId: { type: "string" },
            invoiceId: { type: "string" },
            invoiceNumber: { type: "string" },
            total: { type: "number" },
            sent: { type: "boolean", description: "Present only with sendNow." },
          },
        },
      },
      failed: {
        type: "array",
        items: {
          type: "object",
          properties: { visitId: { type: "string" }, invoiceId: { type: "string", description: "Set when created but not sent." }, error: { type: "string" } },
        },
      },
      totals: { type: "object", properties: { count: { type: "integer" }, amount: { type: "string" } } },
    },
  },
  InvoiceSendResult: {
    type: "object",
    required: ["id", "invoiceNumber", "status", "sentToCustomer", "sentAt", "messageId", "channel"],
    properties: {
      id: { type: "string" },
      invoiceNumber: { type: "string" },
      status: ref("InvoiceStatus"),
      sentToCustomer: { type: "boolean" },
      sentAt: { ...dateTime, nullable: true },
      messageId: { type: "string", description: "The recorded OUTBOUND Message id." },
      channel: ref("MessageChannel"),
    },
  },
  MarkPaidResult: {
    type: "object",
    required: ["invoice", "payment"],
    properties: {
      invoice: {
        type: "object",
        properties: { id: { type: "string" }, invoiceNumber: { type: "string" }, status: ref("InvoiceStatus"), paidAt: { ...dateTime, nullable: true }, amount: { type: "number" } },
      },
      payment: {
        type: "object",
        properties: {
          id: { type: "string" },
          status: ref("PaymentStatus"),
          method: ref("PaymentMethod"),
          amount: { type: "number" },
          paidAt: { ...dateTime, nullable: true },
          reference: { type: "string", nullable: true },
        },
      },
    },
  },
  PaymentListRow: {
    type: "object",
    required: ["id", "customer", "amount", "method", "status", "paidAt", "createdAt", "visitId", "visitDate", "invoiceId", "invoiceNumber"],
    properties: {
      id: { type: "string" },
      customer: { type: "object", properties: { id: { type: "string" }, name: { type: "string" } } },
      amount: { type: "number" },
      method: ref("PaymentMethod"),
      status: ref("PaymentStatus"),
      paidAt: { ...dateTime, nullable: true },
      createdAt: dateTime,
      visitId: { type: "string", nullable: true },
      visitDate: { ...dateTime, nullable: true },
      invoiceId: { type: "string", nullable: true },
      invoiceNumber: { type: "string", nullable: true },
    },
  },

  // ---- Phase 1: technician KPIs / incidents / availability ----
  TechnicianPerformance: {
    type: "object",
    required: ["technicianId", "period", "from", "to", "visitsCompleted", "revenue", "timeOnJobMinutes", "revenuePerHour", "strikes", "damages", "upsells", "upsellValue", "complaints"],
    properties: {
      technicianId: { type: "string" },
      period: { type: "string" },
      from: { ...dateTime, description: "Inclusive." },
      to: { ...dateTime, description: "Exclusive." },
      visitsCompleted: { type: "integer" },
      revenue: { type: "number" },
      timeOnJobMinutes: { type: "number", nullable: true },
      revenuePerHour: { type: "number", nullable: true },
      strikes: { type: "integer" },
      damages: { type: "integer" },
      upsells: { type: "integer" },
      upsellValue: { type: "number" },
      complaints: { type: "integer", description: "Complaints logged in the period." },
    },
  },
  TechnicianIncident: {
    type: "object",
    required: ["id", "technicianId", "visitId", "type", "amount", "note", "createdById", "createdAt"],
    properties: {
      id: { type: "string" },
      technicianId: { type: "string" },
      visitId: { type: "string", nullable: true },
      type: ref("IncidentType"),
      amount: { type: "number", nullable: true },
      note: { type: "string", nullable: true },
      createdById: { type: "string", nullable: true, description: "Profile id." },
      createdAt: dateTime,
    },
  },
  TechnicianAvailability: {
    type: "object",
    required: ["id", "technicianId", "from", "to"],
    properties: {
      id: { type: "string" },
      technicianId: { type: "string" },
      from: dateTime,
      to: { ...dateTime, description: "Inclusive; 2099-12-31 = open-ended (from POST /technicians/{id}/replace without `to`)." },
      reason: { type: "string", nullable: true },
      createdAt: dateTime,
    },
  },

  // ---- Phase 1: plan lifecycle / photos ----
  PauseResult: {
    allOf: [
      ref("ServicePlan"),
      {
        type: "object",
        required: ["cancelledVisits", "pauseScheduled"],
        properties: {
          cancelledVisits: { type: "integer", description: "SCHEDULED visits in the pause window that were CANCELLED (cancelReason PAUSED)." },
          pauseScheduled: { type: "boolean", description: "true = start date is in the future; the plan stays ACTIVE until then." },
        },
      },
    ],
  },
  MovedToRound: {
    type: "object",
    nullable: true,
    required: ["id", "name", "created"],
    properties: { id: { type: "string" }, name: { type: "string" }, created: { type: "boolean", description: "true when the round was created by createRoundIfMissing." } },
  },
  PlanUpdateResult: {
    type: "object",
    required: ["servicePlan", "movedToRound"],
    properties: { servicePlan: ref("ServicePlan"), movedToRound: ref("MovedToRound") },
  },
  PropertyUpdateResult: {
    allOf: [ref("Property"), { type: "object", required: ["movedToRound"], properties: { movedToRound: ref("MovedToRound") } }],
  },
  NoMatchingRoundError: {
    type: "object",
    required: ["error", "code", "suggestions", "proposedName"],
    properties: {
      error: { type: "string" },
      code: { type: "string", enum: ["NO_MATCHING_ROUND"] },
      suggestions: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            name: { type: "string" },
            frequency: nullableRef("CleaningFrequency"),
            defaultDay: nullableRef("DayOfWeek"),
          },
        },
      },
      proposedName: { type: "string", example: "Alnwick Mon 6wk" },
    },
  },
  PhotoRow: {
    type: "object",
    required: ["id", "type", "url", "thumbnailUrl", "takenAt", "visitId", "visitDate", "technician"],
    properties: {
      id: { type: "string" },
      type: ref("PhotoType"),
      url: { type: "string", nullable: true, description: "1-hour signed read URL (null if signing failed)." },
      thumbnailUrl: { type: "string", nullable: true, description: "Same signed URL — no server-side thumbnails yet." },
      takenAt: dateTime,
      visitId: { type: "string", nullable: true },
      visitDate: { ...dateTime, nullable: true },
      technician: { type: "object", nullable: true, properties: { id: { type: "string" }, name: { type: "string", nullable: true } } },
    },
  },
  PhotoPage: {
    type: "object",
    required: ["rows", "pagination"],
    properties: { rows: { type: "array", items: ref("PhotoRow") }, pagination: ref("Pagination") },
  },

  // ---- Complaints (step-9/resolve update) ----
  ResolveComplaintInput: {
    type: "object",
    description: "Optional resolution notes and outcome, persisted alongside resolvedAt/resolvedBy.",
    properties: {
      notes: { type: "string", nullable: true },
      upheld: { type: "boolean", description: "Was the complaint upheld? 400 if not a boolean." },
    },
    example: { notes: "Returned next day; customer confirmed satisfied.", upheld: true },
  },

  // ---- Message templates (partial update) ----
  MessageTemplateUpdateInput: {
    type: "object",
    description: "Partial update — omitted fields are untouched; `subject: null` clears it.",
    properties: {
      name: { type: "string", minLength: 1 },
      channel: { type: "string", enum: ["SMS", "WHATSAPP", "EMAIL"] },
      body: { type: "string", minLength: 1 },
      subject: { type: "string", nullable: true },
    },
  },

  // ---- Customers: add property / mandate ----
  CustomerPropertyAddInput: {
    type: "object",
    description: "Adds a Property + ServicePlan to an existing customer (atomic). Same fields as PropertyCreateInput minus the customer fields.",
    required: ["addressLine", "postcode", "price", "serviceAreaId"],
    properties: {
      addressLine: { type: "string", minLength: 1 },
      postcode: { type: "string", minLength: 1 },
      propertyName: { type: "string", nullable: true },
      propertyType: { type: "string", nullable: true, enum: ["HOUSE", "FLAT_APARTMENT", "COMMERCIAL", "OFFICE", "CONSERVATORY", null] },
      serviceAreaId: { type: "string", minLength: 1, description: "Must exist (404 if not)." },
      serviceId: { type: "string", nullable: true },
      price: { type: "number", minimum: 0, exclusiveMinimum: true, maximum: 9999.99 },
      cleanMethod: { type: "string", nullable: true },
      paymentMethod: nullableRef("PaymentMethod"),
      nextDueDate: { type: "string", format: "date", nullable: true },
      accessNotes: { type: "string", nullable: true },
      riskNotes: { type: "string", nullable: true },
      roundId: { type: "string", nullable: true, description: "null = unassigned; an id must exist (404 if not). The plan inherits the round's frequency." },
    },
    example: { addressLine: "3 Bondgate Within", postcode: "NE66 1SX", price: 30, serviceAreaId: "csa_example", roundId: null },
  },

  MandateCompleteInput: {
    type: "object",
    required: ["redirectFlowId"],
    properties: { redirectFlowId: { type: "string", description: "The GoCardless redirect flow id returned to the success URL." } },
  },

  // ---- Payments / visits ----
  PaymentStatusInput: {
    type: "object",
    required: ["status"],
    properties: { status: { type: "string", enum: ["PAID", "FAILED"] } },
    example: { status: "PAID" },
  },

  VisitCompleteInput: {
    type: "object",
    properties: {
      payment: ref("CompletionPaymentInput"),
      cashConfirmed: { type: "boolean", deprecated: true, description: "Deprecated alias for payment { method: \"CASH\" }." },
    },
  },

  // ---- Integrations ----
  GoCardlessConnectInput: {
    type: "object",
    required: ["accessToken", "environment"],
    properties: {
      accessToken: { type: "string", description: "GoCardless access token — verified by listing creditors before it is stored (encrypted)." },
      environment: { type: "string", enum: ["sandbox", "live"] },
    },
  },

  GoCardlessWebhookSecretInput: {
    type: "object",
    required: ["secret"],
    properties: { secret: { type: "string", description: "The signing secret GoCardless shows for the webhook endpoint the admin created." } },
  },

  GhlPrivateConnectInput: {
    type: "object",
    required: ["apiKey", "locationId"],
    properties: {
      apiKey: { type: "string", description: "Sub-account Location API key (Settings → Integrations → API Keys). Never expires." },
      locationId: { type: "string" },
    },
  },

  // ---- Mobile (technician app) ----
  MobileMeUpdateInput: {
    type: "object",
    description: "Partial update. `name`/`dateOfBirth` go to the public Profile; `avatarUrl` to the caller's Technician row.",
    properties: {
      name: { type: "string", minLength: 1, maxLength: 100 },
      dateOfBirth: { type: "string", format: "date", nullable: true, description: "YYYY-MM-DD, a real date between 1900-01-01 and today. null clears." },
      avatarUrl: { type: "string", nullable: true },
    },
  },

  MobileUploadUrlInput: {
    type: "object",
    properties: {
      mimeType: { type: "string", enum: ["image/jpeg", "image/png", "image/webp", "image/heic"], default: "image/jpeg" },
    },
  },

  MobileChatAttachmentUploadInput: {
    type: "object",
    required: ["roundId"],
    properties: {
      roundId: { type: "string" },
      mimeType: { type: "string", enum: ["image/jpeg", "image/png", "image/webp", "image/heic"], default: "image/jpeg" },
    },
  },

  MobileDeviceInput: {
    type: "object",
    required: ["pushToken", "platform"],
    properties: {
      pushToken: { type: "string" },
      platform: { type: "string", enum: ["ios", "android"] },
    },
  },

  MobileSupportReportInput: {
    type: "object",
    required: ["description"],
    properties: {
      description: { type: "string", minLength: 1 },
      appVersion: { type: "string", nullable: true },
      device: { type: "string", nullable: true },
    },
  },

  MobileSkipInput: {
    type: "object",
    required: ["reason"],
    properties: {
      reason: { type: "string", minLength: 1 },
      description: { type: "string", nullable: true, description: "Appended to the stored skipReason as `<reason>: <description>`." },
    },
  },

  MobilePriceInput: {
    type: "object",
    required: ["price"],
    properties: {
      price: {
        oneOf: [{ type: "number", minimum: 0 }, { type: "string" }],
        description: "New price (number or numeric string), ≥ 0. Setting it back to the original price clears the adjustment.",
      },
      reason: { type: "string", nullable: true, example: "Front only" },
    },
  },

  MobileAccessIssueInput: {
    type: "object",
    required: ["type", "description"],
    properties: {
      type: ref("IssueType"),
      description: { type: "string", minLength: 1 },
      photoPaths: {
        type: "array",
        maxItems: 10,
        items: { type: "string" },
        description: "Optional storage paths from POST /mobile/visits/{id}/photos/upload-url with `type: ACCESS_ISSUE` (must start with `<tenantId>/visits/<visitId>/`). Stored as ACCESS_ISSUE photos linked to the issue.",
      },
    },
    example: { type: "GATE_LOCKED", description: "Side gate padlocked", photoPaths: ["tenant_1/visits/vis_1/access_issue-1696248000000.jpg"] },
  },

  MobileNoteInput: {
    type: "object",
    required: ["text"],
    properties: { text: { type: "string", minLength: 1 } },
  },

  MobilePhotoUploadUrlInput: {
    type: "object",
    required: ["type"],
    properties: {
      type: { type: "string", enum: ["BEFORE", "AFTER", "ACCESS_ISSUE"], description: "ACCESS_ISSUE: send the returned `path` in POST /mobile/visits/{id}/access-issues `photoPaths` (not POST /photos)." },
      mimeType: { type: "string", enum: ["image/jpeg", "image/png", "image/webp", "image/heic"], default: "image/jpeg" },
      contentLength: { type: "integer", maximum: 10485760, description: "Optional byte size; 413 if over 10 MB." },
    },
  },

  MobilePhotoInput: {
    type: "object",
    required: ["type"],
    description: "Send `path` (the storage path returned by the upload-url step — preferred) or the legacy `url`; one is required. ACCESS_ISSUE photos are recorded via POST /mobile/visits/{id}/access-issues instead.",
    properties: {
      type: { type: "string", enum: ["BEFORE", "AFTER"] },
      url: { type: "string" },
      path: { type: "string" },
    },
  },

  MobileDebtPaymentInput: {
    type: "object",
    properties: {
      method: { type: "string", enum: ["CASH", "CHEQUE"] },
      chequeNumber: { type: "string", maxLength: 50, description: "Required for CHEQUE." },
      cashConfirmed: { type: "boolean", deprecated: true, description: "Alias for method CASH when method is omitted." },
    },
    example: { method: "CHEQUE", chequeNumber: "000123" },
  },

  MobileCashConfirmInput: {
    type: "object",
    properties: { cashConfirmed: { type: "boolean", description: "Must be true (400 otherwise)." } },
    example: { cashConfirmed: true },
  },

  MobileChatMessageInput: {
    type: "object",
    required: ["roundId"],
    description: "`type` TEXT (default) needs `text`; WORK_PHOTOS needs `visitId`; PHOTOS needs a non-empty `photoUrls` (optional `text` caption).",
    properties: {
      roundId: { type: "string" },
      type: { type: "string", enum: ["TEXT", "WORK_PHOTOS", "PHOTOS"], default: "TEXT" },
      text: { type: "string" },
      visitId: { type: "string" },
      photoUrls: { type: "array", items: { type: "string" } },
    },
    example: { roundId: "rnd_example", text: "Running 10 mins late" },
  },
};

// ---------------------------------------------------------------------------
// 5. Reusable error responses.
// ---------------------------------------------------------------------------

const errorResponse = (
  description: string,
  example: string
): OpenAPIV3.ResponseObject =>
  jsonResponse(description, {
    allOf: [ref("Error")],
    example: { error: example },
  });

const reusableResponses: Record<string, OpenAPIV3.ResponseObject> = {
  BadRequest: errorResponse(
    "Validation error, or POST /setup/complete with required steps missing.",
    'Setup cannot be completed — required steps incomplete: 2, 3, 4, 6, 7, 8'
  ),
  Unauthorized: errorResponse("Missing, invalid, or expired Bearer token.", "Unauthorized"),
  Forbidden: errorResponse(
    "Caller's role is not allowed (admin routers need ADMIN/MANAGER), no Profile exists for the user (`code: NO_PROFILE`), or a setup-state lock applies: a wizard mutation after setup is complete, or a Settings mutation before it is.",
    "Setup is already complete; wizard endpoints are locked."
  ),
  NotFound: errorResponse("Resource not found.", "Service not found"),
  Conflict: errorResponse(
    "POST /setup/complete when setup is already complete.",
    "Setup is already complete."
  ),
  Gone: jsonResponse("Invite has expired or has already been accepted. `code` is INVITE_EXPIRED or INVITE_ACCEPTED.", {
    allOf: [ref("Error")],
    example: { error: "Invite has expired", code: "INVITE_EXPIRED" },
  }),
  ServerError: errorResponse("Unexpected server error.", "Internal Server Error"),
};

// ---------------------------------------------------------------------------
// 6. Paths.
// ---------------------------------------------------------------------------

const paths: OpenAPIV3.PathsObject = {
  // ---- Health ----
  "/health": {
    get: {
      tags: ["Health"],
      summary: "Liveness probe",
      description: "Unauthenticated. GAP-005: the server listens while tenant migrations run, so this answers 503 `{ status: \"migrating\" }` until they finish, then 200 with status + timestamp.",
      security: [], // public — overrides the global security requirement
      responses: {
        "200": jsonResponse("OK", ref("HealthStatus")),
        "503": jsonResponse("Tenant migrations still running.", ref("HealthMigrating")),
      },
    },
  },
  "/health/ready": {
    get: {
      tags: ["Health"],
      summary: "Readiness probe",
      description: "Unauthenticated. 503 `{ status: \"migrating\" }` until tenant migrations finish, then 200 `{ status: \"ready\" }`. A migration failure exits the process.",
      security: [],
      responses: {
        "200": jsonResponse("Ready.", { type: "object", required: ["status"], properties: { status: { type: "string", enum: ["ready"] } } }),
        "503": jsonResponse("Tenant migrations still running.", ref("HealthMigrating")),
      },
    },
  },

  // ---- Auth — login (token minted by Supabase GoTrue, external) ----
  // The `servers` override below points to the Supabase URL for Swagger UI's
  // "Try it out" login. Schemathesis ignores per-operation servers and routes
  // to our base URL, so our 405 catch-all fires — 405 is documented here so
  // schemathesis doesn't flag it as an undocumented status code.
  "/auth/v1/token": {
    post: {
      tags: ["Auth"],
      summary: "login",
      description:
        "**External Supabase Auth (GoTrue) endpoint — NOT part of the RoundFlow backend.** " +
        "Returns an `access_token` (ES256 JWT). Copy it into **Authorize** (top-right) to call the " +
        "protected endpoints below. The `apikey` header is the Supabase anon (publishable) key, prefilled here.",
      servers: [{ url: SUPABASE_URL, description: "Supabase Auth (GoTrue)" }],
      security: [],
      parameters: [
        {
          name: "grant_type",
          in: "query",
          required: true,
          schema: { type: "string", enum: ["password"], default: "password" },
        },
        {
          name: "apikey",
          in: "header",
          required: false,
          description: "Supabase anon (publishable) key.",
          schema: { type: "string", default: SUPABASE_ANON_KEY },
        },
      ],
      requestBody: jsonBody(ref("SupabaseLoginInput")),
      responses: {
        "200": jsonResponse("Session — contains `access_token`.", ref("SupabaseSession")),
        "400": jsonResponse("Auth error (Supabase error shape varies).", {
          type: "object",
          additionalProperties: true,
          example: { code: 400, msg: "Invalid login credentials" },
        }),
        "401": jsonResponse("Missing or invalid `apikey` header.", { type: "object", additionalProperties: true, example: { message: "No API key found in request" } }),
        "405": { description: "Method Not Allowed (our backend intercepts this path; use Swagger UI 'Try it out' to log in)." },
      },
    },
  },

  // ---- Auth ----
  "/auth/me": {
    get: {
      tags: ["Auth"],
      summary: "Current user's profile",
      description:
        "Returns the Profile for the authenticated caller (looked up by supabaseUserId from the JWT `sub`). 404 if no Profile exists yet — the frontend uses this to detect new users and trigger POST /auth/signup.",
      responses: {
        "200": jsonResponse("The caller's Profile.", ref("Profile")),
        "404": errorResponse("No Profile for this user — call POST /auth/signup.", "Profile not found"),
        "401": ERR[401],
      },
    },
  },

  // Per-user UI preferences — free-form JSON the frontend owns (any role).
  "/auth/me/preferences": {
    get: {
      tags: ["Auth"],
      summary: "Get the caller's UI preferences",
      description: "Returns the stored preferences blob (`{}` if none). Any authenticated user with a Profile.",
      responses: {
        "200": jsonResponse("Stored preferences.", ref("PreferencesResult")),
        "401": ERR[401],
        "404": errorResponse("No Profile for this user.", "Profile not found"),
      },
    },
    patch: {
      tags: ["Auth"],
      summary: "Shallow-merge keys into the caller's UI preferences",
      description:
        "Top-level keys in the body overwrite the stored ones; other stored keys are kept (set one key at a time). 400 if the merged blob exceeds 100KB.",
      requestBody: jsonBody({ type: "object", additionalProperties: true, example: { rememberMe: true } }),
      responses: {
        "200": jsonResponse("The merged preferences.", ref("PreferencesResult")),
        "400": errorResponse("Body is not an object, or the merged payload is over 100KB.", "preferences payload too large (max 100KB)"),
        "401": ERR[401],
        "404": errorResponse("No Profile for this user.", "Profile not found"),
      },
    },
  },

  "/auth/signup": {
    post: {
      tags: ["Auth"],
      summary: "Register a new admin (first-time signup)",
      description:
        "Called by the frontend after Supabase confirms a new session and `GET /auth/me` returns 404. " +
        "Creates a Profile (role: ADMIN) and a Tenant row in one transaction, then provisions the tenant's own Postgres schema (`t_<20 hex chars>`) " +
        "and best-effort seeds default Services/MessageTemplates into it. " +
        "**Idempotent** — if a Profile already exists for this `supabaseUserId` it is returned with 200 instead of 201 (schema provisioning is re-attempted, as a no-op if already done). " +
        "`companyName` is accepted but not persisted here; it is collected by Setup Wizard step 1.",
      requestBody: jsonBody(ref("SignupInput")),
      responses: {
        "201": jsonResponse("Profile + tenantId created.", ref("SignupResponse")),
        "200": jsonResponse("Profile already existed (idempotent).", ref("SignupResponse")),
        "400": ERR[400],
        "401": ERR[401],
      },
    },
  },

  // ---- Invites ----
  "/invites": {
    get: {
      tags: ["Invites"],
      summary: "List invites not yet accepted",
      description:
        "Newest first. Includes expired invites with `expired: true` so they can be resent. " +
        "Requires ADMIN or MANAGER role.",
      responses: {
        "200": jsonResponse("Unaccepted invites for the caller's tenant.", {
          type: "array",
          items: ref("PendingInvite"),
        }),
        "401": ERR[401],
        "403": ERR[403],
      },
    },
    post: {
      tags: ["Invites"],
      summary: "Send an invite email",
      description:
        "Creates a `TenantInvite` (7-day TTL) and sends an email to the invitee via Supabase Auth. " +
        "Only one pending invite per email+tenant is allowed — 409 if an unexpired, unaccepted invite already exists " +
        "(use POST /invites/{id}/resend instead). Expired unaccepted invites for the email are replaced. " +
        "If the email already has a Supabase account, a magic link to the same accept-invite URL is sent instead. " +
        "Requires ADMIN or MANAGER role. " +
        "If `technicianId` is supplied, that Technician row's `profileId` is set when the invite is accepted.",
      requestBody: jsonBody(ref("InviteSendInput")),
      responses: {
        "201": jsonResponse("The created TenantInvite.", ref("TenantInvite")),
        "400": ERR[400],
        "401": ERR[401],
        "403": ERR[403],
        "404": errorResponse("technicianId does not exist.", "Technician not found"),
        "409": errorResponse(
          "A pending invite for this email already exists, or the technician has already accepted an invite.",
          "A pending invite for this email already exists"
        ),
        "503": errorResponse("Invite email failed to send; the invite was rolled back.", "Invite created but email delivery failed. Please try again."),
      },
    },
  },

  "/invites/{id}/resend": {
    parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
    post: {
      tags: ["Invites"],
      summary: "Resend an invite email",
      description:
        "Re-sends the email for an unaccepted invite (expired or not) and resets `expiresAt` to 7 days from now. " +
        "The token is unchanged, so links in earlier emails keep working. Requires ADMIN or MANAGER role.",
      responses: {
        "200": jsonResponse("The updated TenantInvite.", ref("TenantInvite")),
        "401": ERR[401],
        "403": ERR[403],
        "404": errorResponse("No invite with this id in the caller's tenant.", "Invite not found"),
        "409": errorResponse("Invite already accepted (`code: INVITE_ACCEPTED`).", "Invite has already been accepted"),
        "503": errorResponse("Email failed to send; the invite is unchanged.", "Invite email failed to send. Please try again."),
      },
    },
  },

  "/invites/{token}": {
    parameters: [{ name: "token", in: "path", required: true, schema: { type: "string" } }],
    get: {
      tags: ["Invites"],
      summary: "Validate an invite token (public)",
      description:
        "Public endpoint — no auth required. " +
        "Used by the frontend before the invitee authenticates to check the token is valid and pre-fill the signup form. " +
        "Returns 410 if the token is expired or has already been accepted.",
      security: [],
      responses: {
        "200": jsonResponse("Token is valid.", ref("InviteTokenInfo")),
        "404": ERR[404],
        "410": ERR[410],
      },
    },
    delete: {
      tags: ["Invites"],
      summary: "Cancel an invite",
      description:
        "**For this operation the path segment is the invite `id`** (from GET /invites), not the token. " +
        "Deletes an unaccepted invite; its email link then returns 404. Requires ADMIN or MANAGER role.",
      responses: {
        "204": { description: "Deleted." },
        "401": ERR[401],
        "403": ERR[403],
        "404": errorResponse("No invite with this id in the caller's tenant.", "Invite not found"),
        "409": errorResponse("Invite already accepted (`code: INVITE_ACCEPTED`).", "Invite has already been accepted"),
      },
    },
  },

  "/invites/{token}/accept": {
    parameters: [{ name: "token", in: "path", required: true, schema: { type: "string" } }],
    post: {
      tags: ["Invites"],
      summary: "Accept an invite (invitee calls after Supabase auth)",
      description:
        "Called by the frontend after the invitee authenticates with Supabase. " +
        "The caller's JWT email must match the invite email (403 if not). " +
        "Creates a `Profile` with the invite's `tenantId` and `role`, stamps `acceptedAt`, " +
        "and — if the invite had a `technicianId` — links that Technician row (`profileId = profile.id`). " +
        "**Idempotent** — returns the existing Profile with 200 if it was already created.",
      requestBody: jsonBody(ref("InviteAcceptInput")),
      responses: {
        "201": jsonResponse("Profile created and invite accepted.", {
          type: "object",
          required: ["profile"],
          properties: { profile: ref("Profile") },
        }),
        "200": jsonResponse("Profile already existed (idempotent).", {
          type: "object",
          required: ["profile"],
          properties: { profile: ref("Profile") },
        }),
        "400": ERR[400],
        "401": ERR[401],
        "403": errorResponse(
          "The authenticated user's email does not match the invite email.",
          "This invite was sent to a different email address"
        ),
        "404": ERR[404],
        "410": ERR[410],
      },
    },
  },

  // ---- Setup: status ----
  "/setup/status": {
    get: {
      tags: ["Setup"],
      summary: "Setup progress",
      description:
        "Per-step completion plus `setupCompleted`, `allRequiredComplete` and `wizardSteps` (GAP-002 — the web wizard's 10 steps in display order with their backend step numbers). " +
        "A step is complete once it has been saved at least once (stored in BusinessSettings.completedSteps; existing mid-setup tenants are backfilled from the old row-count rules). " +
        "Required steps: 1-9 and 11. Only step 10 (Assign Technicians to Rounds) is deferred — it reports `complete` but doesn't block `POST /setup/complete`.",
      responses: {
        "200": jsonResponse("Current setup status.", ref("SetupStatus")),
        "401": ERR[401],
      },
    },
  },

  // ---- Setup: Step 1 — Business Profile ----
  "/setup/step/1": {
    get: {
      tags: ["Setup"],
      summary: "Step 1 — get Business Profile",
      description:
        "Returns the BusinessSettings singleton (or null if not yet created). Open after setup completes — the Settings screens reuse it.",
      responses: {
        "200": jsonResponse("BusinessSettings (or null).", nullableRef("BusinessSettings")),
        "401": ERR[401],
      },
    },
    post: {
      tags: ["Setup"],
      summary: "Step 1 — Business Profile",
      description: "Upserts the BusinessSettings singleton (incl. structured address `addressLine1/addressLine2/town/postcode` and `vatRate` 0–100) and marks step 1 complete. `businessName` is required. Response omits encrypted provider secrets.",
      requestBody: jsonBody(ref("BusinessProfileInput")),
      responses: {
        "200": jsonResponse("The updated BusinessSettings.", ref("BusinessSettings")),
        "400": ERR[400],
        "401": ERR[401],
        "403": ERR[403],
      },
    },
  },

  // ---- Setup: Step 2 — Payment Setup ----
  "/setup/step/2": {
    get: {
      tags: ["Setup"],
      summary: "Step 2 — get Payment Setup",
      description:
        "Returns the BusinessSettings singleton (read `paymentRule`, `debtHoldEnabled`, `vatInInvoices`, `defaultPaymentMethod`, `invoiceDueDays`, `noDirectDebitAction`, and the read-only `gocardlessConnected` / `stripeConnected` / `ghlConnected`). Open after setup completes.",
      responses: {
        "200": jsonResponse("BusinessSettings (or null).", nullableRef("BusinessSettings")),
        "401": ERR[401],
      },
    },
    post: {
      tags: ["Setup"],
      summary: "Step 2 — Payment Setup",
      description:
        "Upserts payment configuration on the tenant's BusinessSettings row and marks step 2 complete. All fields optional. " +
        "Sending `gocardlessConnected` or `stripeConnected` is a 400 `FIELD_REMOVED` — connect providers through POST /settings/payment/gocardless/connect, GET /settings/stripe/authorize or GET /settings/ghl/authorize (allowed before setup is complete).",
      requestBody: jsonBody(ref("PaymentSetupInput")),
      responses: {
        "200": jsonResponse("The updated BusinessSettings.", ref("BusinessSettings")),
        "400": errorResponse("Validation error, or a removed field was sent (code FIELD_REMOVED).", "gocardlessConnected can no longer be set here. Connect or disconnect the provider from Settings › Payments."),
        "401": ERR[401],
        "403": ERR[403],
      },
    },
  },

  // ---- Setup: Step 3 — Service Catalogue ----
  "/setup/step/3": {
    get: {
      tags: ["Setup"],
      summary: "Step 3 — list services",
      responses: {
        "200": jsonResponse("Current service catalogue.", {
          type: "array",
          items: ref("Service"),
        }),
        "401": ERR[401],
      },
    },
    post: {
      tags: ["Setup"],
      summary: "Step 3 — create/replace the service catalogue",
      description:
        "REPLACES the whole catalogue with the posted list (existing services are cleared first). Send everything you want to keep.",
      requestBody: jsonBody(arrayOrWrapped("ServiceInput", "services")),
      responses: {
        "200": jsonResponse("The new catalogue.", { type: "array", items: ref("Service") }),
        "400": ERR[400],
        "401": ERR[401],
        "403": ERR[403],
      },
    },
  },

  // ---- Setup: Step 4 — Round Settings ----
  "/setup/step/4": {
    get: {
      tags: ["Setup"],
      summary: "Step 4 — get Round Settings",
      description:
        "Returns the BusinessSettings singleton (same row as step 1; read `defaultCycleLength` / `defaultWorkingDays` / `reminderMode` / `reminderTime` / `defaultCleanMethod` / `autoCreateNextVisit`). Open after setup completes.",
      responses: {
        "200": jsonResponse("BusinessSettings (or null).", nullableRef("BusinessSettings")),
        "401": ERR[401],
      },
    },
    post: {
      tags: ["Setup"],
      summary: "Step 4 — Round Settings",
      description: "Upserts BusinessSettings and marks step 4 complete. `defaultCycleLength` is required (days). `reminderMode` + `reminderTime` (HH:mm, tenant-local) drive the pre-clean reminder job.",
      requestBody: jsonBody(ref("RoundSettingsInput")),
      responses: {
        "200": jsonResponse("The updated BusinessSettings.", ref("BusinessSettings")),
        "400": ERR[400],
        "401": ERR[401],
        "403": ERR[403],
      },
    },
  },

  // ---- Setup: Step 5 — Message Templates (SMS / WhatsApp / Email) ----
  "/setup/step/5": {
    get: {
      tags: ["Setup"],
      summary: "Step 5 — get saved message templates",
      responses: {
        "200": jsonResponse("Saved templates.", { type: "array", items: ref("MessageTemplateView") }),
        "401": ERR[401],
        "403": ERR[403],
        "500": ERR[500],
      },
    },
    post: {
      tags: ["Setup"],
      summary: "Step 5 — replace all message templates",
      description: "Bulk-replaces all message templates with the posted array and marks step 5 complete.",
      requestBody: jsonBody(arrayOrWrapped("MessageTemplateInput", "templates")),
      responses: {
        "200": jsonResponse("Updated templates.", { type: "array", items: ref("MessageTemplateView") }),
        "400": ERR[400],
        "401": ERR[401],
        "403": ERR[403],
      },
    },
  },

  // ---- Setup: Step 6 — Technicians ----
  "/setup/step/6": {
    get: {
      tags: ["Setup"],
      summary: "Step 6 — list technicians",
      responses: {
        "200": jsonResponse("Technicians.", { type: "array", items: ref("Technician") }),
        "401": ERR[401],
      },
    },
    post: {
      tags: ["Setup"],
      summary: "Step 6 — save invite-pending technician(s)",
      description:
        "REPLACES all invite-pending technicians (profileId = null) with the posted list — send the full list you want to keep (re-posting is safe; it does not append duplicates). Technicians who have accepted an invite (real profileId) are never affected. Each created technician is invite-pending (profileId = null).",
      requestBody: jsonBody(arrayOrWrapped("TechnicianInput", "technicians")),
      responses: {
        "200": jsonResponse("All technicians.", { type: "array", items: ref("Technician") }),
        "400": ERR[400],
        "401": ERR[401],
        "403": ERR[403],
      },
    },
  },

  // ---- Setup: Step 7 — Service Areas ----
  "/setup/step/7": {
    get: {
      tags: ["Setup"],
      summary: "Step 7 — list service areas",
      responses: {
        "200": jsonResponse("Service areas.", { type: "array", items: ref("ServiceArea") }),
        "401": ERR[401],
      },
    },
    post: {
      tags: ["Setup"],
      summary: "Step 7 — save service area(s)",
      description:
        "REPLACES all service areas with the posted list — send the full list you want to keep (re-posting is safe; it does not append duplicates).",
      requestBody: jsonBody(arrayOrWrapped("ServiceAreaInput", "serviceAreas")),
      responses: {
        "200": jsonResponse("All service areas.", {
          type: "array",
          items: ref("ServiceArea"),
        }),
        "400": ERR[400],
        "401": ERR[401],
        "403": ERR[403],
      },
    },
  },

  // ---- Setup: Step 8 — First Round ----
  "/setup/step/8": {
    get: {
      tags: ["Setup"],
      summary: "Step 8 — list ACTIVE rounds",
      responses: {
        "200": jsonResponse("ACTIVE rounds.", { type: "array", items: ref("Round") }),
        "401": ERR[401],
      },
    },
    post: {
      tags: ["Setup"],
      summary: "Step 8 — save the first round (ACTIVE)",
      description:
        "Creates OR updates the single setup round (upsert) — re-posting updates the existing ACTIVE round rather than creating a second. The round is ACTIVE. `name` required; `defaultDay`/`frequency` validated against their enums; `serviceAreaId` (if given) must exist.",
      requestBody: jsonBody(ref("FirstRoundInput")),
      responses: {
        "200": jsonResponse("The created round.", ref("Round")),
        "400": ERR[400],
        "401": ERR[401],
        "403": ERR[403],
      },
    },
  },

  // ---- Setup: complete ----
  "/setup/complete": {
    post: {
      tags: ["Setup"],
      summary: "Complete setup",
      description:
        "Marks setup complete (step 12). Requires every non-deferred step before 12 — i.e. 1–9 and 11 (step 10 is deferred). After completion, mutating wizard endpoints return 403 and Settings mutations unlock.",
      responses: {
        "200": jsonResponse("Final status (setupCompleted = true).", ref("SetupStatus")),
        "400": ERR[400], // required steps missing
        "401": ERR[401],
        "409": ERR[409], // already complete
      },
    },
  },

  // =====================================================================
  // Settings — post-completion editing. GETs are always open; every mutation
  // (and the OAuth authorize redirects) calls assertSetupComplete → 403 until
  // setup is complete. ADMIN/MANAGER only.
  // =====================================================================

  "/settings/business-profile": {
    get: {
      tags: ["Settings"],
      summary: "Get business profile",
      description: "Returns the BusinessSettings singleton (or null).",
      responses: {
        "200": jsonResponse("BusinessSettings (or null).", nullableRef("BusinessSettings")),
        "401": ERR[401],
      },
    },
    patch: {
      tags: ["Settings"],
      summary: "Update business profile (partial)",
      description:
        "Partial upsert of step-1 fields (businessName, phone, email, companyNumber, vatRegistered, vatRegistration, timezone, currency, defaultWorkingDays, bankDetails, addressLine1, addressLine2, town, postcode, vatRate). Omitted = untouched; null clears. Does not touch round-settings fields.",
      requestBody: jsonBody(ref("BusinessProfileUpdateInput")),
      responses: {
        "200": jsonResponse("Updated BusinessSettings.", ref("BusinessSettings")),
        "400": ERR[400],
        "401": ERR[401],
        "403": ERR[403],
      },
    },
  },

  "/settings/round-settings": {
    get: {
      tags: ["Settings"],
      summary: "Get round settings",
      description: "Returns the BusinessSettings singleton; read `defaultCycleLength` / `defaultWorkingDays` / `reminderMode` / `reminderTime` / `defaultCleanMethod` / `autoCreateNextVisit`.",
      responses: {
        "200": jsonResponse("BusinessSettings (or null).", nullableRef("BusinessSettings")),
        "401": ERR[401],
      },
    },
    patch: {
      tags: ["Settings"],
      summary: "Update round settings (partial)",
      description: "Partial upsert of round fields only (`defaultCycleLength`, `defaultWorkingDays`, `reminderMode`, `reminderTime`, `defaultCleanMethod`, `autoCreateNextVisit`). The deprecated `preCleanReminderTimings` is still accepted and mapped onto `reminderMode` when `reminderMode` is not sent (EVENING_BEFORE → EVENING_BEFORE, TWO_HOURS_BEFORE → MORNING_OF, [] → NONE).",
      requestBody: jsonBody(ref("RoundSettingsUpdateInput")),
      responses: {
        "200": jsonResponse("Updated BusinessSettings.", ref("BusinessSettings")),
        "400": ERR[400],
        "401": ERR[401],
        "403": ERR[403],
      },
    },
  },

  "/settings/services": {
    get: {
      tags: ["Settings"],
      summary: "List services",
      responses: {
        "200": jsonResponse("All services.", { type: "array", items: ref("Service") }),
        "401": ERR[401],
      },
    },
    post: {
      tags: ["Settings"],
      summary: "Create a service",
      requestBody: jsonBody(ref("ServiceCreateInput")),
      responses: {
        "201": jsonResponse("The created service.", ref("Service")),
        "400": ERR[400],
        "401": ERR[401],
        "403": ERR[403],
      },
    },
  },
  "/settings/services/{id}": {
    parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
    patch: {
      tags: ["Settings"],
      summary: "Update a service (partial)",
      requestBody: jsonBody(ref("ServiceUpdateInput")),
      responses: {
        "200": jsonResponse("The updated service.", ref("Service")),
        "400": ERR[400],
        "401": ERR[401],
        "403": ERR[403],
        "404": ERR[404],
      },
    },
    delete: {
      tags: ["Settings"],
      summary: "Delete a service",
      description: "409 if any ServicePlan or Visit references the service.",
      responses: {
        "204": { description: "Deleted." },
        "401": ERR[401],
        "403": ERR[403],
        "404": ERR[404],
        "409": ERR[409],
      },
    },
  },

  "/settings/service-areas": {
    get: {
      tags: ["Settings"],
      summary: "List service areas (with linkedRounds)",
      description: "Each area includes a derived, read-only `linkedRounds` summary.",
      responses: {
        "200": jsonResponse("All service areas.", { type: "array", items: ref("ServiceAreaWithRounds") }),
        "401": ERR[401],
      },
    },
    post: {
      tags: ["Settings"],
      summary: "Create a service area",
      requestBody: jsonBody(ref("ServiceAreaCreateInput")),
      responses: {
        "201": jsonResponse("The created service area.", ref("ServiceArea")),
        "400": ERR[400],
        "401": ERR[401],
        "403": ERR[403],
      },
    },
  },
  "/settings/service-areas/{id}": {
    parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
    patch: {
      tags: ["Settings"],
      summary: "Update a service area (partial)",
      requestBody: jsonBody(ref("ServiceAreaUpdateInput")),
      responses: {
        "200": jsonResponse("The updated service area.", ref("ServiceArea")),
        "400": ERR[400],
        "401": ERR[401],
        "403": ERR[403],
        "404": ERR[404],
      },
    },
    delete: {
      tags: ["Settings"],
      summary: "Delete a service area",
      description: "409 if any Round or Property references the area.",
      responses: {
        "204": { description: "Deleted." },
        "401": ERR[401],
        "403": ERR[403],
        "404": ERR[404],
        "409": ERR[409],
      },
    },
  },

  "/settings/technicians": {
    get: {
      tags: ["Settings"],
      summary: "List technicians (with displayName + appStatus)",
      responses: {
        "200": jsonResponse("All technicians.", { type: "array", items: ref("TechnicianWithDisplayName") }),
        "401": ERR[401],
      },
    },
    post: {
      tags: ["Settings"],
      summary: "Create an invite-pending technician",
      requestBody: jsonBody(ref("TechnicianCreateInput")),
      responses: {
        "201": jsonResponse("The created technician.", ref("Technician")),
        "400": ERR[400],
        "401": ERR[401],
        "403": ERR[403],
      },
    },
  },
  "/settings/technicians/{id}": {
    parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
    patch: {
      tags: ["Settings"],
      summary: "Update a technician (partial)",
      requestBody: jsonBody(ref("TechnicianUpdateInput")),
      responses: {
        "200": jsonResponse("The updated technician.", ref("Technician")),
        "400": ERR[400],
        "401": ERR[401],
        "403": ERR[403],
        "404": ERR[404],
      },
    },
    delete: {
      tags: ["Settings"],
      summary: "Delete a technician",
      description: "Only invite-pending technicians (profileId = null) can be deleted; 409 if the invite was accepted.",
      responses: {
        "204": { description: "Deleted." },
        "401": ERR[401],
        "403": ERR[403],
        "404": ERR[404],
        "409": ERR[409],
      },
    },
  },

  "/settings/payment": {
    get: {
      tags: ["Settings"],
      summary: "Get payment setup",
      description: "Returns the BusinessSettings singleton; read the payment fields.",
      responses: {
        "200": jsonResponse("BusinessSettings (or null).", nullableRef("BusinessSettings")),
        "401": ERR[401],
      },
    },
    patch: {
      tags: ["Settings"],
      summary: "Update payment rules (partial)",
      description: "Updates `paymentRule` / `vatInInvoices` / `debtHoldEnabled` / `debtHoldMaxInvoices` / `debtHoldMaxAmount` / `defaultPaymentMethod` / `invoiceDueDays` / `noDirectDebitAction` only. Does NOT touch the connect flags — use the GoCardless/Stripe connect endpoints for those.",
      requestBody: jsonBody(ref("PaymentRulesUpdateInput")),
      responses: {
        "200": jsonResponse("Updated BusinessSettings.", ref("BusinessSettings")),
        "400": ERR[400],
        "401": ERR[401],
        "403": ERR[403],
      },
    },
  },
  // ---- Integrations: GoCardless (token connect) ----
  // A5/A6: the connect / disconnect / status / webhook-secret routes do NOT
  // call assertSetupComplete — the Setup Wizard connects providers before
  // setup is complete.
  "/settings/payment/gocardless/connect": {
    post: {
      tags: ["Integrations"],
      summary: "Connect GoCardless with an access token",
      description:
        "Allowed before setup is complete (A6). Verifies `accessToken` against the GoCardless API (`creditors.list`) — 400 if it fails. " +
        "On success stores the token (encrypted) + environment, sets `gocardlessConnected = true`, generates a fresh random route secret and returns the `webhookUrl` the admin must add by hand in the GoCardless dashboard " +
        "(GoCardless has no API for creating webhook endpoints). Then paste GoCardless's signing secret via PATCH /settings/payment/gocardless/webhook-secret. Re-connecting rotates the route secret.",
      requestBody: jsonBody(ref("GoCardlessConnectInput")),
      responses: {
        "200": jsonResponse("Connected.", ref("ProviderConnectResponse")),
        "400": errorResponse("Missing field, bad environment, or the token could not be verified.", "GoCardless access token is invalid or could not be verified"),
        "401": ERR[401],
        "403": ERR[403],
      },
    },
  },
  "/settings/payment/gocardless/disconnect": {
    post: {
      tags: ["Integrations"],
      summary: "Disconnect GoCardless",
      description: "Allowed before setup is complete. Clears the access token, route secret, signing secret and environment, and sets `gocardlessConnected = false`. Existing customer mandates are not touched.",
      responses: {
        "200": jsonResponse("Disconnected.", ref("ProviderStatusResult")),
        "401": ERR[401],
        "403": ERR[403],
      },
    },
  },
  "/settings/payment/gocardless/webhook-secret": {
    patch: {
      tags: ["Integrations"],
      summary: "Save the GoCardless webhook signing secret",
      description:
        "Allowed before setup is complete. Stores (encrypted) the signing secret GoCardless issued for the endpoint the admin created at the `webhookUrl` from connect. " +
        "Until this is saved, POST /webhooks/gocardless silently acks events without processing them.",
      requestBody: jsonBody(ref("GoCardlessWebhookSecretInput")),
      responses: {
        "200": jsonResponse("Saved.", ref("ProviderStatusResult")),
        "400": ERR[400],
        "401": ERR[401],
        "403": ERR[403],
        "409": errorResponse("GoCardless is not connected.", "GoCardless is not connected for this account"),
      },
    },
  },

  // ---- Integrations: Stripe Connect (OAuth) ----
  "/settings/stripe/authorize": {
    get: {
      tags: ["Integrations"],
      summary: "Get the Stripe Connect consent URL",
      description:
        "Allowed before setup is complete. Returns `200 { url }` — the `https://connect.stripe.com/oauth/authorize` URL (scope `read_write`, `state = <tenantId>:<random>`). " +
        "The web app now builds this URL itself from VITE_STRIPE_CONNECT_CLIENT_ID; this endpoint is kept for API clients. " +
        "A top-level browser navigation (`Accept: text/html` and not application/json) still gets the old `302` for one release.",
      responses: {
        "200": jsonResponse("Consent URL.", ref("OAuthAuthorizeUrl")),
        "302": { description: "Browser navigation only — redirect to the Stripe consent page.", headers: { Location: { schema: { type: "string" } } } },
        "401": ERR[401],
        "403": ERR[403],
      },
    },
  },
  "/settings/stripe/callback": {
    get: {
      tags: ["Integrations"],
      summary: "Stripe Connect OAuth callback",
      description:
        "Exchanges `code` for the connected account's credentials, stores them (secret key encrypted), sets `stripeConnected = true` and mirrors `stripeConnectAccountId` onto the public Tenant row (for the platform-level Connect webhook). " +
        "Bearer-authenticated: the web's callback page relays `?code&state` with `Accept: application/json` and gets `200 { status: \"connected\", stripeConnectAccountId }`; any other Accept gets a `302` to `${FRONTEND_URL}/settings/integrations?stripe=connected`. " +
        "Errors are JSON (400 when denied or `code`/`state` missing). `state` is not validated.",
      parameters: [
        { name: "code", in: "query", required: false, schema: { type: "string" } },
        { name: "state", in: "query", required: false, schema: { type: "string" } },
        { name: "error", in: "query", required: false, schema: { type: "string" }, description: "Set by Stripe when the admin denies access → 400." },
      ],
      responses: {
        "200": jsonResponse("Connected (Accept: application/json).", ref("StripeCallbackResult")),
        "302": { description: "Redirect back to the frontend integrations page (non-JSON Accept)." },
        "400": errorResponse("Authorisation denied, or `code`/`state` missing.", "Missing code or state from Stripe"),
        "401": ERR[401],
        "403": ERR[403],
        "500": ERR[500],
      },
    },
  },
  "/settings/stripe/disconnect": {
    post: {
      tags: ["Integrations"],
      summary: "Disconnect Stripe",
      description: "Allowed before setup is complete. Clears the connected account id, publishable key and secret key, sets `stripeConnected = false`, and clears the Tenant mirror.",
      responses: {
        "200": jsonResponse("Disconnected.", ref("ProviderStatusResult")),
        "401": ERR[401],
        "403": ERR[403],
      },
    },
  },

  "/settings/message-templates": {
    get: {
      tags: ["Settings"],
      summary: "List message templates (SMS / WhatsApp / Email)",
      description: "Returns all saved message templates ordered by creation date.",
      responses: {
        "200": jsonResponse("Message templates.", { type: "array", items: ref("MessageTemplateView") }),
        "401": ERR[401],
        "403": ERR[403],
        "500": ERR[500],
      },
    },
    post: {
      tags: ["Settings"],
      summary: "Create a message template",
      requestBody: jsonBody(ref("MessageTemplateInput")),
      responses: {
        "201": jsonResponse("Created template.", ref("MessageTemplateView")),
        "400": ERR[400],
        "401": ERR[401],
        "403": ERR[403],
      },
    },
  },
  "/settings/message-templates/{id}": {
    parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
    patch: {
      tags: ["Settings"],
      summary: "Update a message template (partial)",
      requestBody: jsonBody(ref("MessageTemplateUpdateInput")),
      responses: {
        "200": jsonResponse("Updated template.", ref("MessageTemplateView")),
        "400": ERR[400],
        "401": ERR[401],
        "403": ERR[403],
        "404": ERR[404],
      },
    },
    delete: {
      tags: ["Settings"],
      summary: "Delete a message template",
      responses: {
        "204": { description: "Deleted." },
        "401": ERR[401],
        "403": ERR[403],
        "404": ERR[404],
      },
    },
  },

  // ---- Integrations: GoHighLevel ----
  "/settings/ghl/authorize": {
    get: {
      tags: ["Integrations"],
      summary: "Get the GHL OAuth consent URL",
      description:
        "Allowed before setup is complete. Returns `200 { url }` for GHL's OAuth consent page. `state` is a signed token (HMAC, 10-minute expiry) carrying the tenant id and the redirect URI, so the public callback can trust it. " +
        "Optional `redirectUri` = the web app's own callback page (must be on the FRONTEND_URL origin, 400 otherwise); default `${PUBLIC_API_URL}/settings/ghl/callback`. " +
        "A top-level browser navigation (`Accept: text/html` and not application/json) still gets a `302` for one release.",
      parameters: [
        { name: "redirectUri", in: "query", required: false, schema: { type: "string" }, description: "Where GHL sends the browser back to. Must be on the web app's origin." },
      ],
      responses: {
        "200": jsonResponse("Consent URL.", ref("OAuthAuthorizeUrl")),
        "302": { description: "Browser navigation only — redirect to the GHL consent page.", headers: { Location: { schema: { type: "string" } } } },
        "400": errorResponse("redirectUri is not on the web app's origin.", "redirectUri must be on the web app's origin"),
        "401": ERR[401],
        "403": ERR[403],
      },
    },
  },
  "/settings/ghl/callback": {
    get: {
      tags: ["Integrations"],
      summary: "GHL OAuth callback (public)",
      description:
        "**Public** — no Bearer token (GHL redirects the admin's browser here). The tenant and the redirect URI the code was issued for come from the signed `state` minted by GET /settings/ghl/authorize. " +
        "Exchanges `code` for access/refresh tokens (stored encrypted, with expiry), sets `ghlConnected = true`, stamps `ghlLocationId` on the public Tenant row and generates a webhook route secret. " +
        "With `Accept: application/json` (a web callback page relaying `?code&state`) it answers `200 { status, method: \"oauth\", locationId, webhookUrl }` or a JSON error; " +
        "otherwise it `302`s to `${FRONTEND_URL}/settings/integrations?ghl=connected&webhookUrl=…` (or `?ghl=error&message=…`).",
      security: [],
      parameters: [
        { name: "code", in: "query", required: false, schema: { type: "string" } },
        { name: "state", in: "query", required: false, schema: { type: "string" } },
        { name: "error", in: "query", required: false, schema: { type: "string" }, description: "Set by GHL when the admin denies access → 400." },
      ],
      responses: {
        "200": jsonResponse("Connected (Accept: application/json).", ref("GhlCallbackResult")),
        "302": { description: "Redirect back to the frontend integrations page (non-JSON Accept), carrying `ghl=connected&webhookUrl` or `ghl=error&message`." },
        "400": errorResponse("Denied, `code`/`state` missing, or `state` invalid/expired (code INVALID_STATE).", "This GHL connection link has expired. Start again from Settings."),
        "404": errorResponse("The tenant in `state` no longer exists.", "Tenant not found"),
        "502": errorResponse("GHL rejected the authorisation code (code GHL_SEND_FAILED).", "GoHighLevel rejected the authorisation code. Try connecting again."),
      },
    },
  },
  "/settings/ghl/status": {
    get: {
      tags: ["Integrations"],
      summary: "GHL connection status card",
      description: "`connected: false` with every other field null when not connected. `method` = `oauth` (has a refresh token) or `private` (location API key). `locationName` is fetched live from GHL (null when unreachable). `connectedAt` is always null for now.",
      responses: {
        "200": jsonResponse("Connection status.", ref("GhlStatus")),
        "401": ERR[401],
        "403": ERR[403],
      },
    },
  },
  "/settings/ghl/test": {
    post: {
      tags: ["Integrations"],
      summary: "Test the GHL connection",
      description: "Calls GHL `/locations/{id}` with the stored token.",
      responses: {
        "200": jsonResponse("Connection works.", ref("GhlTestResult")),
        "401": ERR[401],
        "403": ERR[403],
        "409": errorResponse("GHL is not connected (code GHL_NOT_CONNECTED).", "GoHighLevel is not connected"),
        "502": errorResponse("GHL call failed (code GHL_SEND_FAILED).", "GoHighLevel test failed: 401 Unauthorized"),
      },
    },
  },
  "/settings/ghl/connect-private": {
    post: {
      tags: ["Integrations"],
      summary: "Connect a GHL sub-account with a Location API key",
      description:
        "Allowed before setup is complete. Private-integration connect (no OAuth): verifies `apiKey` + `locationId` by fetching the location from GHL (400 if that fails), " +
        "stores the key encrypted (no refresh token / expiry — these keys don't expire), sets `ghlConnected = true`, stamps `ghlLocationId` on the Tenant row and returns the `webhookUrl` to register in GHL.",
      requestBody: jsonBody(ref("GhlPrivateConnectInput")),
      responses: {
        "200": jsonResponse("Connected.", ref("ProviderConnectResponse")),
        "400": errorResponse("Missing field, or the key/location could not be verified.", "GHL API key or location ID is invalid"),
        "401": ERR[401],
        "403": ERR[403],
      },
    },
  },
  "/settings/ghl/disconnect": {
    post: {
      tags: ["Integrations"],
      summary: "Disconnect GHL",
      description: "Allowed before setup is complete. Clears the GHL tokens, location id and webhook secret, sets `ghlConnected = false`, and clears the public Tenant row's `ghlLocationId` (so the outbox worker and inbound webhooks stop routing to this tenant).",
      responses: {
        "200": jsonResponse("Disconnected.", ref("ProviderStatusResult")),
        "401": ERR[401],
        "403": ERR[403],
      },
    },
  },

  // ---- KPI thresholds (B6 · GAP-025) — mounted before /settings ----
  "/settings/kpi-thresholds": {
    get: {
      tags: ["Settings"],
      summary: "List technician KPI alert thresholds",
      description: "ADMIN/MANAGER. Ordered by metric, operator. Not gated on setup completion.",
      responses: {
        "200": jsonResponse("Thresholds.", { type: "array", items: ref("KpiThreshold") }),
        "401": ERR[401],
        "403": ERR[403],
      },
    },
    put: {
      tags: ["Settings"],
      summary: "Replace all KPI alert thresholds",
      description:
        "Body: a raw array or `{ thresholds: [...] }`; replaces every threshold. `metric` ∈ strikes|damages|upsells|revenuePerHour|timeOnJobMinutes, `operator` ∈ GT|LT, `value` 0–99999999. " +
        "400 on a duplicate metric+operator pair. The nightly KPI check raises one alert per technician + metric + month when a threshold is crossed (surfaced in GET /dashboard/alerts `kpiAlerts`).",
      requestBody: jsonBody({
        oneOf: [
          { type: "array", items: ref("KpiThresholdInput") },
          { type: "object", required: ["thresholds"], properties: { thresholds: { type: "array", items: ref("KpiThresholdInput") } } },
        ],
      }),
      responses: {
        "200": jsonResponse("The saved thresholds.", { type: "array", items: ref("KpiThreshold") }),
        "400": ERR[400],
        "401": ERR[401],
        "403": ERR[403],
      },
    },
  },

  // =====================================================================
  // Customers (M2) — ADMIN/MANAGER only (reads and mutations)
  // =====================================================================
  "/customers": {
    post: {
      tags: ["Customers"],
      summary: "Create a standalone customer (no property)",
      description: "Creates a Customer record without an attached property. Use POST /properties to create a Customer+Property+ServicePlan in one shot.",
      requestBody: jsonBody({
        type: "object",
        required: ["name"],
        properties: {
          name: { type: "string", minLength: 1 },
          phone: { type: "string", nullable: true },
          email: { type: "string", nullable: true },
          paymentMethod: { ...nullableRef("PaymentMethod") },
        },
      }),
      responses: {
        "201": jsonResponse("Created customer.", ref("CustomerListRow")),
        "400": ERR[400],
        "401": ERR[401],
        "403": ERR[403],
      },
    },
    get: {
      tags: ["Customers"],
      summary: "List customers + summary KPIs (Screen 14)",
      description:
        "Search + filter, paginated (`page`/`pageSize`, default 1/50, max pageSize 100). `?search=` matches name/addressLine/postcode (case-insensitive contains); `?roundId=` filters by assigned round; `?status=` ∈ ACTIVE|PAUSED|CANCELLED|HOLD (HOLD is derived from paymentHold visits). Summary KPIs are business-wide (not filtered). " +
        "Rows carry `paymentStatus` as the uppercase enum NONE|PAID|UNPAID|OVERDUE|ON_HOLD|FAILED (BREAKING — was lowercase paid/hold/pending/overdue/failed/none), plus `nextDue` and `badDebt`; `amountDue` = unpaid SENT invoices.",
      parameters: [
        { name: "search", in: "query", required: false, schema: { type: "string" } },
        { name: "roundId", in: "query", required: false, schema: { type: "string" } },
        { name: "status", in: "query", required: false, schema: { type: "string", enum: ["ACTIVE", "PAUSED", "CANCELLED", "HOLD"] } },
        { name: "page", in: "query", required: false, schema: { type: "integer", minimum: 1, default: 1 } },
        { name: "pageSize", in: "query", required: false, schema: { type: "integer", minimum: 1, maximum: 100, default: 50 } },
      ],
      responses: {
        "200": jsonResponse("List + summary.", ref("CustomerListResult")),
        "400": ERR[400],
        "401": ERR[401],
        "403": ERR[403],
      },
    },
  },
  "/customers/{id}": {
    parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
    get: {
      tags: ["Customers"],
      summary: "Full Customer Detail aggregate (Screen 15 — all 6 tabs in one call)",
      responses: {
        "200": jsonResponse("Customer Detail aggregate.", ref("CustomerDetail")),
        "401": ERR[401],
        "403": ERR[403],
        "404": ERR[404],
      },
    },
    patch: {
      tags: ["Customers"],
      summary: "M19 — Edit Customer Record (Customer + Property + Plan, atomic)",
      description: "Partial update. `messagesOptOut: true` stops automated messages (pre-clean reminders, visit-completed) for this customer. Queues a GHL customer.synced event.",
      requestBody: jsonBody(ref("CustomerUpdateInput")),
      responses: {
        "200": jsonResponse("Updated ids.", {
          type: "object",
          properties: {
            customerId: { type: "string" },
            propertyId: { type: "string", nullable: true },
            servicePlanId: { type: "string", nullable: true },
          },
        }),
        "400": ERR[400],
        "401": ERR[401],
        "403": ERR[403],
        "404": ERR[404],
      },
    },
    delete: {
      tags: ["Customers"],
      summary: "Soft-delete customer (status → CANCELLED, cascades to properties)",
      responses: {
        "204": { description: "Deleted." },
        "401": ERR[401],
        "403": ERR[403],
        "404": ERR[404],
      },
    },
  },
  "/customers/search": {
    get: {
      tags: ["Customers"],
      summary: "Customer picker search (GAP-010) — top 10",
      description: "Matches name, email, property postcode (case-insensitive contains) and phone/landline by digits (3+ digits). Non-cancelled customers only, ordered by name.",
      parameters: [{ name: "q", in: "query", required: true, schema: { type: "string", minLength: 1, maxLength: 255 } }],
      responses: {
        "200": jsonResponse("Up to 10 matches.", { type: "array", items: ref("CustomerSearchRow") }),
        "400": errorResponse("`q` missing/blank, too long, or contains a null byte.", '"q" is required and must be a non-empty string.'),
        "401": ERR[401],
        "403": ERR[403],
      },
    },
  },
  "/customers/{id}/visits": {
    parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
    get: {
      tags: ["Customers"],
      summary: "Paginated visit history (every status)",
      description: "Newest first; includes CANCELLED visits with `cancelReason` (the detail aggregate's visitHistory tab excludes them). `page`/`pageSize` default 1/50, max 100.",
      parameters: [
        { name: "page", in: "query", required: false, schema: { type: "integer", minimum: 1, default: 1 } },
        { name: "pageSize", in: "query", required: false, schema: { type: "integer", minimum: 1, maximum: 100, default: 50 } },
      ],
      responses: {
        "200": jsonResponse("Visit history page.", ref("CustomerVisitsPage")),
        "400": ERR[400],
        "401": ERR[401],
        "403": ERR[403],
        "404": errorResponse("Customer not found.", "Customer not found"),
      },
    },
  },
  "/customers/{id}/bad-debt": {
    parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
    patch: {
      tags: ["Customers"],
      summary: "Flag / clear a customer as bad debt (GAP-022)",
      description: "There is no reason column — `reason` is written to the activity log (CUSTOMER_BAD_DEBT_FLAGGED / CUSTOMER_BAD_DEBT_CLEARED).",
      requestBody: jsonBody({
        type: "object",
        required: ["flag"],
        properties: { flag: { type: "boolean" }, reason: { type: "string", nullable: true } },
        example: { flag: true, reason: "Moved away, unreachable" },
      }),
      responses: {
        "200": jsonResponse("Updated flag.", {
          type: "object",
          required: ["id", "badDebt"],
          properties: { id: { type: "string" }, badDebt: { type: "boolean" } },
        }),
        "400": errorResponse("`flag` missing or not a boolean.", '"flag" is required and must be a boolean.'),
        "401": ERR[401],
        "403": ERR[403],
        "404": errorResponse("Customer not found.", "Customer not found"),
      },
    },
  },
  "/customers/{id}/properties": {
    parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
    post: {
      tags: ["Customers"],
      summary: "Add a property (+ ServicePlan) to an existing customer",
      description: "Atomic Property + ServicePlan create. 404 if the customer, round or service area doesn't exist; 409 if the customer is CANCELLED. Geocoding runs in the background.",
      requestBody: jsonBody(ref("CustomerPropertyAddInput")),
      responses: {
        "201": jsonResponse("Created.", ref("CustomerPropertyAddResult")),
        "400": ERR[400],
        "401": ERR[401],
        "403": ERR[403],
        "404": ERR[404],
        "409": errorResponse("Customer is cancelled.", "Cannot add a property to a cancelled customer"),
      },
    },
  },
  "/customers/{id}/invoices": {
    parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
    get: {
      tags: ["Customers"],
      summary: "List a customer's invoices, newest first",
      description: "Returns `[]` for an unknown customer id (no 404). Each row carries `paidAt` and the linked visit's `payment` ({ id, status, method } or null).",
      responses: {
        "200": jsonResponse("Invoices.", { type: "array", items: ref("CustomerInvoiceRow") }),
        "401": ERR[401],
        "403": ERR[403],
      },
    },
  },
  "/customers/{id}/mandate": {
    parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
    post: {
      tags: ["Customers"],
      summary: "Start a GoCardless Direct Debit mandate (redirect flow)",
      description:
        "Creates a GoCardless redirect flow using the tenant's stored GoCardless token and returns its URL. The customer is sent back to `${FRONTEND_URL}/customers/{id}/mandate/success`, after which the frontend calls POST /customers/{id}/mandate/complete.",
      responses: {
        "200": jsonResponse("Redirect-flow URL.", ref("MandateRedirectResult")),
        "401": ERR[401],
        "403": ERR[403],
        "404": ERR[404],
        "409": errorResponse("Customer already has an active mandate, or GoCardless is not connected.", "GoCardless is not connected for this account"),
      },
    },
  },
  "/customers/{id}/mandate/complete": {
    parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
    post: {
      tags: ["Customers"],
      summary: "Complete the GoCardless redirect flow",
      description:
        "Completes `redirectFlowId` with GoCardless and stores the GoCardless customer + mandate ids on the customer with `gocardlessMandateStatus = pending_customer_approval`. The status moves to `active` (etc.) via POST /webhooks/gocardless mandate events.",
      requestBody: jsonBody(ref("MandateCompleteInput")),
      responses: {
        "200": jsonResponse("Mandate created.", ref("MandateCompleteResult")),
        "400": ERR[400],
        "401": ERR[401],
        "403": ERR[403],
        "404": ERR[404],
        "409": errorResponse("GoCardless is not connected.", "GoCardless is not connected"),
      },
    },
  },

  // =====================================================================
  // Properties (M2)
  // =====================================================================
  "/properties": {
    post: {
      tags: ["Properties"],
      summary: "M6 — Add Property (creates Customer + Property + ServicePlan, atomic)",
      description:
        "Creates a new Customer together with its first Property + ServicePlan. (POST /customers creates a bare customer; POST /customers/{id}/properties adds a property to an existing one.) `roundId: null` = Save & Assign Later (unassigned).",
      requestBody: jsonBody(ref("PropertyCreateInput")),
      responses: {
        "201": jsonResponse("Created.", {
          type: "object",
          properties: {
            customerId: { type: "string" },
            propertyId: { type: "string" },
            servicePlanId: { type: "string" },
            assigned: { type: "boolean" },
          },
        }),
        "400": ERR[400],
        "401": ERR[401],
        "403": ERR[403],
        "404": ERR[404],
      },
    },
  },
  "/properties/{id}": {
    parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
    patch: {
      tags: ["Properties"],
      summary: "Update property (+ Move Round: assign/unassign, frequency move)",
      description:
        "`cleaningFrequency` without `roundId` reuses the B3 move logic of PATCH /service-plans/{id}: the plan (and property) move to a matching ACTIVE round in the service area, " +
        "else 409 `NO_MATCHING_ROUND` with `suggestions` + `proposedName` unless `createRoundIfMissing: true` (then that round is created). The move runs first, so a 409 leaves the property untouched. " +
        "Response = the Property plus `movedToRound` ({ id, name, created } or null).",
      requestBody: jsonBody(ref("PropertyUpdateInput")),
      responses: {
        "200": jsonResponse("Updated property.", ref("PropertyUpdateResult")),
        "400": ERR[400],
        "401": ERR[401],
        "403": ERR[403],
        "404": ERR[404],
        "409": jsonResponse("No ACTIVE round matches the new frequency (code NO_MATCHING_ROUND).", ref("NoMatchingRoundError")),
      },
    },
    delete: {
      tags: ["Properties"],
      summary: "Soft-delete property (status → CANCELLED, cancels service plan)",
      responses: {
        "204": { description: "Deleted." },
        "401": ERR[401],
        "403": ERR[403],
        "404": ERR[404],
      },
    },
  },
  "/properties/{id}/pause": {
    parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
    post: {
      tags: ["Properties"],
      summary: "M9 — Pause Service",
      description:
        "Pauses the property's primary plan. SCHEDULED visits of the plan inside [pauseStartDate, pauseEndDate] (end inclusive; open-ended = every visit from the start) are CANCELLED with `cancelReason: \"PAUSED\"`. " +
        "A start on/before today sets the plan PAUSED now; a future start keeps it ACTIVE with the window stored (`pauseScheduled: true`) and the nightly job pauses it on the day. " +
        "409 if the plan is already PAUSED. `reason` is validated but not persisted (no column).",
      requestBody: jsonBody(ref("PauseServiceInput")),
      responses: {
        "200": jsonResponse("Updated ServicePlan + pause outcome.", ref("PauseResult")),
        "400": ERR[400],
        "401": ERR[401],
        "403": ERR[403],
        "404": ERR[404],
        "409": ERR[409],
      },
    },
  },
  "/properties/{id}/resume": {
    parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
    post: {
      tags: ["Properties"],
      summary: "Resume Service (status → ACTIVE, clears pause window)",
      description: "Sets the plan ACTIVE, clears the pause window and sets nextDueDate to the round's next defaultDay on/after today (cancelled visits are not restored; the nightly generator creates the next one). Also cancels a scheduled (future) pause. 409 if the plan is neither PAUSED nor has a pause window.",
      responses: {
        "200": jsonResponse("Updated ServicePlan.", ref("ServicePlan")),
        "401": ERR[401],
        "403": ERR[403],
        "404": ERR[404],
        "409": ERR[409],
      },
    },
  },
  "/properties/{id}/notes": {
    parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
    get: {
      tags: ["Properties"],
      summary: "List notes (Notes & Risk): pinned access/risk notes, then notes newest first",
      description: "GAP-022: non-blank `accessNotes` / `riskNotes` come first as `{ pinned: true, source: ACCESS|RISK, body }`; every PropertyNote follows with `pinned: false`.",
      responses: {
        "200": jsonResponse("Notes.", {
          type: "array",
          items: { oneOf: [ref("PinnedNote"), { allOf: [ref("PropertyNote"), { type: "object", properties: { pinned: { type: "boolean", enum: [false] } } }] }] },
        }),
        "401": ERR[401],
        "403": ERR[403],
        "404": ERR[404],
      },
    },
    post: {
      tags: ["Properties"],
      summary: "M20 — Add Note (author = acting Profile)",
      requestBody: jsonBody(ref("NoteCreateInput")),
      responses: {
        "201": jsonResponse("Created note.", ref("PropertyNote")),
        "400": ERR[400],
        "401": ERR[401],
        "403": ERR[403],
        "404": ERR[404],
      },
    },
  },

  "/properties/{id}/photos": {
    parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
    get: {
      tags: ["Properties"],
      summary: "Property photo gallery (B4 · GAP-019)",
      description: "Photos of the property plus its visits' BEFORE/AFTER photos, newest first. `url`/`thumbnailUrl` are 1-hour signed read URLs (refetch on focus). `pageSize` default 24, max 100.",
      parameters: [
        { name: "type", in: "query", required: false, schema: ref("PhotoType") },
        { name: "page", in: "query", required: false, schema: { type: "integer", minimum: 1, default: 1 } },
        { name: "pageSize", in: "query", required: false, schema: { type: "integer", minimum: 1, maximum: 100, default: 24 } },
      ],
      responses: {
        "200": jsonResponse("Photo page.", ref("PhotoPage")),
        "400": errorResponse("Bad `type` or paging params.", "type must be one of: PROPERTY, BEFORE, AFTER"),
        "401": ERR[401],
        "403": ERR[403],
        "404": errorResponse("Property not found.", "Property not found"),
      },
    },
  },

  // =====================================================================
  // Complaints
  // =====================================================================
  "/complaints": {
    get: {
      tags: ["Complaints"],
      summary: "List Complaints — paginated, newest first",
      description: "Paginated (`page`/`pageSize`, default 1/50, max pageSize 100) — returns `{ rows, pagination }`, not a bare array. Optional filters: `status` (OPEN|IN_REVIEW|REVISIT_BOOKED|RESOLVED), `search` (title or customer name), `assignedTo=me` (filter to current user's technician). TECHNICIAN role receives 403.",
      parameters: [
        { name: "status", in: "query", required: false, schema: { type: "string", enum: ["OPEN", "IN_REVIEW", "REVISIT_BOOKED", "RESOLVED"] } },
        { name: "search", in: "query", required: false, schema: { type: "string" }, description: "Case-insensitive search on title or customer name." },
        { name: "assignedTo", in: "query", required: false, schema: { type: "string", enum: ["me"] }, description: "Pass `me` to return only complaints assigned to the calling user's technician record." },
        { name: "technicianId", in: "query", required: false, schema: { type: "string" }, description: "Filter by specific technician ID. Ignored when `assignedTo=me`." },
        { name: "page", in: "query", required: false, schema: { type: "integer", minimum: 1, default: 1 } },
        { name: "pageSize", in: "query", required: false, schema: { type: "integer", minimum: 1, maximum: 100, default: 50 } },
      ],
      responses: {
        "200": jsonResponse("Paginated complaint list.", ref("ComplaintsListResult")),
        "400": ERR[400],
        "401": ERR[401],
        "403": ERR[403],
      },
    },
    post: {
      tags: ["Complaints"],
      summary: "Log Complaint — record a new customer service complaint",
      description: "Creates a complaint with `status: OPEN`. All customer fields reference an existing customer record by `customerId`. TECHNICIAN role receives 403.",
      requestBody: jsonBody(ref("ComplaintCreateInput")),
      responses: {
        "201": jsonResponse("Complaint created.", ref("Complaint")),
        "400": ERR[400],
        "401": ERR[401],
        "403": ERR[403],
        "404": ERR[404],
      },
    },
  },

  "/complaints/{id}": {
    get: {
      tags: ["Complaints"],
      summary: "Get Complaint — fetch a single complaint by ID",
      parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
      responses: {
        "200": jsonResponse("Complaint detail.", ref("Complaint")),
        "401": ERR[401],
        "403": ERR[403],
        "404": ERR[404],
      },
    },
  },

  "/complaints/{id}/messages": {
    get: {
      tags: ["Complaints"],
      summary: "List Messages — get the full message thread for a complaint",
      parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
      responses: {
        "200": jsonResponse("Message thread.", { type: "array", items: ref("ComplaintMessage") }),
        "401": ERR[401],
        "403": ERR[403],
        "404": ERR[404],
      },
    },
    post: {
      tags: ["Complaints"],
      summary: "Add Message — send an outbound reply on the complaint thread",
      parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
      requestBody: jsonBody(ref("AddMessageInput")),
      responses: {
        "201": jsonResponse("Message created.", ref("ComplaintMessage")),
        "400": ERR[400],
        "401": ERR[401],
        "403": ERR[403],
        "404": ERR[404],
      },
    },
  },

  "/complaints/{id}/mark-in-review": {
    post: {
      tags: ["Complaints"],
      summary: "Mark In Review — set complaint status to IN_REVIEW",
      parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
      responses: {
        "200": jsonResponse("Updated complaint.", ref("Complaint")),
        "401": ERR[401],
        "403": ERR[403],
        "404": ERR[404],
      },
    },
  },

  "/complaints/{id}/schedule-revisit": {
    post: {
      tags: ["Complaints"],
      summary: "Schedule Revisit — book a revisit date and set status to REVISIT_BOOKED",
      description:
        "GAP-029: also books a free (price 0) one-off SCHEDULED revisit visit on the property's round for that date, so it shows in the planner and the technician app. " +
        "Technician = the complaint's technician when active and invite-accepted (pinned with technicianOverride), else whoever the round gives the property that day. " +
        "Rebooking moves the complaint's open revisit visit instead of adding another. Response = the complaint plus `visitId` (null when the complaint has no property).",
      parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
      requestBody: jsonBody(ref("ScheduleRevisitInput")),
      responses: {
        "200": jsonResponse("Updated complaint + revisit visit id.", {
          allOf: [ref("Complaint"), { type: "object", required: ["visitId"], properties: { visitId: { type: "string", nullable: true } } }],
        }),
        "400": ERR[400],
        "401": ERR[401],
        "403": ERR[403],
        "404": ERR[404],
      },
    },
  },

  "/complaints/{id}/resolve": {
    post: {
      tags: ["Complaints"],
      summary: "Resolve — mark complaint as RESOLVED",
      description: "Sets resolvedAt (now) and resolvedBy (the calling user's Profile — returned as `{ id, name }`). Optional `notes` and `upheld` (boolean) are persisted; an upheld complaint with a technician counts as a strike in technician KPIs.",
      parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
      requestBody: jsonBody(ref("ResolveComplaintInput"), false),
      responses: {
        "200": jsonResponse("Updated complaint.", ref("Complaint")),
        "400": ERR[400],
        "401": ERR[401],
        "403": ERR[403],
        "404": ERR[404],
      },
    },
  },

  "/complaints/{id}/reopen": {
    post: {
      tags: ["Complaints"],
      summary: "Reopen — reset a resolved complaint back to OPEN",
      parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
      responses: {
        "200": jsonResponse("Updated complaint.", ref("Complaint")),
        "401": ERR[401],
        "403": ERR[403],
        "404": ERR[404],
      },
    },
  },

  "/complaints/{id}/assign-technician": {
    post: {
      tags: ["Complaints"],
      summary: "Assign Technician — link a technician to a complaint",
      description: "Attribution only, so pending-invite technicians are allowed (GAP-029).",
      parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
      requestBody: jsonBody(ref("AssignTechnicianInput")),
      responses: {
        "200": jsonResponse("Updated complaint.", ref("Complaint")),
        "400": ERR[400],
        "401": ERR[401],
        "403": ERR[403],
        "404": ERR[404],
      },
    },
  },

  // =====================================================================
  // Emergencies
  // =====================================================================
  "/emergencies": {
    get: {
      tags: ["Emergencies"],
      summary: "List emergencies",
      description: "Returns all technician emergency reports, newest first. Filter by `status` to get only active or resolved ones. ADMIN/MANAGER only.",
      parameters: [
        {
          name: "status",
          in: "query",
          required: false,
          schema: { type: "string", enum: ["ACTIVE", "RESOLVED"] },
          description: "Filter by status. Omit to return all.",
        },
      ],
      responses: {
        "200": jsonResponse("Emergency list.", { type: "array", items: ref("EmergencyRow") }),
        "401": ERR[401],
        "403": ERR[403],
      },
    },
    post: {
      tags: ["Emergencies"],
      summary: "Report an emergency",
      description: "Technician self-reports that they cannot complete a round. Creates an ACTIVE emergency record. Any authenticated user may call this (technicians included).",
      requestBody: jsonBody({
        type: "object",
        required: ["technicianId", "roundId", "remainingStops"],
        properties: {
          technicianId: { type: "string", description: "The technician who cannot continue." },
          roundId: { type: "string", description: "The round they were assigned to." },
          remainingStops: { type: "integer", minimum: 0, description: "Properties not yet visited.", example: 3 },
          lastLocation: { type: "string", nullable: true, example: "Alnwick High St Hub" },
          scheduledWindowEnd: { type: "string", format: "date-time", nullable: true, description: "When the service window closes." },
          notes: { type: "string", nullable: true },
        },
        example: {
          technicianId: "t1",
          roundId: "r1",
          remainingStops: 3,
          lastLocation: "Alnwick High St Hub",
          scheduledWindowEnd: "2026-09-15T20:30:00.000Z",
        },
      }),
      responses: {
        "201": jsonResponse("Emergency created.", ref("EmergencyRow")),
        "400": ERR[400],
        "401": ERR[401],
        "404": errorResponse("Technician or round not found.", "Technician not found"),
      },
    },
  },

  "/emergencies/{id}": {
    parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
    get: {
      tags: ["Emergencies"],
      summary: "Get emergency detail",
      description: "Returns full detail for one emergency. ADMIN/MANAGER only.",
      responses: {
        "200": jsonResponse("Emergency detail.", ref("EmergencyRow")),
        "401": ERR[401],
        "403": ERR[403],
        "404": ERR[404],
      },
    },
  },

  "/emergencies/{id}/available-technicians": {
    parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
    get: {
      tags: ["Emergencies"],
      summary: "List available technicians for reassignment",
      description:
        "Returns all active technicians except the one who reported the emergency, each with their remaining job count for today and a derived availability status. Feed this into the reassignment picker. ADMIN/MANAGER only.",
      responses: {
        "200": jsonResponse("Available technicians.", { type: "array", items: ref("AvailableTechnicianRow") }),
        "401": ERR[401],
        "403": ERR[403],
        "404": ERR[404],
      },
    },
  },

  "/emergencies/{id}/reassign": {
    parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
    post: {
      tags: ["Emergencies"],
      summary: "Confirm reassignment",
      description:
        "Atomically: marks the emergency RESOLVED, sets `assignedTechnicianId`, and bulk-reassigns all remaining SCHEDULED/IN_PROGRESS visits on that round today from the original technician to the new one. 409 if the emergency is already resolved. ADMIN/MANAGER only.",
      requestBody: jsonBody({
        type: "object",
        required: ["newTechnicianId"],
        properties: {
          newTechnicianId: { type: "string", description: "The technician taking over the remaining stops." },
        },
        example: { newTechnicianId: "t2" },
      }),
      responses: {
        "200": jsonResponse("Resolved emergency.", ref("EmergencyRow")),
        "400": ERR[400],
        "401": ERR[401],
        "403": ERR[403],
        "404": errorResponse("Emergency or technician not found.", "Emergency not found"),
        "409": errorResponse("Emergency is already resolved.", "Emergency is already resolved"),
      },
    },
  },

  // =====================================================================
  // Dashboard — ADMIN/MANAGER only
  // =====================================================================
  "/dashboard/kpis": {
    get: {
      tags: ["Dashboard"],
      summary: "Top metric cards",
      description:
        "Returns 6 KPI values derived from today's visits, open complaints, and this month's payment/revenue data. ADMIN/MANAGER only.",
      responses: {
        "200": jsonResponse("Dashboard KPIs.", ref("DashboardKpis")),
        "401": ERR[401],
        "403": ERR[403],
      },
    },
  },

  "/dashboard/alerts": {
    get: {
      tags: ["Dashboard"],
      summary: "Alert card counts",
      description:
        "Three live-query counts: skipped visits today, failed/overdue payments (all time), and open complaints with a revisit due before end of this week. ADMIN/MANAGER only.",
      responses: {
        "200": jsonResponse("Alert counts.", ref("DashboardAlerts")),
        "401": ERR[401],
        "403": ERR[403],
      },
    },
  },

  "/dashboard/rounds": {
    get: {
      tags: ["Dashboard"],
      summary: "Today's rounds table",
      description:
        "Returns one row per round that has visits scheduled today, with completion progress, issue count, and value. ADMIN/MANAGER only.",
      responses: {
        "200": jsonResponse("Round rows.", { type: "array", items: ref("DashboardRoundRow") }),
        "401": ERR[401],
        "403": ERR[403],
      },
    },
  },

  "/dashboard/technician-kpis": {
    get: {
      tags: ["Dashboard"],
      summary: "Per-technician performance",
      description:
        "One row per active technician for the requested period: jobs/value completed, open complaints, issues, and (B6 · GAP-025, now computed) timeOnJobMinutes, revenuePerHour, strikes, damages, upsells, upsellValue. ADMIN/MANAGER only.",
      parameters: [
        {
          name: "period",
          in: "query",
          required: false,
          schema: { type: "string", enum: ["monthly", "yearly"], default: "monthly" },
          description: "Aggregation window. Defaults to `monthly` (current calendar month). `yearly` covers Jan 1 → Dec 31 of the current year.",
        },
      ],
      responses: {
        "200": jsonResponse("Technician KPI rows.", { type: "array", items: ref("TechnicianKpi") }),
        "401": ERR[401],
        "403": ERR[403],
      },
    },
  },

  "/dashboard/charts": {
    get: {
      tags: ["Dashboard"],
      summary: "Monthly chart data (bar charts)",
      description:
        "Returns parallel arrays of month labels, value-of-work-completed, and issue count for the last 6 or 12 calendar months. All three arrays are the same length so they can be fed directly into a chart library. `revenuePerHour` is a Phase-2 stub (always null). ADMIN/MANAGER only.",
      parameters: [
        {
          name: "range",
          in: "query",
          required: false,
          schema: { type: "string", enum: ["6m", "12m"], default: "6m" },
          description: "Number of months to include. Defaults to `6m` (last 6 calendar months including current).",
        },
        {
          name: "technicianIds",
          in: "query",
          required: false,
          schema: { type: "string" },
          description: "Comma-separated technician IDs. When given, restricts the chart data to visits assigned to one of these technicians.",
        },
      ],
      responses: {
        "200": jsonResponse("Chart data.", ref("DashboardChartData")),
        "401": ERR[401],
        "403": ERR[403],
      },
    },
  },

  // =====================================================================
  // Visits — one-off (ad-hoc) jobs
  // =====================================================================
  "/visits": {
    post: {
      tags: ["Visits"],
      summary: "Add One-off Job — create a single ad-hoc visit outside the recurring schedule",
      description:
        "Creates a visit with `isOneOff: true`. `roundId: null` means the visit appears in Today's Work only; supply a `roundId` to also show it in the Round Planner for that round. `servicePlanId` is always `null`. `status` is always `SCHEDULED`.",
      requestBody: jsonBody(ref("VisitCreateInput")),
      responses: {
        "201": jsonResponse("Created visit.", ref("Visit")),
        "400": ERR[400],
        "401": ERR[401],
        "403": ERR[403],
        "404": ERR[404],
      },
    },
  },
  "/visits/{id}/complete": {
    parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
    patch: {
      tags: ["Visits"],
      summary: "Mark a visit COMPLETED and create its Payment",
      description:
        "Shared with PATCH /mobile/visits/{id}/complete (D-2). Idempotent for already-COMPLETED visits (returns `payment: null`, no side effects); 409 for SKIPPED or CANCELLED. " +
        "All payment input is validated (and any GoCardless charge created) before anything is written; the visit, Payment, cheque log and outbox events are then written in one transaction, so a 400 leaves the visit untouched. " +
        "`payment.method` CASH → PAID payment; CHEQUE → PENDING payment with Payment.reference = chequeNumber; otherwise the effective method (visit → plan → customer) applies: CASH without confirmation is 400 PAYMENT_CONFIRMATION_REQUIRED, " +
        "BACS/CHEQUE → PENDING, GOCARDLESS with an active mandate → PENDING charge, STRIPE/none → no payment. Queues GHL `visit.completed` and, unless the customer opted out, a `message.visit_completed` customer message.",
      requestBody: jsonBody(ref("VisitCompleteInput"), false),
      responses: {
        "200": jsonResponse("Visit status + created payment.", ref("VisitCompleteResult")),
        "400": errorResponse("INVALID_PAYMENT, CHEQUE_NUMBER_REQUIRED or PAYMENT_CONFIRMATION_REQUIRED.", "Cash payment must be confirmed: send payment { method: \"CASH\" } (or cashConfirmed: true)"),
        "401": ERR[401],
        "403": ERR[403],
        "404": ERR[404],
        "409": errorResponse("Visit was skipped or cancelled.", "Cannot complete a skipped visit"),
      },
    },
  },

  "/visits/{id}/photos": {
    parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
    get: {
      tags: ["Visits"],
      summary: "Before/after photos for a visit (B4)",
      description: "Oldest first; `url`/`thumbnailUrl` are 1-hour signed read URLs. Returned as a single page.",
      responses: {
        "200": jsonResponse("Photos.", ref("VisitPhotosResult")),
        "401": ERR[401],
        "403": ERR[403],
        "404": errorResponse("Visit not found.", "Visit not found"),
      },
    },
  },

  // =====================================================================
  // Rounds — CRUD, planner (calendar + list/map views), today panel,
  // reassign, push-missed, on-demand visit generation. ADMIN/MANAGER only.
  // =====================================================================
  "/rounds": {
    get: {
      tags: ["Rounds"],
      summary: "List rounds",
      description: "Optional `status` filter (ACTIVE|DRAFT|ARCHIVED).",
      parameters: [
        { name: "status", in: "query", required: false, schema: { type: "string", enum: ["ACTIVE", "DRAFT", "ARCHIVED"] } },
      ],
      responses: {
        "200": jsonResponse("Round list.", { type: "array", items: ref("RoundSummary") }),
        "401": ERR[401],
        "403": ERR[403],
      },
    },
    post: {
      tags: ["Rounds"],
      summary: "Create a round",
      description: "Always created ACTIVE. `frequency` and `serviceAreaId` are required; `serviceAreaId` must reference an existing service area (404 if not).",
      requestBody: jsonBody(ref("RoundCreateInput")),
      responses: {
        "201": jsonResponse("Created round.", ref("RoundDetail")),
        "400": ERR[400],
        "401": ERR[401],
        "403": ERR[403],
        "404": ERR[404],
      },
    },
  },

  "/rounds/planner/occurrences": {
    get: {
      tags: ["Rounds"],
      summary: "Batched calendar view across multiple rounds",
      description:
        "One call in place of one GET /rounds/{id}/planner/occurrences per round. `roundIds` is a required comma-separated list (max 50 ids). At least one of `from`/`to` is required; the range must not exceed 90 days. An id with no matching visits simply gets an empty `occurrences` array — a stale/unknown round id never fails the whole call.",
      parameters: [
        { name: "roundIds", in: "query", required: true, schema: { type: "string" }, description: "Comma-separated round IDs, max 50." },
        { name: "from", in: "query", required: false, schema: { type: "string", format: "date" } },
        { name: "to", in: "query", required: false, schema: { type: "string", format: "date" } },
      ],
      responses: {
        "200": jsonResponse("One entry per requested round id.", { type: "array", items: ref("RoundOccurrenceBatchItem") }),
        "400": ERR[400],
        "401": ERR[401],
        "403": ERR[403],
      },
    },
  },

  "/rounds/planner/occurrences/{date}": {
    get: {
      tags: ["Rounds"],
      summary: "Batched day stops (list/map view) across multiple rounds",
      description:
        "One call in place of one GET /rounds/{id}/planner/occurrences/{date} per round. `roundIds` is a required comma-separated list (max 50 ids). An id with no matching visits simply gets an empty `stops` array.",
      parameters: [
        { name: "date", in: "path", required: true, schema: { type: "string", format: "date" } },
        { name: "roundIds", in: "query", required: true, schema: { type: "string" }, description: "Comma-separated round IDs, max 50." },
      ],
      responses: {
        "200": jsonResponse("One entry per requested round id.", { type: "array", items: ref("DayStopsForRound") }),
        "400": ERR[400],
        "401": ERR[401],
        "403": ERR[403],
      },
    },
  },

  "/rounds/{id}": {
    parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
    get: {
      tags: ["Rounds"],
      summary: "Get round detail",
      description: "Round plus its full technician list and property count.",
      responses: {
        "200": jsonResponse("Round detail.", ref("RoundDetail")),
        "401": ERR[401],
        "403": ERR[403],
        "404": ERR[404],
      },
    },
    patch: {
      tags: ["Rounds"],
      summary: "Update a round (partial)",
      description: "`frequency: null` clears it; `serviceAreaId` (if given) must exist (404 if not); `status` can be set directly (e.g. to ARCHIVED).",
      requestBody: jsonBody(ref("RoundUpdateInput")),
      responses: {
        "200": jsonResponse("Updated round.", ref("RoundDetail")),
        "400": ERR[400],
        "401": ERR[401],
        "403": ERR[403],
        "404": ERR[404],
      },
    },
  },

  "/rounds/{id}/planner/occurrences": {
    parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
    get: {
      tags: ["Rounds"],
      summary: "Occurrence list (calendar view)",
      description: "One aggregate-stats row per calendar date with ≥1 visit. At least one of `from`/`to` is required; the range must not exceed 90 days.",
      parameters: [
        { name: "from", in: "query", required: false, schema: { type: "string", format: "date" } },
        { name: "to", in: "query", required: false, schema: { type: "string", format: "date" } },
      ],
      responses: {
        "200": jsonResponse("Occurrence summaries.", { type: "array", items: ref("OccurrenceSummary") }),
        "400": ERR[400],
        "401": ERR[401],
        "403": ERR[403],
        "404": ERR[404],
      },
    },
  },

  "/rounds/{id}/planner/occurrences/{date}": {
    get: {
      tags: ["Rounds"],
      summary: "Occurrence detail (list/map view)",
      description: "Every stop scheduled on this round for this calendar date, plus the same aggregate stats as the calendar view.",
      parameters: [
        { name: "id", in: "path", required: true, schema: { type: "string" } },
        { name: "date", in: "path", required: true, schema: { type: "string", format: "date" } },
      ],
      responses: {
        "200": jsonResponse("Occurrence detail.", ref("OccurrenceDetail")),
        "400": ERR[400],
        "401": ERR[401],
        "403": ERR[403],
        "404": ERR[404],
      },
    },
  },

  "/rounds/{id}/technicians": {
    parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
    put: {
      tags: ["Rounds"],
      summary: "Replace the round's technicians and split its properties (A1 / GAP-012)",
      description:
        "Full replace semantics — send the complete list you want to keep (empty array clears). Every id must reference an active, invite-accepted technician (400 otherwise); unknown ids 404. " +
        "`split.mode`: SINGLE (exactly one technician, 400 otherwise), AUTO (balanced by plan value), MANUAL (`allocations` of `{ propertyId, technicianId }`). Omitted = SINGLE for one technician, AUTO for more. " +
        "Future SCHEDULED visits are restamped (except manually-overridden ones). `?dryRun=true` returns the same response without saving anything. " +
        "BREAKING: the response is `{ roundId, allocation, visitsUpdated }` (was the RoundDetail). An invalid MANUAL allocation is 400 `INVALID_ALLOCATION` with a per-property `fields` map.",
      parameters: [{ name: "dryRun", in: "query", required: false, schema: { type: "string", enum: ["true", "false"] }, description: "\"true\" = compute and return, roll everything back." }],
      requestBody: jsonBody(ref("SetRoundTechniciansInput")),
      responses: {
        "200": jsonResponse("Allocation result.", ref("SetTechniciansResult")),
        "400": jsonResponse("Validation error, or code INVALID_ALLOCATION with `fields` (propertyId → reason).", {
          allOf: [ref("Error")],
          properties: { fields: { type: "object", additionalProperties: { type: "string" } } },
          example: { error: "Invalid technician allocation", code: "INVALID_ALLOCATION", fields: { prp_1: "technician is not on this round" } },
        }),
        "401": ERR[401],
        "403": ERR[403],
        "404": ERR[404],
      },
    },
  },

  "/rounds/{id}/allocation": {
    parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
    get: {
      tags: ["Rounds"],
      summary: "Current property split between the round's technicians",
      responses: {
        "200": jsonResponse("Split mode + allocation.", ref("RoundAllocation")),
        "401": ERR[401],
        "403": ERR[403],
        "404": ERR[404],
      },
    },
  },

  "/rounds/{id}/today": {
    parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
    get: {
      tags: ["Rounds"],
      summary: "Today panel for this round (Screen 13)",
      responses: {
        "200": jsonResponse("Today panel.", ref("TodayPanel")),
        "401": ERR[401],
        "403": ERR[403],
        "404": ERR[404],
      },
    },
  },

  "/rounds/{id}/reassign": {
    parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
    post: {
      tags: ["Rounds"],
      summary: "Reassign one date's visits to another technician (M15, GAP-013)",
      description:
        "Moves the round's visits on `date` (default today) from `fromTechnicianId` (null = the date's unassigned visits) to `toTechnicianId`. `scope: REMAINING` only touches SCHEDULED/IN_PROGRESS visits; `ALL` also COMPLETED/SKIPPED (lowercase still accepted). " +
        "A one-off reassign marks the visits as manual overrides; `permanent: true` also moves the properties' allocation so future visits follow. " +
        "BREAKING: the response is `{ updated }` (was `{ updatedCount }`). 409 if the operational day has already been closed.",
      requestBody: jsonBody(ref("ReassignTechnicianInput")),
      responses: {
        "200": jsonResponse("Reassignment result.", ref("ReassignResult")),
        "400": ERR[400],
        "401": ERR[401],
        "403": ERR[403],
        "404": errorResponse("Round or target technician not found.", "Target technician not found"),
        "409": errorResponse("Operational day has already been closed.", "Operational day has already been closed"),
      },
    },
  },

  "/rounds/{id}/push-missed": {
    parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
    post: {
      tags: ["Rounds"],
      summary: "Push today's missed jobs to a new date (M22)",
      description:
        "Moves every SCHEDULED visit on this round, scheduled today, to `newDate` (must be strictly after today). Optionally reassigns `technicianId` at the same time and/or SMS-notifies the affected customers (best-effort — a per-customer send failure is logged, not surfaced). 409 if the operational day has already been closed.",
      requestBody: jsonBody(ref("PushMissedVisitsInput")),
      responses: {
        "200": jsonResponse("Push-missed result.", ref("PushMissedResult")),
        "400": ERR[400],
        "401": ERR[401],
        "403": ERR[403],
        "404": ERR[404],
        "409": errorResponse("Operational day has already been closed.", "Operational day has already been closed"),
      },
    },
  },

  "/rounds/{id}/generate-visits": {
    parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
    post: {
      tags: ["Rounds"],
      summary: "Generate due visits for this round now",
      description:
        "Runs the same per-round visit-generation logic as the nightly cron job, immediately, for just this round — useful for a round created after setup that would otherwise wait for the next nightly run. The round must be ACTIVE.",
      responses: {
        "200": jsonResponse("Generation result.", ref("GenerateVisitsResult")),
        "400": errorResponse("Round must be ACTIVE to generate visits.", "Round must be ACTIVE to generate visits"),
        "401": ERR[401],
        "403": ERR[403],
        "404": ERR[404],
      },
    },
  },

  // =====================================================================
  // Technicians — directory (list/detail/create/update) with round names
  // and today's job stats. Distinct from Settings → /settings/technicians,
  // which is the invite-pending-only editor. ADMIN/MANAGER only.
  // =====================================================================
  "/technicians": {
    get: {
      tags: ["Technicians"],
      summary: "List technicians",
      description: "Each row includes the technician's round names and today's job stats (total/completed/skipped/remaining), computed up front.",
      responses: {
        "200": jsonResponse("Technician list.", { type: "array", items: ref("TechnicianListRow") }),
        "401": ERR[401],
        "403": ERR[403],
      },
    },
    post: {
      tags: ["Technicians"],
      summary: "Create a technician",
      description:
        "Creates an invite-pending technician (profileId = null) unless `sendInvite` is true, in which case an email is required and a TenantInvite is also created and emailed. 409 if a pending invite for that email already exists; 503 if the technician was created but the invite email failed to send (retry with POST /invites).",
      requestBody: jsonBody(ref("TechnicianDirectoryCreateInput")),
      responses: {
        "201": jsonResponse("Created technician.", ref("TechnicianListItem")),
        "400": ERR[400],
        "401": ERR[401],
        "403": ERR[403],
        "404": errorResponse("serviceAreaId not found.", "Service area not found"),
        "409": errorResponse("A pending invite for this email already exists, or the email already belongs to a technician.", "A pending invite for this email already exists. Use POST /invites to resend."),
        "503": errorResponse("Technician created but the invite email failed to send.", "Technician created but invite email failed. Retry with POST /invites."),
      },
    },
  },

  "/technicians/{id}": {
    parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
    get: {
      tags: ["Technicians"],
      summary: "Get technician detail",
      description: "Adds round names and a per-round breakdown of today's workload (total/completed/skipped/remaining per round).",
      responses: {
        "200": jsonResponse("Technician detail.", ref("TechnicianDetail")),
        "401": ERR[401],
        "403": ERR[403],
        "404": ERR[404],
      },
    },
    patch: {
      tags: ["Technicians"],
      summary: "Update a technician (partial)",
      requestBody: jsonBody(ref("TechnicianDirectoryUpdateInput")),
      responses: {
        "200": jsonResponse("Updated technician.", ref("TechnicianListItem")),
        "400": ERR[400],
        "401": ERR[401],
        "403": ERR[403],
        "404": ERR[404],
      },
    },
  },

  "/technicians/{id}/performance": {
    parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
    get: {
      tags: ["Technicians"],
      summary: "Technician KPIs for a period (B6 · GAP-025)",
      description: "UTC calendar ranges; `monthly`/`yearly` are aliases of thisMonth/thisYear; last30/last90 include today. timeOnJobMinutes / revenuePerHour are null when no completed visit in the period has start+complete timestamps. Strikes = STRIKE incidents + upheld complaints.",
      parameters: [
        { name: "period", in: "query", required: false, schema: { type: "string", enum: ["thisMonth", "lastMonth", "thisYear", "last30", "last90", "monthly", "yearly"], default: "thisMonth" } },
      ],
      responses: {
        "200": jsonResponse("Performance.", ref("TechnicianPerformance")),
        "400": errorResponse("Unknown period.", "period must be one of: thisMonth, lastMonth, thisYear, last30, last90, monthly, yearly"),
        "401": ERR[401],
        "403": ERR[403],
        "404": errorResponse("Technician not found.", "Technician not found"),
      },
    },
  },

  "/technicians/{id}/photos": {
    parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
    get: {
      tags: ["Technicians"],
      summary: "Photos from the technician's visits (B4 · GAP-019)",
      description: "Newest first, 1-hour signed URLs. `pageSize` default 24, max 100.",
      parameters: [
        { name: "page", in: "query", required: false, schema: { type: "integer", minimum: 1, default: 1 } },
        { name: "pageSize", in: "query", required: false, schema: { type: "integer", minimum: 1, maximum: 100, default: 24 } },
      ],
      responses: {
        "200": jsonResponse("Photo page.", ref("PhotoPage")),
        "400": ERR[400],
        "401": ERR[401],
        "403": ERR[403],
        "404": errorResponse("Technician not found.", "Technician not found"),
      },
    },
  },

  "/technicians/{id}/incidents": {
    parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
    get: {
      tags: ["Technicians"],
      summary: "List the technician's incidents (strikes, damages, upsells)",
      parameters: [
        { name: "type", in: "query", required: false, schema: ref("IncidentType") },
        { name: "from", in: "query", required: false, schema: { type: "string", format: "date" } },
        { name: "to", in: "query", required: false, schema: { type: "string", format: "date" }, description: "Inclusive; must not be before `from`." },
        { name: "page", in: "query", required: false, schema: { type: "integer", minimum: 1, default: 1 } },
        { name: "pageSize", in: "query", required: false, schema: { type: "integer", minimum: 1, maximum: 100, default: 50 } },
      ],
      responses: {
        "200": jsonResponse("Incident page, newest first.", {
          type: "object",
          required: ["rows", "pagination"],
          properties: { rows: { type: "array", items: ref("TechnicianIncident") }, pagination: ref("Pagination") },
        }),
        "400": ERR[400],
        "401": ERR[401],
        "403": ERR[403],
        "404": errorResponse("Technician not found.", "Technician not found"),
      },
    },
    post: {
      tags: ["Technicians"],
      summary: "Record an incident (STRIKE | DAMAGE | UPSELL)",
      description: "`createdById` = the acting Profile. `visitId`, when given, must exist (404).",
      requestBody: jsonBody({
        type: "object",
        required: ["type", "note"],
        properties: {
          type: ref("IncidentType"),
          note: { type: "string", minLength: 1 },
          amount: { type: "number", nullable: true, minimum: 0, maximum: 99999999, description: "Damage cost / upsell value." },
          visitId: { type: "string", nullable: true },
        },
        example: { type: "UPSELL", note: "Added conservatory roof", amount: 15, visitId: "vis_1" },
      }),
      responses: {
        "201": jsonResponse("Created incident.", ref("TechnicianIncident")),
        "400": ERR[400],
        "401": ERR[401],
        "403": ERR[403],
        "404": errorResponse("Technician or visit not found.", "Visit not found"),
      },
    },
  },

  "/technicians/{id}/availability": {
    parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
    get: {
      tags: ["Technicians"],
      summary: "List leave / unavailability windows (newest first)",
      responses: {
        "200": jsonResponse("Windows.", { type: "array", items: ref("TechnicianAvailability") }),
        "401": ERR[401],
        "403": ERR[403],
        "404": errorResponse("Technician not found.", "Technician not found"),
      },
    },
    post: {
      tags: ["Technicians"],
      summary: "Add an unavailability window",
      description: "Visit generation and restamping skip the technician for dates inside [from, to] (inclusive). Future SCHEDULED visits on the technician's rounds are restamped immediately (`visitsRestamped`).",
      requestBody: jsonBody({
        type: "object",
        required: ["from", "to"],
        properties: {
          from: { type: "string", format: "date" },
          to: { type: "string", format: "date", description: "Must not be before `from`." },
          reason: { type: "string", nullable: true },
        },
        example: { from: "2026-11-10", to: "2026-11-14", reason: "Holiday" },
      }),
      responses: {
        "201": jsonResponse("Created window.", {
          allOf: [ref("TechnicianAvailability"), { type: "object", required: ["visitsRestamped"], properties: { visitsRestamped: { type: "integer" } } }],
        }),
        "400": ERR[400],
        "401": ERR[401],
        "403": ERR[403],
        "404": errorResponse("Technician not found.", "Technician not found"),
      },
    },
  },

  "/technicians/{id}/availability/{availabilityId}": {
    parameters: [
      { name: "id", in: "path", required: true, schema: { type: "string" } },
      { name: "availabilityId", in: "path", required: true, schema: { type: "string" } },
    ],
    delete: {
      tags: ["Technicians"],
      summary: "Remove an unavailability window",
      description: "Restamps the technician's future SCHEDULED visits.",
      responses: {
        "204": { description: "Removed." },
        "401": ERR[401],
        "403": ERR[403],
        "404": errorResponse("Window not found for this technician.", "Availability not found"),
      },
    },
  },

  "/technicians/{id}/replace": {
    parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
    post: {
      tags: ["Technicians"],
      summary: "Hand the technician's SCHEDULED visits to a replacement",
      description:
        "Moves SCHEDULED visits dated [from, to] (inclusive; no `to` = open-ended) to `replacementTechnicianId` as manual overrides, and records an unavailability window for the original technician. " +
        "`notify` (default true) sends the replacement a SCHEDULE notification.",
      requestBody: jsonBody({
        type: "object",
        required: ["replacementTechnicianId", "from"],
        properties: {
          replacementTechnicianId: { type: "string" },
          from: { type: "string", format: "date" },
          to: { type: "string", format: "date", nullable: true },
          notify: { type: "boolean", default: true },
        },
      }),
      responses: {
        "200": jsonResponse("Reassigned count.", { type: "object", required: ["visitsReassigned"], properties: { visitsReassigned: { type: "integer" } } }),
        "400": errorResponse("Same technician, inactive replacement, or bad dates.", "Replacement technician is inactive"),
        "401": ERR[401],
        "403": ERR[403],
        "404": errorResponse("Technician or replacement not found.", "Replacement technician not found"),
      },
    },
  },

  "/technician-incidents/{id}": {
    parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
    delete: {
      tags: ["Technicians"],
      summary: "Delete a technician incident",
      responses: {
        "204": { description: "Deleted." },
        "401": ERR[401],
        "403": ERR[403],
        "404": errorResponse("Incident not found.", "Incident not found"),
      },
    },
  },

  // =====================================================================
  // Messages — direct GoHighLevel-backed send (single customer or bulk to
  // a round). ADMIN/MANAGER only.
  // =====================================================================
  "/messages/send": {
    post: {
      tags: ["Messages"],
      summary: "Send one message to a single customer",
      description:
        "Resolves the customer by `customerId`, or by `propertyId` (looked up to its property's customer) — one of the two is required. `channel` omitted or `AUTO` = SMS when the customer has a mobile, else EMAIL. " +
        "The OUTBOUND Message is recorded only after GHL accepts it, with GHL's message id in Message.externalId.",
      requestBody: jsonBody(ref("MessageSendInput")),
      responses: {
        "201": jsonResponse("Sent.", ref("MessageSendResult")),
        "400": errorResponse("Validation error, or no contact detail for the channel (code NO_CONTACT_FOR_CHANNEL).", "Customer has no mobile number on file"),
        "401": ERR[401],
        "403": ERR[403],
        "404": errorResponse("Property or customer not found.", "Customer not found"),
        "409": errorResponse("GoHighLevel is not connected (code GHL_NOT_CONNECTED).", "GoHighLevel is not connected"),
        "502": errorResponse("GHL rejected the message (code GHL_SEND_FAILED).", "GoHighLevel could not send the message: timeout"),
      },
    },
  },

  "/messages/bulk": {
    post: {
      tags: ["Messages"],
      summary: "Broadcast one message to every customer in a round",
      description:
        "Sends right now — no scheduling. `excludePaymentHold: true` drops any customer whose round properties all have a payment-hold visit. Best-effort: a per-recipient failure is logged and skipped; `queued` counts successes, not attempts. 409 if GoHighLevel isn't connected.",
      requestBody: jsonBody(ref("MessageBulkInput")),
      responses: {
        "201": jsonResponse("Broadcast result.", ref("MessageBulkResult")),
        "400": ERR[400],
        "401": ERR[401],
        "403": ERR[403],
        "409": errorResponse("GoHighLevel is not connected.", "GoHighLevel is not connected"),
      },
    },
  },

  // =====================================================================
  // Setup: Steps 9–12 (Steps 1–8, /setup/status and /setup/complete are
  // documented above).
  // =====================================================================
  "/setup/step/9": {
    get: {
      tags: ["Setup"],
      summary: "Step 9 — list properties added so far",
      responses: {
        "200": jsonResponse("Setup properties.", { type: "array", items: ref("SetupPropertyResult") }),
        "401": ERR[401],
      },
    },
    post: {
      tags: ["Setup"],
      summary: "Step 9 — add one property",
      description:
        "One-time setup property creation — does not reuse POST /properties. Call multiple times to add multiple properties. `roundId` is required (and must reference an ACTIVE round). " +
        "GAP-010: pass `customerId` to attach the property to an existing customer (404 if unknown); otherwise a customer with the same mobile/email is reused (`customerMatched: true`). " +
        "`lastCleanedDate` (ISO) seeds the plan's nextDueDate (one cycle after it, on the round day). Marks step 9 complete.",
      requestBody: jsonBody(ref("SetupPropertyInput")),
      responses: {
        "201": jsonResponse("Created property.", ref("SetupPropertyResult")),
        "400": ERR[400],
        "401": ERR[401],
        "403": ERR[403],
        "404": errorResponse("customerId not found.", "Customer not found: cus_123"),
      },
    },
  },

  "/setup/step/9/bulk": {
    post: {
      tags: ["Setup"],
      summary: "Step 9 — bulk import properties",
      description:
        "GAP-009: every row needs a `phone` (row error otherwise); row errors carry `error` (and the deprecated `message`). A row whose `cleaningFrequency` differs from its round's frequency is a row error unless `allowFrequencyMismatch: true`. " +
        "Accepts up to 1000 rows in `properties[]`, processed in batches of 100 (each batch its own transaction). A row that fails validation, or a batch that fails to commit, is reported in `errors[]` by its original row index — it does not abort the other, valid rows in the same request. Pass `idempotencyKey` in the body (not a header) to make a retried call safe: a repeat call with the same key short-circuits to the original result (`idempotent: true`, `results` empty) instead of re-creating the rows. Responds `201` whenever anything was created, or this was an idempotent replay; responds `400` only when every row failed and it wasn't an idempotent replay.",
      requestBody: jsonBody(ref("SetupPropertyBulkInput")),
      responses: {
        "201": jsonResponse("Import result — some or all rows created (or an idempotent replay).", ref("BulkSetupPropertyResult")),
        "400": jsonResponse("Every row failed validation or failed to commit.", ref("BulkSetupPropertyResult")),
        "401": ERR[401],
        "403": ERR[403],
      },
    },
  },

  "/setup/step/10": {
    get: {
      tags: ["Setup"],
      summary: "Step 10 — current round/technician assignment board",
      responses: {
        "200": jsonResponse("Assignment board.", ref("Step10Result")),
        "401": ERR[401],
      },
    },
    post: {
      tags: ["Setup"],
      summary: "Step 10 — assign technicians to rounds",
      description:
        "Body is a raw JSON array (not wrapped in an object) of `{ roundId, technicianIds }`. Replaces assignments for each round included in the request (idempotent); a round not included is left untouched. Every `roundId` must reference an ACTIVE round and every `technicianId` an active technician, and `roundId` must not repeat within the array.",
      requestBody: jsonBody({ type: "array", items: ref("RoundTechnicianAssignmentInput") }),
      responses: {
        "200": jsonResponse("Updated assignment board.", ref("Step10Result")),
        "400": ERR[400],
        "401": ERR[401],
        "403": ERR[403],
      },
    },
  },

  "/setup/step/11": {
    get: {
      tags: ["Setup"],
      summary: "Step 11 — activation status",
      description: "`activated` is derived from whether any SCHEDULED visit exists yet.",
      responses: {
        "200": jsonResponse("Activation status.", ref("ActivationStatus")),
        "401": ERR[401],
      },
    },
    post: {
      tags: ["Setup"],
      summary: "Step 11 — activate system & generate visits",
      description:
        "Generates the initial batch of SCHEDULED visits (A2 / GAP-016) for every ACTIVE property's first ACTIVE plan on the targeted round(s), from `startDate` through `startDate + cycleWeeks`, starting at each plan's nextDueDate and repeating on its frequency; held customers and unavailable technicians are skipped. GET /setup/step/11/preview returns the same plan without writing. `startDate` must be today or later. 409 if the system is already activated (setup already complete); 404 if `generateAll: false` and none of the given `roundIds` matched an ACTIVE round.",
      requestBody: jsonBody(ref("ActivationInput")),
      responses: {
        "200": jsonResponse("Activation result.", ref("ActivationResult")),
        "400": ERR[400],
        "401": ERR[401],
        "403": ERR[403],
        "404": errorResponse("None of the specified roundIds were found.", "None of the specified roundIds were found"),
        "409": errorResponse("System is already activated.", "System is already activated — setup is complete"),
      },
    },
  },

  "/setup/step/11/preview": {
    get: {
      tags: ["Setup"],
      summary: "Step 11 — preview the visits activation would generate",
      description: "Runs the same planner as POST /setup/step/11 over every ACTIVE round, without saving. 400 on a bad/missing `startDate` or `cycleWeeks` (integer 1–52).",
      parameters: [
        { name: "startDate", in: "query", required: true, schema: { type: "string", format: "date" } },
        { name: "cycleWeeks", in: "query", required: true, schema: { type: "integer", minimum: 1, maximum: 52 } },
      ],
      responses: {
        "200": jsonResponse("Per-round preview.", ref("ActivationPreview")),
        "400": ERR[400],
        "401": ERR[401],
        "403": ERR[403],
      },
    },
  },

  "/setup/step/12": {
    get: {
      tags: ["Setup"],
      summary: "Step 12 — review & launch checklist",
      description: "A human-readable checklist derived from the overall setup status (same underlying step data as GET /setup/status).",
      responses: {
        "200": jsonResponse("Checklist.", ref("ReviewChecklist")),
        "401": ERR[401],
      },
    },
  },

  // =====================================================================
  // Debt — collections board, invoice detail, reminders, payment links,
  // bad-debt/hold flags. ADMIN/MANAGER only.
  // =====================================================================
  "/debt/kpis": {
    get: {
      tags: ["Debt"],
      summary: "Debt KPI cards",
      responses: {
        "200": jsonResponse("Debt KPIs.", ref("DebtKpis")),
        "401": ERR[401],
        "403": ERR[403],
      },
    },
  },

  "/debt/board": {
    get: {
      tags: ["Debt"],
      summary: "Debt board — paginated invoice rows for one bucket tab",
      description:
        "`bucket` is required. The 6 named buckets are mutually exclusive by construction; anything else (including the literal `ALL`) falls into the catch-all \"everything not in the other buckets\" bucket. " +
        "`ON_HOLD` is customer-based (every held customer, one row each, even without a SENT invoice) so it matches GET /debt/board/counts.",
      parameters: [
        { name: "bucket", in: "query", required: true, schema: { type: "string", enum: ["BAD_DEBT", "ON_HOLD", "FAILED_GC", "DUE_BEFORE_CLEAN", "SEVEN_DAYS_OVER", "FOURTEEN_DAYS_OVER", "ALL"] } },
        { name: "roundId", in: "query", required: false, schema: { type: "string" } },
        { name: "paymentMethod", in: "query", required: false, schema: ref("PaymentMethod") },
        { name: "search", in: "query", required: false, schema: { type: "string" }, description: "Case-insensitive search on customer name or property address." },
        { name: "page", in: "query", required: false, schema: { type: "integer", minimum: 1, default: 1 } },
        { name: "pageSize", in: "query", required: false, schema: { type: "integer", minimum: 1, maximum: 100, default: 50 } },
      ],
      responses: {
        "200": jsonResponse("Paginated debt board rows.", ref("DebtBoardResult")),
        "400": errorResponse("bucket query param is required.", "bucket query param is required"),
        "401": ERR[401],
        "403": ERR[403],
      },
    },
  },

  "/debt/board/counts": {
    get: {
      tags: ["Debt"],
      summary: "All 7 bucket-tab counts in one call",
      description: "Replaces the previous frontend pattern of one GET /debt/board?pageSize=1 request per tab.",
      parameters: [
        { name: "roundId", in: "query", required: false, schema: { type: "string" } },
        { name: "paymentMethod", in: "query", required: false, schema: ref("PaymentMethod") },
        { name: "search", in: "query", required: false, schema: { type: "string" } },
      ],
      responses: {
        "200": jsonResponse("Bucket counts.", ref("DebtBucketCounts")),
        "401": ERR[401],
        "403": ERR[403],
      },
    },
  },

  "/debt/{id}": {
    parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" }, description: "Invoice id." }],
    get: {
      tags: ["Debt"],
      summary: "Invoice detail for the debt detail panel",
      description: "Fields the board row doesn't carry: phone/email, round, next scheduled visit, GoCardless mandate, and the 5 most recent visits.",
      responses: {
        "200": jsonResponse("Invoice detail.", ref("DebtInvoiceDetail")),
        "401": ERR[401],
        "403": ERR[403],
        "404": ERR[404],
      },
    },
  },

  "/debt/{id}/remind": {
    parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" }, description: "Invoice id." }],
    post: {
      tags: ["Debt"],
      summary: "Send a payment reminder via GHL (A5)",
      description:
        "Delivers the reminder through GoHighLevel and records an OUTBOUND Message, then queues a GHL `debt.overdue` event. Body: the tenant's \"Payment Overdue Reminder\" template (fallback if missing), or `message` when given. " +
        "`channel` omitted/AUTO = SMS when the customer has a mobile, else EMAIL.",
      requestBody: jsonBody(ref("DebtRemindInput"), false),
      responses: {
        "200": jsonResponse("Reminder sent.", ref("ReminderResult")),
        "400": errorResponse("Bad channel, or no contact detail for it (code NO_CONTACT_FOR_CHANNEL).", "Customer has no mobile number on file"),
        "401": ERR[401],
        "403": ERR[403],
        "404": ERR[404],
        "409": errorResponse("GHL is not connected (code GHL_NOT_CONNECTED).", "GoHighLevel is not connected"),
        "502": errorResponse("GHL rejected the message (code GHL_SEND_FAILED).", "GoHighLevel could not send the message: timeout"),
      },
    },
  },

  "/debt/{id}/payment-link": {
    parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" }, description: "Invoice id." }],
    post: {
      tags: ["Debt"],
      summary: "Send a Stripe payment link via GHL (A5)",
      description:
        "Gets a Stripe Checkout link for the invoice (reusing an existing PENDING session) and delivers it through GoHighLevel, recording an OUTBOUND Message. Body: the \"Payment Link\" template or `message`; the URL is appended if the text doesn't contain it. " +
        "The static pay.roundflow.app fallback is gone — Stripe must be connected. `channel` omitted/AUTO = SMS when the customer has a mobile, else EMAIL.",
      requestBody: jsonBody(ref("DebtPaymentLinkInput"), false),
      responses: {
        "200": jsonResponse("Payment link sent.", ref("PaymentLinkResult")),
        "400": errorResponse("Bad channel, or no contact detail for it (code NO_CONTACT_FOR_CHANNEL).", "Customer has no email address on file"),
        "401": ERR[401],
        "403": ERR[403],
        "404": ERR[404],
        "409": errorResponse("STRIPE_NOT_CONNECTED, GHL_NOT_CONNECTED, or INVOICE_NOT_PAYABLE (PAID/VOID).", "Stripe is not connected. Connect Stripe in Settings › Payments to send payment links."),
        "502": errorResponse("GHL rejected the message (code GHL_SEND_FAILED).", "GoHighLevel could not send the message: timeout"),
      },
    },
  },

  "/debt/{id}/bad-debt": {
    parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" }, description: "Invoice id." }],
    patch: {
      tags: ["Debt"],
      summary: "Flag/unflag the customer as bad debt",
      requestBody: jsonBody(ref("DebtBadDebtInput")),
      responses: {
        "200": jsonResponse("Updated flag.", ref("BadDebtFlagResult")),
        "400": errorResponse("flag (boolean) is required.", "flag (boolean) is required"),
        "401": ERR[401],
        "403": ERR[403],
        "404": ERR[404],
      },
    },
  },

  "/debt/{id}/hold": {
    parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" }, description: "Invoice id." }],
    patch: {
      tags: ["Debt"],
      summary: "Put/release the customer's next-clean hold",
      description: "`reason`/`date`/`notify`/`message` are only meaningful when `flag` is true. Holding marks the customer's upcoming SCHEDULED visits `paymentHold`; releasing clears them (`visitsUpdated`). `notify: true` sends an SMS (best-effort — a send failure is logged, not surfaced as an error).",
      requestBody: jsonBody(ref("DebtHoldInput")),
      responses: {
        "200": jsonResponse("Updated hold state.", ref("HoldFlagResult")),
        "400": ERR[400],
        "401": ERR[401],
        "403": ERR[403],
        "404": ERR[404],
      },
    },
  },

  // =====================================================================
  // Reports — activity log, visit/technician/revenue reports, CSV export.
  // ADMIN/MANAGER only.
  // =====================================================================
  "/reports/activity": {
    get: {
      tags: ["Reports"],
      summary: "Activity log — paginated",
      description: "Optional `type` filter and `from`/`to` date-range filter (both YYYY-MM-DD, inclusive). `actorName` is resolved from the control-plane Profile matching each log row's actorId.",
      parameters: [
        { name: "type", in: "query", required: false, schema: { type: "string" }, example: "ROUND_UPDATED" },
        { name: "from", in: "query", required: false, schema: { type: "string", format: "date" } },
        { name: "to", in: "query", required: false, schema: { type: "string", format: "date" } },
        { name: "page", in: "query", required: false, schema: { type: "integer", minimum: 1, default: 1 } },
        { name: "pageSize", in: "query", required: false, schema: { type: "integer", minimum: 1, maximum: 100, default: 50 } },
      ],
      responses: {
        "200": jsonResponse("Paginated activity log.", ref("ReportsActivityResult")),
        "401": ERR[401],
        "403": ERR[403],
      },
    },
  },

  "/reports/visits": {
    get: {
      tags: ["Reports"],
      summary: "Visit report — paginated",
      parameters: [
        { name: "period", in: "query", required: false, schema: { type: "string", enum: ["today", "last7", "last30", "last90", "thisMonth", "lastMonth", "thisYear"], default: "last30" }, description: "Unknown values fall back to last30. CANCELLED visits are excluded unless filtered for explicitly." },
        { name: "status", in: "query", required: false, schema: ref("VisitStatus") },
        { name: "page", in: "query", required: false, schema: { type: "integer", minimum: 1, default: 1 } },
        { name: "pageSize", in: "query", required: false, schema: { type: "integer", minimum: 1, maximum: 100, default: 50 } },
      ],
      responses: {
        "200": jsonResponse("Paginated visit rows.", ref("ReportsVisitsResult")),
        "401": ERR[401],
        "403": ERR[403],
      },
    },
  },

  "/reports/technicians": {
    get: {
      tags: ["Reports"],
      summary: "Technician performance report — paginated",
      parameters: [
        { name: "period", in: "query", required: false, schema: { type: "string", enum: ["today", "last7", "last30", "last90", "thisMonth", "lastMonth", "thisYear"], default: "last30" }, description: "Unknown values fall back to last30. CANCELLED visits are excluded unless filtered for explicitly." },
        { name: "page", in: "query", required: false, schema: { type: "integer", minimum: 1, default: 1 } },
        { name: "pageSize", in: "query", required: false, schema: { type: "integer", minimum: 1, maximum: 100, default: 50 } },
      ],
      responses: {
        "200": jsonResponse("Paginated technician rows.", ref("ReportsTechniciansResult")),
        "401": ERR[401],
        "403": ERR[403],
      },
    },
  },

  "/reports/revenue": {
    get: {
      tags: ["Reports"],
      summary: "Daily revenue series",
      description: "Not paginated — one row per day with ≥1 completed visit in the period.",
      parameters: [
        { name: "period", in: "query", required: false, schema: { type: "string", enum: ["today", "last7", "last30", "last90", "thisMonth", "lastMonth", "thisYear"], default: "last30" }, description: "Unknown values fall back to last30. CANCELLED visits are excluded unless filtered for explicitly." },
      ],
      responses: {
        "200": jsonResponse("Revenue rows.", { type: "array", items: ref("ReportsRevenueRow") }),
        "401": ERR[401],
        "403": ERR[403],
      },
    },
  },

  "/reports/summary": {
    get: {
      tags: ["Reports"],
      summary: "Summary totals for the period",
      parameters: [
        { name: "period", in: "query", required: false, schema: { type: "string", enum: ["today", "last7", "last30", "last90", "thisMonth", "lastMonth", "thisYear"], default: "last30" }, description: "Unknown values fall back to last30. CANCELLED visits are excluded unless filtered for explicitly." },
      ],
      responses: {
        "200": jsonResponse("Summary totals.", ref("ReportsSummary")),
        "401": ERR[401],
        "403": ERR[403],
      },
    },
  },

  "/reports/export": {
    get: {
      tags: ["Reports"],
      summary: "CSV export",
      description:
        "Unlike /reports/visits and /reports/technicians, this always exports the FULL (unpaginated) result set for the period — every row, not just the UI's current page — as `text/csv`. `type=revenue` exports the same rows as GET /reports/revenue.",
      parameters: [
        { name: "type", in: "query", required: false, schema: { type: "string", enum: ["visits", "technicians", "revenue"], default: "visits" } },
        { name: "period", in: "query", required: false, schema: { type: "string", enum: ["today", "last7", "last30", "last90", "thisMonth", "lastMonth", "thisYear"], default: "last30" }, description: "Unknown values fall back to last30. CANCELLED visits are excluded unless filtered for explicitly." },
        { name: "status", in: "query", required: false, schema: ref("VisitStatus"), description: "Only applies when type=visits." },
      ],
      responses: {
        "200": {
          description: "CSV file. `Content-Disposition: attachment; filename=\"{type}-{period}.csv\"`.",
          content: { "text/csv": { schema: { type: "string" } } },
        },
        "401": ERR[401],
        "403": ERR[403],
      },
    },
  },

  // =====================================================================
  // Today — Today's Work aggregate (Screen 12) and Close Operational Day
  // (M21). ADMIN/MANAGER only.
  // =====================================================================
  "/today": {
    get: {
      tags: ["Today"],
      summary: "Today's Work aggregate (Screen 12)",
      description: "KPI tiles, per-round rows, and per-technician workload cards for today.",
      responses: {
        "200": jsonResponse("Today's Work.", ref("TodaysWorkAggregate")),
        "401": ERR[401],
        "403": ERR[403],
      },
    },
  },

  "/today/close": {
    post: {
      tags: ["Today"],
      summary: "Close Operational Day (M21)",
      description:
        "`unfinishedAction: \"push_to_tomorrow\"` moves every still-SCHEDULED/IN_PROGRESS visit to the next working day (Mon–Fri, skipping weekends) and resets IN_PROGRESS back to SCHEDULED; `\"mark_as_skipped\"` marks them SKIPPED in place. 409 if the day is already closed, or if BusinessSettings hasn't been configured yet.",
      requestBody: jsonBody(ref("CloseDayInput")),
      responses: {
        "200": jsonResponse("Close-of-day summary.", ref("CloseDaySummary")),
        "400": ERR[400],
        "401": ERR[401],
        "403": ERR[403],
        "409": errorResponse("Operational day has already been closed, or settings aren't configured.", "Operational day has already been closed"),
      },
    },
  },

  // =====================================================================
  // Invoices — preview (unsaved), detail, PDF render, create, send.
  // ADMIN/MANAGER only.
  // =====================================================================
  "/invoices/preview": {
    get: {
      tags: ["Invoices"],
      summary: "Preview an invoice for a visit (not saved)",
      description: "Computed live from the visit — nothing is persisted. 409 `ALREADY_INVOICED` if the visit already has an invoice, 409 `VISIT_NOT_COMPLETED` if the visit isn't COMPLETED.",
      parameters: [{ name: "visitId", in: "query", required: true, schema: { type: "string" } }],
      responses: {
        "200": jsonResponse("Invoice preview.", ref("InvoicePreview")),
        "400": errorResponse("visitId query param is required.", "visitId query param is required"),
        "401": ERR[401],
        "403": ERR[403],
        "404": ERR[404],
        "409": errorResponse("ALREADY_INVOICED or VISIT_NOT_COMPLETED.", "Only completed visits can be invoiced"),
      },
    },
  },

  "/invoices/preview/pdf": {
    get: {
      tags: ["Invoices"],
      summary: "Preview an invoice for a visit, as a PDF",
      description: "Same data as GET /invoices/preview, rendered to PDF with `status: \"PREVIEW\"`. Registered ahead of /invoices/{id}/pdf so \"preview\" is never captured as an invoice id.",
      parameters: [{ name: "visitId", in: "query", required: true, schema: { type: "string" } }],
      responses: {
        "200": { description: "Inline PDF.", content: { "application/pdf": { schema: { type: "string", format: "binary" } } } },
        "400": errorResponse("visitId query param is required.", "visitId query param is required"),
        "401": ERR[401],
        "403": ERR[403],
        "404": ERR[404],
        "409": errorResponse("ALREADY_INVOICED or VISIT_NOT_COMPLETED.", "Only completed visits can be invoiced"),
      },
    },
  },

  "/invoices/{id}": {
    parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
    get: {
      tags: ["Invoices"],
      summary: "Get invoice detail (JSON)",
      description:
        "Line items, technician, visit date, and a VAT/subtotal breakdown. Unlike GET /invoices/{id}/pdf, this degrades gracefully (nulls/empty lineItems) for a standalone invoice with no linked visit instead of 409ing.",
      responses: {
        "200": jsonResponse("Invoice detail.", ref("InvoiceDetail")),
        "401": ERR[401],
        "403": ERR[403],
        "404": ERR[404],
      },
    },
  },

  "/invoices/{id}/pdf": {
    parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
    get: {
      tags: ["Invoices"],
      summary: "Rendered invoice PDF (download/print)",
      description: "409 if the invoice has no linked visit — there's nothing to render (use GET /invoices/{id} for a visit-less invoice's plain JSON detail instead).",
      responses: {
        "200": { description: "Inline PDF.", content: { "application/pdf": { schema: { type: "string", format: "binary" } } } },
        "401": ERR[401],
        "403": ERR[403],
        "404": ERR[404],
        "409": errorResponse("Invoice has no linked visit to render.", "Invoice has no linked visit to render"),
      },
    },
  },

  "/invoices": {
    get: {
      tags: ["Invoices"],
      summary: "List invoices (GAP-028) — paginated, newest first",
      description: "Filters: `status`, `from`/`to` (issue date, YYYY-MM-DD, `to` inclusive), `customerId`, `q` (invoice number or customer name, contains). `paymentMethod` = the visit payment's method, else the visit's, else the customer's.",
      parameters: [
        { name: "status", in: "query", required: false, schema: ref("InvoiceStatus") },
        { name: "from", in: "query", required: false, schema: { type: "string", format: "date" } },
        { name: "to", in: "query", required: false, schema: { type: "string", format: "date" } },
        { name: "customerId", in: "query", required: false, schema: { type: "string" } },
        { name: "q", in: "query", required: false, schema: { type: "string" } },
        { name: "page", in: "query", required: false, schema: { type: "integer", minimum: 1, default: 1 } },
        { name: "pageSize", in: "query", required: false, schema: { type: "integer", minimum: 1, maximum: 100, default: 50 } },
      ],
      responses: {
        "200": jsonResponse("Invoice page.", {
          type: "object",
          required: ["rows", "pagination"],
          properties: { rows: { type: "array", items: ref("InvoiceListRow") }, pagination: ref("Pagination") },
        }),
        "400": ERR[400],
        "401": ERR[401],
        "403": ERR[403],
      },
    },
    post: {
      tags: ["Invoices"],
      summary: "Create (save) an invoice for a visit",
      description: "409 `ALREADY_INVOICED` if the visit already has an invoice; 409 `VISIT_NOT_COMPLETED` unless the visit is COMPLETED. The due date defaults to today + BusinessSettings.invoiceDueDays.",
      requestBody: jsonBody(ref("InvoiceCreateInput")),
      responses: {
        "201": jsonResponse("Created invoice.", ref("InvoiceActionResult")),
        "400": errorResponse("visitId is required.", "visitId is required"),
        "401": ERR[401],
        "403": ERR[403],
        "404": ERR[404],
        "409": errorResponse("ALREADY_INVOICED or VISIT_NOT_COMPLETED.", "Visit already has an invoice"),
      },
    },
  },

  "/invoices/export.csv": {
    get: {
      tags: ["Invoices"],
      summary: "Export invoices as CSV",
      description: "Same filters as GET /invoices, every matching row. Columns: invoiceNumber, customerId, customerName, total, status, issuedAt, dueDate, paidAt, paymentMethod.",
      parameters: [
        { name: "status", in: "query", required: false, schema: ref("InvoiceStatus") },
        { name: "from", in: "query", required: false, schema: { type: "string", format: "date" } },
        { name: "to", in: "query", required: false, schema: { type: "string", format: "date" } },
        { name: "customerId", in: "query", required: false, schema: { type: "string" } },
        { name: "q", in: "query", required: false, schema: { type: "string" } },
      ],
      responses: {
        "200": { description: "CSV attachment (invoices.csv).", content: { "text/csv": { schema: { type: "string" } } } },
        "400": ERR[400],
        "401": ERR[401],
        "403": ERR[403],
      },
    },
  },

  "/invoices/bulk/preview": {
    post: {
      tags: ["Invoices"],
      summary: "Preview \"create invoices for a day\" (B5)",
      description: "Lists the date's non-cancelled visits that would be invoiced (`items`) and those skipped (`skipped`, reason ALREADY_INVOICED | NOT_COMPLETED | ON_HOLD). Nothing is saved.",
      requestBody: jsonBody(ref("InvoiceBulkInput")),
      responses: {
        "200": jsonResponse("Preview.", ref("InvoiceBulkPreview")),
        "400": errorResponse("`date` missing/invalid.", '"date" is required (YYYY-MM-DD)'),
        "401": ERR[401],
        "403": ERR[403],
      },
    },
  },

  "/invoices/bulk": {
    post: {
      tags: ["Invoices"],
      summary: "Create invoices for a day (B5)",
      description:
        "Creates an invoice per previewed item; one failure doesn't roll back the rest (`failed[]`). `sendNow: true` sends each through POST /invoices/{id}/send logic (`channel`, default AUTO); " +
        "an invoice that was created but not sent has `sent: false` and also appears in `failed` with its `invoiceId`.",
      requestBody: jsonBody({
        allOf: [
          ref("InvoiceBulkInput"),
          {
            type: "object",
            properties: {
              sendNow: { type: "boolean", default: false },
              channel: { type: "string", enum: ["AUTO", "SMS", "EMAIL", "WHATSAPP"], description: "Omitted/AUTO = SMS when the customer has a mobile, else EMAIL." },
            },
          },
        ],
      }),
      responses: {
        "200": jsonResponse("Created / failed.", ref("InvoiceBulkResult")),
        "400": ERR[400],
        "401": ERR[401],
        "403": ERR[403],
      },
    },
  },

  "/invoices/{id}/send": {
    parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
    post: {
      tags: ["Invoices"],
      summary: "Send an invoice to the customer via GHL (A5)",
      description:
        "Renders the tenant's \"Invoice Ready\" template (built-in fallback if missing) and delivers it through GoHighLevel on `channel` (omitted/AUTO = SMS when the customer has a mobile, else EMAIL), recording an OUTBOUND Message. " +
        "Only once GHL accepts does the invoice flip to SENT (`sentToCustomer = true`, `sentAt = now`). An already-SENT invoice needs `resend: true`.",
      requestBody: jsonBody({
        type: "object",
        properties: {
          channel: { type: "string", enum: ["AUTO", "SMS", "EMAIL", "WHATSAPP"], description: "Case-insensitive." },
          resend: { type: "boolean", default: false },
        },
      }, false),
      responses: {
        "200": jsonResponse("Sent.", ref("InvoiceSendResult")),
        "400": errorResponse("Bad channel, or no contact detail for it (code NO_CONTACT_FOR_CHANNEL).", "Customer has no mobile number on file"),
        "401": ERR[401],
        "403": ERR[403],
        "404": ERR[404],
        "409": errorResponse("INVOICE_ALREADY_SENT (send again with resend: true), INVOICE_NOT_SENDABLE (PAID/VOID), or GHL_NOT_CONNECTED.", "Invoice has already been sent"),
        "502": errorResponse("GHL rejected the message (code GHL_SEND_FAILED); the invoice stays unsent.", "GoHighLevel could not send the message: timeout"),
      },
    },
  },

  "/invoices/{id}/mark-paid": {
    parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
    post: {
      tags: ["Invoices"],
      summary: "Record a manual (BACS / cheque / cash) payment (A7)",
      description:
        "Creates or updates the visit's Payment (PAID, `paidAt`, `reference` stored on Payment.reference), marks the invoice PAID, logs INVOICE_MARKED_PAID, queues payment.collected, then auto-releases the customer's payment hold if nothing else is outstanding. " +
        "Part payments are not supported: a given `amount` must equal the invoice total.",
      requestBody: jsonBody({
        type: "object",
        required: ["method"],
        properties: {
          method: { type: "string", enum: ["BACS", "CHEQUE", "CASH"] },
          reference: { type: "string", nullable: true, maxLength: 100, description: "Cheque number / bank reference." },
          paidAt: { type: "string", format: "date", nullable: true, description: "Default now." },
          amount: { type: "number", description: "Optional check — must equal the invoice total (400 AMOUNT_MISMATCH)." },
        },
        example: { method: "CHEQUE", reference: "000123" },
      }),
      responses: {
        "200": jsonResponse("Paid invoice + payment.", ref("MarkPaidResult")),
        "400": errorResponse("Bad method/date, or AMOUNT_MISMATCH.", "Amount 30.00 does not match the invoice total 36.00 (part payments are not supported)"),
        "401": ERR[401],
        "403": ERR[403],
        "404": ERR[404],
        "409": errorResponse("INVOICE_ALREADY_PAID or INVOICE_VOID.", "Invoice is already paid"),
      },
    },
  },

  // =====================================================================
  // Payments — Stripe Checkout session creation (one-time payment, and
  // card-on-file setup). ADMIN/MANAGER only.
  // =====================================================================
  "/payments": {
    get: {
      tags: ["Payments"],
      summary: "List payments — paginated, newest first",
      description: "Filters: `status`, `method`, `from`/`to` (created date, YYYY-MM-DD, `to` inclusive).",
      parameters: [
        { name: "status", in: "query", required: false, schema: ref("PaymentStatus") },
        { name: "method", in: "query", required: false, schema: ref("PaymentMethod") },
        { name: "from", in: "query", required: false, schema: { type: "string", format: "date" } },
        { name: "to", in: "query", required: false, schema: { type: "string", format: "date" } },
        { name: "page", in: "query", required: false, schema: { type: "integer", minimum: 1, default: 1 } },
        { name: "pageSize", in: "query", required: false, schema: { type: "integer", minimum: 1, maximum: 100, default: 50 } },
      ],
      responses: {
        "200": jsonResponse("Payment page.", {
          type: "object",
          required: ["rows", "pagination"],
          properties: { rows: { type: "array", items: ref("PaymentListRow") }, pagination: ref("Pagination") },
        }),
        "400": ERR[400],
        "401": ERR[401],
        "403": ERR[403],
      },
    },
  },

  "/payments/export.csv": {
    get: {
      tags: ["Payments"],
      summary: "Export payments as CSV",
      description: "Same filters as GET /payments. Columns: id, customerId, customerName, amount, method, status, paidAt, createdAt, visitDate, invoiceNumber.",
      parameters: [
        { name: "status", in: "query", required: false, schema: ref("PaymentStatus") },
        { name: "method", in: "query", required: false, schema: ref("PaymentMethod") },
        { name: "from", in: "query", required: false, schema: { type: "string", format: "date" } },
        { name: "to", in: "query", required: false, schema: { type: "string", format: "date" } },
      ],
      responses: {
        "200": { description: "CSV attachment (payments.csv).", content: { "text/csv": { schema: { type: "string" } } } },
        "400": ERR[400],
        "401": ERR[401],
        "403": ERR[403],
      },
    },
  },

  "/payments/stripe/checkout": {
    post: {
      tags: ["Payments"],
      summary: "Create a one-time Stripe Checkout session for an invoice",
      description:
        "Returns the existing PENDING session's URL (200) instead of creating a duplicate if one already exists for this invoice; otherwise creates a new one (201). 400 if Stripe isn't connected. 409 if the invoice is already PAID or VOID.",
      requestBody: jsonBody(ref("StripeCheckoutInput")),
      responses: {
        "201": jsonResponse("New checkout session.", ref("StripeSessionResult")),
        "400": errorResponse("Stripe is not connected.", "Stripe is not connected. Go to Settings → Payment to connect."),
        "401": ERR[401],
        "403": ERR[403],
        "404": ERR[404],
        "409": errorResponse("Invoice is already paid or void.", "Invoice is already paid"),
      },
    },
  },

  "/payments/{id}/status": {
    parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" }, description: "Payment id." }],
    patch: {
      tags: ["Payments"],
      summary: "Manually reconcile a BACS/cheque payment",
      description:
        "For methods with no settlement webhook. Only BACS and CHEQUE payments (409 otherwise — GoCardless/Stripe stay webhook-driven); 409 if already PAID. " +
        "PAID stamps `paidAt` and marks the visit's invoice PAID; both outcomes queue a GHL payment.collected / payment.failed event.",
      requestBody: jsonBody(ref("PaymentStatusInput")),
      responses: {
        "200": jsonResponse("Updated payment.", ref("Payment")),
        "400": errorResponse("status must be PAID or FAILED.", "status must be PAID or FAILED"),
        "401": ERR[401],
        "403": ERR[403],
        "404": ERR[404],
        "409": errorResponse("Not a BACS/cheque payment, or already paid.", "Only BACS and cheque payments can be manually reconciled"),
      },
    },
  },

  "/payments/stripe/setup": {
    post: {
      tags: ["Payments"],
      summary: "Create a Stripe Checkout session to save a card",
      description: "'setup' mode — no charge is made; saves a payment method for future automatic charges. 400 if Stripe isn't connected.",
      requestBody: jsonBody(ref("StripeSetupInput")),
      responses: {
        "201": jsonResponse("New setup session.", ref("StripeSessionResult")),
        "400": errorResponse("Stripe is not connected.", "Stripe is not connected. Go to Settings → Payment to connect."),
        "401": ERR[401],
        "403": ERR[403],
        "404": ERR[404],
      },
    },
  },

  // =====================================================================
  // Service Plans — per-plan price/method/frequency edits, pause/resume.
  // Targets one ServicePlan directly by id (a property with 2+ plans can
  // have each edited independently). ADMIN/MANAGER only.
  // =====================================================================
  "/service-plans/{id}": {
    parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
    patch: {
      tags: ["Service Plans"],
      summary: "Update a service plan (partial)",
      description:
        "Price, clean method, payment method, cleaning frequency. BREAKING: the response is `{ servicePlan, movedToRound }`. A frequency that differs from the round's moves the property to a matching ACTIVE round (B3); " +
        "with none, 409 `NO_MATCHING_ROUND` carrying `suggestions` (rounds in the area) and `proposedName`, unless `createRoundIfMissing: true` creates `proposedName` (\"<Area> <Day> <N>wk\").",
      requestBody: jsonBody(ref("ServicePlanUpdateInput")),
      responses: {
        "200": jsonResponse("Updated plan + move outcome.", ref("PlanUpdateResult")),
        "400": ERR[400],
        "401": ERR[401],
        "403": ERR[403],
        "404": ERR[404],
        "409": jsonResponse("No ACTIVE round matches the new frequency (code NO_MATCHING_ROUND).", ref("NoMatchingRoundError")),
      },
    },
  },

  "/service-plans/{id}/pause": {
    parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
    post: {
      tags: ["Service Plans"],
      summary: "Pause a service plan",
      description: "Mirrors POST /properties/{id}/pause (cancels SCHEDULED visits in the window with cancelReason PAUSED; a future start is stored as a scheduled pause). `reason` is required by the UI but not persisted (no column).",
      requestBody: jsonBody(ref("PauseServiceInput")),
      responses: {
        "200": jsonResponse("Paused service plan + outcome.", ref("PauseResult")),
        "400": ERR[400],
        "401": ERR[401],
        "403": ERR[403],
        "404": ERR[404],
        "409": errorResponse("Service plan is already paused.", "Service plan is already paused"),
      },
    },
  },

  "/service-plans/{id}/resume": {
    parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
    post: {
      tags: ["Service Plans"],
      summary: "Resume a paused service plan",
      description: "Mirrors POST /properties/{id}/resume (nextDueDate = the round's next defaultDay; also cancels a scheduled pause).",
      responses: {
        "200": jsonResponse("Resumed service plan.", ref("ServicePlan")),
        "401": ERR[401],
        "403": ERR[403],
        "404": ERR[404],
        "409": errorResponse("Service plan is neither paused nor has a scheduled pause.", "Service plan is not paused"),
      },
    },
  },

  // =====================================================================
  // Mobile — technician app (mounted at /mobile). Router guard (D-3):
  // requireAuth + requireTenantAccess + requireTechnician — only TECHNICIAN
  // profiles with a linked Technician row get through (403 TECHNICIAN_ONLY /
  // NO_TECHNICIAN). /mobile/visits/{id}/* requires the visit to be assigned
  // to the caller (403 NOT_YOUR_VISIT); chat requires round membership
  // (403 NOT_YOUR_ROUND). Visit writes accept X-Idempotency-Key (see
  // MOBILE_VISIT_WRITES below). "Today" is UTC midnight–midnight.
  // =====================================================================
  "/mobile/me": {
    get: {
      tags: ["Mobile"],
      summary: "Signed-in technician's profile",
      responses: {
        "200": jsonResponse("Profile summary.", ref("MobileMe")),
        "401": ERR[401],
        "403": MOBILE_ERR_403,
      },
    },
    patch: {
      tags: ["Mobile"],
      summary: "Update name / date of birth / avatar",
      requestBody: jsonBody(ref("MobileMeUpdateInput")),
      responses: {
        "200": jsonResponse("Updated profile summary.", ref("MobileMe")),
        "400": ERR[400],
        "401": ERR[401],
        "403": MOBILE_ERR_403,
      },
    },
  },
  "/mobile/me/avatar/upload-url": {
    post: {
      tags: ["Mobile"],
      summary: "Signed URL to upload a profile photo",
      description: "Upload the bytes to `signedUrl`, then save the returned `path` via PATCH /mobile/me `avatarUrl`. Display it via GET /mobile/me `avatarSignedUrl` (the bucket is private).",
      requestBody: jsonBody(ref("MobileUploadUrlInput"), false),
      responses: {
        "200": jsonResponse("Signed upload URL.", ref("SignedUploadUrl")),
        "400": ERR[400],
        "401": ERR[401],
        "403": MOBILE_ERR_403,
      },
    },
  },
  "/mobile/messages/attachments/upload-url": {
    post: {
      tags: ["Mobile"],
      summary: "Signed URL to upload a chat image",
      description: "Use the uploaded URL(s) in POST /mobile/chat/messages with `type: PHOTOS`. The round id is not validated.",
      requestBody: jsonBody(ref("MobileChatAttachmentUploadInput")),
      responses: {
        "200": jsonResponse("Signed upload URL.", ref("SignedUploadUrl")),
        "400": ERR[400],
        "401": ERR[401],
        "403": MOBILE_ERR_403,
      },
    },
  },
  "/mobile/notifications": {
    get: {
      tags: ["Mobile"],
      summary: "Caller's notifications (cursor-paginated, newest first)",
      parameters: [
        { name: "cursor", in: "query", required: false, schema: { type: "string" }, description: "`nextCursor` from the previous page." },
      ],
      responses: {
        "200": jsonResponse("A page of notifications.", ref("MobileNotificationPage")),
        "401": ERR[401],
        "403": MOBILE_ERR_403,
      },
    },
  },
  "/mobile/notifications/{id}/read": {
    parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
    patch: {
      tags: ["Mobile"],
      summary: "Mark one notification read",
      description: "Scoped to the caller's own notifications; an unknown id is a silent no-op (still 200).",
      responses: {
        "200": jsonResponse("Done.", { type: "object", required: ["read"], properties: { read: { type: "boolean", enum: [true] } } }),
        "401": ERR[401],
        "403": MOBILE_ERR_403,
      },
    },
  },
  "/mobile/notifications/read-all": {
    post: {
      tags: ["Mobile"],
      summary: "Mark all of the caller's notifications read",
      responses: {
        "200": jsonResponse("Done.", { type: "object", required: ["read"], properties: { read: { type: "boolean", enum: [true] } } }),
        "401": ERR[401],
        "403": MOBILE_ERR_403,
      },
    },
  },
  "/mobile/devices": {
    post: {
      tags: ["Mobile"],
      summary: "Register a push token",
      description: "Upsert by `pushToken` — re-registering moves the token to the caller.",
      requestBody: jsonBody(ref("MobileDeviceInput")),
      responses: {
        "201": jsonResponse("Registered.", { type: "object", required: ["registered"], properties: { registered: { type: "boolean", enum: [true] } } }),
        "400": ERR[400],
        "401": ERR[401],
        "403": MOBILE_ERR_403,
      },
    },
  },
  "/mobile/devices/{token}": {
    parameters: [{ name: "token", in: "path", required: true, schema: { type: "string" }, description: "The push token to remove." }],
    delete: {
      tags: ["Mobile"],
      summary: "Deregister a push token (sign-out)",
      description: "Only removes the token if it belongs to the caller; unknown tokens are a no-op (still 200).",
      responses: {
        "200": jsonResponse("Done.", { type: "object", required: ["unregistered"], properties: { unregistered: { type: "boolean", enum: [true] } } }),
        "401": ERR[401],
        "403": MOBILE_ERR_403,
      },
    },
  },
  "/mobile/company": {
    get: {
      tags: ["Mobile"],
      summary: "Company contact details + policy links (Help & Support)",
      responses: {
        "200": jsonResponse("Company info (all fields null if not configured).", ref("MobileCompany")),
        "401": ERR[401],
        "403": MOBILE_ERR_403,
      },
    },
  },
  "/mobile/support/reports": {
    post: {
      tags: ["Mobile"],
      summary: "Report a problem",
      requestBody: jsonBody(ref("MobileSupportReportInput")),
      responses: {
        "201": jsonResponse("Report stored.", ref("SupportReportResult")),
        "400": ERR[400],
        "401": ERR[401],
        "403": MOBILE_ERR_403,
      },
    },
  },
  "/mobile/rounds/today": {
    get: {
      tags: ["Mobile"],
      summary: "Today's rounds for the caller (home screen)",
      description: "One row per round that has visits assigned to the caller today. `[]` if the caller has no Technician row.",
      responses: {
        "200": jsonResponse("Round summaries.", { type: "array", items: ref("MobileRoundSummary") }),
        "401": ERR[401],
        "403": MOBILE_ERR_403,
      },
    },
  },
  "/mobile/visits/today": {
    get: {
      tags: ["Mobile"],
      summary: "Today's visits assigned to the caller",
      description: "Ordered by date then createdAt. Rows carry `startedAt`/`arrivedAt`/`completedAt` for progress. `[]` if the caller has no Technician row.",
      responses: {
        "200": jsonResponse("Visit rows.", { type: "array", items: ref("MobileVisitRow") }),
        "401": ERR[401],
        "403": MOBILE_ERR_403,
      },
    },
  },
  "/mobile/completions": {
    get: {
      tags: ["Mobile"],
      summary: "Today's completions + revenue summary",
      description: "Zeroed summary if the caller has no Technician row.",
      responses: {
        "200": jsonResponse("Completions summary.", ref("MobileCompletions")),
        "401": ERR[401],
        "403": MOBILE_ERR_403,
      },
    },
  },
  "/mobile/visits/{id}": {
    parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
    get: {
      tags: ["Mobile"],
      summary: "Job detail",
      description: "Full visit with debt-gate result (`canStart`/`blockReason`), outstanding invoices, last clean, round position, activity log and photos (each with a 1-hour `signedUrl`). `paymentMethod` is the effective method (visit → plan → customer). 403 NOT_YOUR_VISIT unless the visit is assigned to the caller.",
      responses: {
        "200": jsonResponse("Visit detail.", ref("MobileVisitDetail")),
        "401": ERR[401],
        "403": MOBILE_ERR_403,
        "404": ERR[404],
      },
    },
  },
  "/mobile/visits/{id}/start": {
    parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
    patch: {
      tags: ["Mobile"],
      summary: "Start a visit (SCHEDULED → IN_PROGRESS)",
      description:
        "409 unless the visit is SCHEDULED. Enforces the debt gate: when `debtHoldEnabled`, a customer whose DRAFT/SENT invoices exceed `debtHoldMaxInvoices`/`debtHoldMaxAmount` (a null limit = any debt) gets 403 with the block reason.",
      responses: {
        "200": jsonResponse("Started.", ref("MobileStatusResult")),
        "401": ERR[401],
        "403": errorResponse("Blocked by the debt gate (or no Profile).", "Customer has 2 unpaid invoice(s) totalling £70.00, over the allowed limit."),
        "404": ERR[404],
        "409": errorResponse("Visit is not SCHEDULED.", "Cannot start a visit with status COMPLETED"),
      },
    },
  },
  "/mobile/visits/{id}/arrive": {
    parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
    patch: {
      tags: ["Mobile"],
      summary: "Mark arrived (stamps arrivedAt)",
      description: "409 unless the visit is IN_PROGRESS. Status is unchanged.",
      responses: {
        "200": jsonResponse("Arrived.", ref("MobileStatusResult")),
        "401": ERR[401],
        "403": MOBILE_ERR_403,
        "404": ERR[404],
        "409": errorResponse("Visit is not IN_PROGRESS.", "Cannot mark arrived for a visit with status SCHEDULED"),
      },
    },
  },
  "/mobile/visits/{id}/skip": {
    parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
    patch: {
      tags: ["Mobile"],
      summary: "Skip a visit",
      description: "409 if COMPLETED; already-SKIPPED is a no-op.",
      requestBody: jsonBody(ref("MobileSkipInput")),
      responses: {
        "200": jsonResponse("Skipped.", ref("MobileStatusResult")),
        "400": ERR[400],
        "401": ERR[401],
        "403": MOBILE_ERR_403,
        "404": ERR[404],
        "409": errorResponse("Visit is completed.", "Cannot skip a completed visit"),
      },
    },
  },
  "/mobile/visits/{id}/price": {
    parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
    patch: {
      tags: ["Mobile"],
      summary: "Adjust the visit price (partial service)",
      description: "Only for SCHEDULED/IN_PROGRESS visits (409 otherwise). The first adjustment remembers the full price in `originalPrice`.",
      requestBody: jsonBody(ref("MobilePriceInput")),
      responses: {
        "200": jsonResponse("Adjusted.", { type: "object", required: ["adjusted"], properties: { adjusted: { type: "boolean", enum: [true] } } }),
        "400": ERR[400],
        "401": ERR[401],
        "403": MOBILE_ERR_403,
        "404": ERR[404],
        "409": errorResponse("Visit is COMPLETED or SKIPPED.", "Cannot adjust price of a COMPLETED visit"),
      },
    },
  },
  "/mobile/visits/{id}/complete": {
    parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
    patch: {
      tags: ["Mobile"],
      summary: "Complete a visit and create its Payment",
      description:
        "Same shared completion service as PATCH /visits/{id}/complete (D-2): `payment` { method: CASH | CHEQUE | NONE, amount?, chequeNumber? } is validated before anything is written, then visit + Payment + events are written in one transaction. " +
        "CHEQUE stores `chequeNumber` on Payment.reference (PENDING). Optional `note` (≤2000 chars) is saved on the visit. Queues GHL `visit.completed` and (unless opted out) the visit-completed customer message. Already-COMPLETED returns `payment: null`; SKIPPED/CANCELLED → 409.",
      requestBody: jsonBody({
        allOf: [ref("VisitCompleteInput"), { type: "object", properties: { note: { type: "string", maxLength: 2000 } } }],
      }, false),
      responses: {
        "200": jsonResponse("Visit status + created payment.", ref("VisitCompleteResult")),
        "400": errorResponse("INVALID_PAYMENT, CHEQUE_NUMBER_REQUIRED or PAYMENT_CONFIRMATION_REQUIRED.", "\"payment.chequeNumber\" is required for cheque payments"),
        "401": ERR[401],
        "403": MOBILE_ERR_403,
        "404": ERR[404],
        "409": errorResponse("Visit was skipped or cancelled.", "Cannot complete a skipped visit"),
      },
    },
  },
  "/mobile/visits/{id}/access-issues": {
    parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
    post: {
      tags: ["Mobile"],
      summary: "Report an access issue on the visit (optionally with photos)",
      description: "To attach photos: POST /mobile/visits/{id}/photos/upload-url with `type: ACCESS_ISSUE` → PUT bytes to `signedUrl` → send the `path`s here as `photoPaths`. 400 if a path isn't this visit's object or more than 10 are sent.",
      requestBody: jsonBody(ref("MobileAccessIssueInput")),
      responses: {
        "201": jsonResponse("Recorded.", ref("MobileAccessIssueResult")),
        "400": ERR[400],
        "401": ERR[401],
        "403": MOBILE_ERR_403,
        "404": ERR[404],
      },
    },
  },
  "/mobile/visits/{id}/notes": {
    parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
    post: {
      tags: ["Mobile"],
      summary: "Add a note (stored as an INTERNAL PropertyNote on the visit's property)",
      requestBody: jsonBody(ref("MobileNoteInput")),
      responses: {
        "201": jsonResponse("Recorded.", { type: "object", required: ["recorded"], properties: { recorded: { type: "boolean", enum: [true] } } }),
        "400": ERR[400],
        "401": ERR[401],
        "403": MOBILE_ERR_403,
        "404": ERR[404],
      },
    },
  },
  "/mobile/visits/{id}/photos/upload-url": {
    parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
    post: {
      tags: ["Mobile"],
      summary: "Signed URL to upload a BEFORE/AFTER/ACCESS_ISSUE photo",
      description: "Step 1 of 3: get URL → PUT bytes to `signedUrl` → POST /mobile/visits/{id}/photos with `path` (BEFORE/AFTER), or POST /mobile/visits/{id}/access-issues `photoPaths` (ACCESS_ISSUE).",
      requestBody: jsonBody(ref("MobilePhotoUploadUrlInput")),
      responses: {
        "200": jsonResponse("Signed upload URL.", ref("SignedUploadUrl")),
        "400": ERR[400],
        "401": ERR[401],
        "403": MOBILE_ERR_403,
        "404": ERR[404],
        "413": errorResponse("`contentLength` over 10 MB.", "File too large. Maximum size is 10 MB"),
      },
    },
  },
  "/mobile/visits/{id}/photos": {
    parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
    post: {
      tags: ["Mobile"],
      summary: "Record an uploaded photo",
      requestBody: jsonBody(ref("MobilePhotoInput")),
      responses: {
        "201": jsonResponse("Recorded.", { type: "object", required: ["recorded"], properties: { recorded: { type: "boolean", enum: [true] } } }),
        "400": ERR[400],
        "401": ERR[401],
        "403": MOBILE_ERR_403,
        "404": ERR[404],
      },
    },
  },
  "/mobile/visits/{id}/debt-payment": {
    parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
    post: {
      tags: ["Mobile"],
      summary: "Collect the customer's outstanding debt on site (cash or cheque)",
      description:
        "`method: CASH` (or the deprecated `cashConfirmed: true`) marks all of the customer's DRAFT/SENT invoices PAID, records one CASH PAID payment for the total (not linked to a visit) and clears `badDebt`. " +
        "`method: CHEQUE` + `chequeNumber` records one PENDING CHEQUE payment for the total with Payment.reference = chequeNumber (+ CHEQUE_RECEIVED activity) and leaves the invoices open until the office marks them paid (POST /invoices/{id}/mark-paid). " +
        "With nothing outstanding it just clears `badDebt` (`cleared: true`, amounts 0).",
      requestBody: jsonBody(ref("MobileDebtPaymentInput")),
      responses: {
        "200": jsonResponse("Result.", ref("MobileDebtPaymentResult")),
        "400": errorResponse("No/unknown method (code INVALID_PAYMENT), or CHEQUE without chequeNumber.", "method must be \"CASH\" or \"CHEQUE\" (or send cashConfirmed: true)"),
        "401": ERR[401],
        "403": MOBILE_ERR_403,
        "404": ERR[404],
      },
    },
  },
  "/mobile/visits/{id}/upsells": {
    parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
    post: {
      tags: ["Mobile"],
      summary: "Record an upsell on the job (B6)",
      description: "Stored as an UPSELL TechnicianIncident for the caller (counts toward their KPIs).",
      requestBody: jsonBody({
        type: "object",
        required: ["description", "amount"],
        properties: {
          description: { type: "string", minLength: 1, maxLength: 500 },
          amount: { type: "number", exclusiveMinimum: true, minimum: 0, maximum: 9999.99 },
        },
        example: { description: "Conservatory roof", amount: 15 },
      }),
      responses: {
        "201": jsonResponse("Recorded upsell.", ref("MobileUpsell")),
        "400": ERR[400],
        "401": ERR[401],
        "403": MOBILE_ERR_403,
        "404": ERR[404],
      },
    },
  },
  "/mobile/chat/messages": {
    get: {
      tags: ["Mobile"],
      summary: "Round chat messages (oldest first)",
      description: "Poll with `since` to fetch only newer messages. 403 NOT_YOUR_ROUND unless the caller is assigned to the round or has a visit on it. Each message carries `isMine` and `photoSignedUrls` (1-hour signed read URLs for `photoUrls`).",
      parameters: [
        { name: "roundId", in: "query", required: true, schema: { type: "string" } },
        { name: "since", in: "query", required: false, schema: { type: "string", format: "date-time" }, description: "Only messages created strictly after this instant." },
      ],
      responses: {
        "200": jsonResponse("Messages.", { type: "array", items: ref("ChatMessage") }),
        "400": ERR[400],
        "401": ERR[401],
        "403": MOBILE_ERR_403,
      },
    },
    post: {
      tags: ["Mobile"],
      summary: "Post a round chat message",
      description: "403 NOT_YOUR_ROUND unless the caller is on the round; WORK_PHOTOS also needs the visit to be the caller's (403 NOT_YOUR_VISIT). The sender is stored as the caller's Profile id.",
      requestBody: jsonBody(ref("MobileChatMessageInput")),
      responses: {
        "201": jsonResponse("Created message.", ref("ChatMessage")),
        "400": ERR[400],
        "401": ERR[401],
        "403": MOBILE_ERR_403,
      },
    },
  },

  // =====================================================================
  // Webhooks — mounted with express.raw (raw JSON body) before the JSON
  // parser and method guards. No Bearer token: verified by provider
  // signature and/or a per-tenant URL secret. Processing is async after
  // the 200 ack.
  // =====================================================================
  "/webhooks/stripe": {
    post: {
      tags: ["Webhooks"],
      summary: "Stripe platform Connect webhook",
      description:
        "One platform-level endpoint for all tenants (\"Listen to events on Connected accounts\"). Verified with the `Stripe-Signature` header against `STRIPE_CONNECT_WEBHOOK_SECRET`; " +
        "the tenant is resolved from `event.account` → Tenant.stripeConnectAccountId. Idempotent by event id. Handles `checkout.session.completed` (one-time: PAID Payment + invoice PAID; setup: saves the default payment method), " +
        "`checkout.session.expired` and `payment_intent.payment_failed`. A paid invoice also auto-releases the customer's payment hold when nothing else is outstanding. Non-Connect events and unknown accounts are acked with 200.",
      security: [],
      parameters: [{ name: "Stripe-Signature", in: "header", required: true, schema: { type: "string" } }],
      requestBody: jsonBody({ type: "object", additionalProperties: true, description: "Raw Stripe Event JSON." }),
      responses: {
        "200": { description: "Acknowledged (also for replays, non-Connect events and unknown accounts)." },
        "400": errorResponse("Signature verification failed.", "Webhook signature verification failed"),
        "500": { description: "The event could not be recorded or processed (Stripe will retry)." },
        "503": jsonResponse("STRIPE_CONNECT_WEBHOOK_SECRET is not configured (code WEBHOOK_NOT_CONFIGURED).", {
          allOf: [ref("Error")],
          example: { error: "Stripe webhook is not configured", code: "WEBHOOK_NOT_CONFIGURED" },
        }),
      },
    },
  },
  "/webhooks/gocardless": {
    post: {
      tags: ["Webhooks"],
      summary: "GoCardless webhook (per tenant)",
      description:
        "URL comes from POST /settings/payment/gocardless/connect. `secret` must match the tenant's route secret and the body is verified with the `Webhook-Signature` header against the signing secret saved via PATCH /settings/payment/gocardless/webhook-secret. " +
        "Unknown tenant, wrong route secret, or no signing secret saved yet → silent 200 (nothing processed). Handles payments paid/confirmed/failed/cancelled and mandates active/cancelled/failed/expired; idempotent per event id.",
      security: [],
      parameters: [
        { name: "tenantId", in: "query", required: true, schema: { type: "string" } },
        { name: "secret", in: "query", required: true, schema: { type: "string" } },
        { name: "Webhook-Signature", in: "header", required: true, schema: { type: "string" } },
      ],
      requestBody: jsonBody({ type: "object", additionalProperties: true, description: "Raw GoCardless `{ events: [...] }` JSON." }),
      responses: {
        "200": { description: "Acknowledged (or silently ignored)." },
        "400": errorResponse("tenantId/secret missing, or malformed body.", "Missing tenantId or secret"),
        "401": errorResponse("Invalid webhook signature.", "Invalid webhook signature"),
      },
    },
  },
  "/webhooks/ghl": {
    post: {
      tags: ["Webhooks"],
      summary: "GoHighLevel webhook (per tenant)",
      description:
        "URL comes from the GHL connect flow. `secret` is compared (constant-time) with the tenant's GHL webhook secret. Handles: lead handoff (payload with `contactId` and no `type` → creates Customer [+ Property if address1 + postalCode]), " +
        "`InboundMessage` (stored as an INBOUND Message), `Uninstall` (clears the GHL connection); ContactCreate/ContactUpdate are ignored (RoundFlow is master). Events with an `id` are deduplicated.",
      security: [],
      parameters: [
        { name: "tenantId", in: "query", required: true, schema: { type: "string" } },
        { name: "secret", in: "query", required: true, schema: { type: "string" } },
      ],
      requestBody: jsonBody({ type: "object", additionalProperties: true, description: "Raw GHL event JSON." }),
      responses: {
        "200": { description: "Acknowledged." },
        "400": errorResponse("Body is not valid JSON.", "Malformed JSON"),
        "401": { description: "tenantId/secret missing, unknown tenant, GHL not connected, or secret mismatch." },
      },
    },
  },
};

// Mobile visit writes that run through the idempotency middleware
// (src/mobile/idempotency.ts): an offline replay with the same
// X-Idempotency-Key returns the stored 2xx response with `Idempotent-Replay: true`.
const MOBILE_VISIT_WRITES: Array<[string, "patch" | "post"]> = [
  ["/mobile/visits/{id}/start", "patch"],
  ["/mobile/visits/{id}/arrive", "patch"],
  ["/mobile/visits/{id}/skip", "patch"],
  ["/mobile/visits/{id}/price", "patch"],
  ["/mobile/visits/{id}/complete", "patch"],
  ["/mobile/visits/{id}/access-issues", "post"],
  ["/mobile/visits/{id}/notes", "post"],
  ["/mobile/visits/{id}/photos", "post"],
  ["/mobile/visits/{id}/debt-payment", "post"],
  ["/mobile/visits/{id}/upsells", "post"],
];

const idempotencyKeyParam: OpenAPIV3.ParameterObject = {
  name: "X-Idempotency-Key",
  in: "header",
  required: false,
  schema: { type: "string", minLength: 1, maxLength: 200 },
  description:
    "Optional offline-replay key (stored 7 days). A repeat with the same key + route returns the original 2xx response without re-running the action. " +
    "400 INVALID_IDEMPOTENCY_KEY (blank / >200 chars), 403 IDEMPOTENCY_KEY_CONFLICT (another technician's key), 409 IDEMPOTENCY_KEY_REUSED (same key, different route).",
};

for (const [path, method] of MOBILE_VISIT_WRITES) {
  const op = (paths[path] as OpenAPIV3.PathItemObject)[method] as OpenAPIV3.OperationObject;
  op.parameters = [...(op.parameters ?? []), idempotencyKeyParam];
  for (const [status, response] of Object.entries(op.responses)) {
    if (!status.startsWith("2")) continue;
    (response as OpenAPIV3.ResponseObject).headers = {
      "Idempotent-Replay": { description: "\"true\" when this is a stored replay for the X-Idempotency-Key.", schema: { type: "string", enum: ["true"] } },
    };
  }
  op.responses["409"] ??= errorResponse("Key reused for a different request (code IDEMPOTENCY_KEY_REUSED).", "Idempotency key was already used for a different request");
}

// The 405 pre-filter (src/server/bootstrap.ts buildPathMethodMap) checks
// paths deepest-first and stops at the first regex match, so among paths of
// the same depth a literal one (/invoices/bulk) must come before a templated
// sibling (/invoices/{id}) or the latter's allow-list would 405 it. Order by
// placeholder count (stable sort keeps the grouping above otherwise).
const placeholderCount = (p: string) => (p.match(/\{[^}]+\}/g) ?? []).length;
const orderedPaths: OpenAPIV3.PathsObject = Object.fromEntries(
  Object.entries(paths).sort(([a], [b]) => placeholderCount(a) - placeholderCount(b))
);

// ---------------------------------------------------------------------------
// 7. Assembled document.
// ---------------------------------------------------------------------------

// Swagger's "Execute" button targets the FIRST entry in `servers`. In a deployed
// environment we must point it at the public origin, not localhost. Resolution
// order: explicit PUBLIC_API_URL override → Railway's injected RAILWAY_PUBLIC_DOMAIN
// → (neither set, i.e. local dev) → localhost only. The deployed URL is listed
// first so it's the default; localhost stays available in the dropdown.
export function resolveServers(env: NodeJS.ProcessEnv = process.env): OpenAPIV3.ServerObject[] {
  const publicUrl =
    env.PUBLIC_API_URL ?? (env.RAILWAY_PUBLIC_DOMAIN ? `https://${env.RAILWAY_PUBLIC_DOMAIN}` : undefined);
  return [
    ...(publicUrl ? [{ url: publicUrl, description: "Deployed" }] : []),
    { url: "http://localhost:3000", description: "Local dev" },
  ];
}

const servers = resolveServers();

export const openApiDocument: OpenAPIV3.Document = {
  openapi: "3.0.3",
  info: {
    title: "RoundFlow API",
    version: "0.1.0",
    description: [
      "Backend API for RoundFlow. Frontend/backend contract (admin web app + technician mobile app).",
      "",
      "**Auth:** Supabase issues the token (login/signup happen there); this backend only",
      "**verifies** it. Every endpoint except `/health`, `GET /invites/{token}` and the",
      "signature-verified `/webhooks/*` requires `Authorization: Bearer <Supabase ES256 JWT>`.",
      "Get a token via **Auth › login**, then click **Authorize** (top-right).",
      "",
      "**Money fields** (`defaultPrice`, etc.) are returned as strings but sent as numbers.",
      "",
      "**Setup Wizard:** 12 steps; required steps are 1–9 and 11, step 10 (Assign Technicians to Rounds)",
      "is deferred, and step 12 is POST /setup/complete itself.",
      "",
      "**Multi-tenant:** each signup provisions a dedicated Postgres schema (`t_<hex>`); every",
      "request is routed to the caller's tenant schema, and BusinessSettings is one row per tenant.",
      "",
      "**Errors** are `{ error, code? }` plus any extra fields the error carries (e.g. `fields`, `suggestions`, `proposedName`). Codes added in the Phase 1 audit pass:",
      "FIELD_REMOVED, INVALID_STATE, GHL_NOT_CONNECTED, GHL_SEND_FAILED, NO_CONTACT_FOR_CHANNEL, STRIPE_NOT_CONNECTED, INVOICE_NOT_PAYABLE, INVOICE_NOT_SENDABLE,",
      "INVOICE_ALREADY_SENT, INVOICE_ALREADY_PAID, INVOICE_VOID, AMOUNT_MISMATCH, ALREADY_INVOICED, VISIT_NOT_COMPLETED, INVALID_ALLOCATION, NO_MATCHING_ROUND,",
      "INVALID_PAYMENT, CHEQUE_NUMBER_REQUIRED, PAYMENT_CONFIRMATION_REQUIRED, TECHNICIAN_ONLY, NO_TECHNICIAN, NOT_YOUR_VISIT, NOT_YOUR_ROUND,",
      "INVALID_IDEMPOTENCY_KEY, IDEMPOTENCY_KEY_CONFLICT, IDEMPOTENCY_KEY_REUSED, WEBHOOK_NOT_CONFIGURED.",
    ].join("\n"),
  },
  servers,
  tags: [
    {
      name: "Auth",
      description:
        "Login (token minted by Supabase — external) and the current user's profile.",
    },
    { name: "Health", description: "Liveness (/health) and readiness (/health/ready); both 503 while tenant migrations run." },
    { name: "Setup", description: "First-run Setup Wizard (12 steps)." },
    { name: "Settings", description: "Post-completion settings editing. ADMIN/MANAGER only. Mutations (PATCH, POST, DELETE) require setup to be complete; GETs are always open." },
    { name: "Integrations", description: "Provider connections — GoCardless (access token + manual webhook setup), Stripe Connect (OAuth) and GoHighLevel (OAuth or private API key). ADMIN/MANAGER only; everything except the OAuth callbacks requires setup to be complete." },
    { name: "Invites", description: "Tenant invite flow — send, validate, and accept invites for new technicians/managers." },
    { name: "Customers", description: "M2 — customer list + aggregate detail (Screens 14/15), add property, invoices, GoCardless mandate setup. ADMIN/MANAGER only." },
    { name: "Properties", description: "M2 — property create/update, pause/resume, notes (Add Property, M9, M20)." },
    { name: "Visits", description: "One-off (ad-hoc) visit creation and admin-side visit completion. ADMIN/MANAGER only." },
    { name: "Complaints", description: "Customer service complaint queue — log, review, schedule revisits, resolve, reopen. All mutations: ADMIN/MANAGER only." },
    { name: "Dashboard", description: "Dashboard screen data — KPI cards, alert counts, today's rounds, technician performance, and chart series. ADMIN/MANAGER only." },
    { name: "Emergencies", description: "Technician emergency reporting and reassignment flow — report, list, inspect, pick a replacement, and confirm reassignment." },
    { name: "Rounds", description: "Round CRUD, the planner (calendar + list/map views, including batched multi-round variants), the Today panel, reassign, push-missed, and on-demand visit generation. ADMIN/MANAGER only." },
    { name: "Technicians", description: "Technician directory — list/detail/create/update with round names and today's job stats. Distinct from Settings → /settings/technicians, which is the invite-pending-only editor. ADMIN/MANAGER only." },
    { name: "Messages", description: "Direct GoHighLevel-backed messaging — send to a single customer, or broadcast to every customer in a round. ADMIN/MANAGER only." },
    { name: "Debt", description: "Collections — the debt board (paginated, bucketed), bucket counts, invoice detail, reminders, payment links, and bad-debt/hold flags. ADMIN/MANAGER only." },
    { name: "Reports", description: "Activity log and visit/technician/revenue reporting, plus a CSV export. ADMIN/MANAGER only." },
    { name: "Today", description: "Today's Work aggregate (Screen 12) and Close Operational Day (M21). ADMIN/MANAGER only." },
    { name: "Invoices", description: "Invoice preview (unsaved), detail, PDF rendering, create, and send. ADMIN/MANAGER only." },
    { name: "Payments", description: "Stripe Checkout session creation (one-time invoice payment and card-on-file setup) and manual BACS/cheque reconciliation. ADMIN/MANAGER only." },
    { name: "Service Plans", description: "Per-plan price/method/frequency edits and pause/resume, targeting one ServicePlan directly by id. ADMIN/MANAGER only." },
    { name: "Mobile", description: "Technician app (mounted at /mobile): profile, notifications, push devices, today's rounds/visits, job tracking (start/arrive/skip/price/complete), photos, notes, upsells, debt collection and round chat. TECHNICIAN role only (403 TECHNICIAN_ONLY / NO_TECHNICIAN); visit routes require the visit to be the caller's (NOT_YOUR_VISIT); visit writes accept X-Idempotency-Key." },
    { name: "Webhooks", description: "Inbound provider webhooks (Stripe, GoCardless, GoHighLevel). No Bearer token — verified by signature and/or per-tenant URL secret." },
  ],
  // Global default: all operations require the Bearer token unless they
  // override with `security: []` (e.g. /health).
  security: [{ bearerAuth: [] }],
  paths: orderedPaths,
  components: {
    securitySchemes: {
      bearerAuth: {
        type: "http",
        scheme: "bearer",
        bearerFormat: "JWT",
        description: "Supabase ES256 access token.",
      },
    },
    schemas: { ...enumSchemas, ...modelSchemas, ...inputSchemas },
    responses: reusableResponses,
  },
};

export default openApiDocument;
