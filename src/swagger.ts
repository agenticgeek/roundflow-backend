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
 *   • Setup is single-tenant in Phase 1 (one shared business config).
 */

import type { OpenAPIV3 } from "openapi-types";

// ---------------------------------------------------------------------------
// Supabase Auth (external) — used only to document the token-fetch step.
// The anon key is the PUBLIC (publishable) key — safe to expose, NOT a secret.
// ---------------------------------------------------------------------------

const SUPABASE_URL = "https://cixtfdnuwbmxvilkvihv.supabase.co";
const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNpeHRmZG51d2JteHZpbGt2aWh2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI5MzMwMjIsImV4cCI6MjA5ODUwOTAyMn0.c4q7N-ys7BlCdEgC1TKWXRl6bdpSUNirdIxTz8XqJN4";

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
    "FORTNIGHTLY",
    "FOUR_WEEKLY",
    "SIX_WEEKLY",
    "EIGHT_WEEKLY",
    "MONTHLY",
  ]),
  VisitStatus: stringEnum(["SCHEDULED", "IN_PROGRESS", "COMPLETED", "SKIPPED"]),
  PaymentStatus: stringEnum(["NOT_DUE", "PENDING", "PAID", "FAILED", "OVERDUE"]),
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
  InvoiceStatus: stringEnum(["DRAFT", "SENT", "PAID"]),
  IssueType: stringEnum(["ACCESS_PROBLEM", "GATE_LOCKED", "PAYMENT_ISSUE", "OTHER"]),
  PhotoType: stringEnum(["PROPERTY", "BEFORE", "AFTER"]),
  PaymentTiming: stringEnum(["COLLECT_AFTER_VISIT", "COLLECT_BEFORE_VISIT", "COLLECT_ON_DATE"]),
  NoteType: stringEnum(["INTERNAL", "RISK_WARNING", "CUSTOMER"]),
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
    properties: { error: { type: "string" } },
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

  BusinessSettings: {
    type: "object",
    description: "The single business config row (Phase 1 is single-tenant).",
    properties: {
      id: { type: "string" },
      uniqueId: { type: "string", example: "singleton" },
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
      bankDetails: { type: "object", nullable: true, additionalProperties: true },
      paymentRule: nullableRef("PaymentTiming"),
      debtHoldEnabled: { type: "boolean" },
      vatInInvoices: { type: "boolean" },
      gocardlessConnected: { type: "boolean" },
      stripeConnected: { type: "boolean" },
      setupCompleted: { type: "boolean" },
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
    required: ["status"],
    properties: {
      status: { type: "string", example: "connected" },
      connectUrl: {
        type: "string",
        nullable: true,
        description: "Phase-1 stub returns no URL; a real URL comes from GHL in Phase 2.",
      },
    },
  },

  MessageTemplateDeferred: {
    type: "object",
    required: ["status", "source"],
    properties: {
      status: { type: "string", enum: ["deferred"] },
      source: { type: "string", example: "ghl" },
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
        description: "True for step 5 (SMS Templates). Step 2 (Payment Setup) is now a real step.",
      },
    },
  },

  SetupStatus: {
    type: "object",
    required: ["setupCompleted", "allRequiredComplete", "steps"],
    properties: {
      setupCompleted: { type: "boolean" },
      allRequiredComplete: {
        type: "boolean",
        description: "True when every non-deferred step (1,2,3,4,6,7,8) is complete.",
      },
      steps: { type: "array", items: ref("StepStatus") },
    },
    example: {
      setupCompleted: false,
      allRequiredComplete: false,
      steps: [
        { step: 1, complete: false, deferred: false },
        { step: 2, complete: false, deferred: false },
        { step: 3, complete: false, deferred: false },
        { step: 4, complete: false, deferred: false },
        { step: 5, complete: false, deferred: true },
        { step: 6, complete: false, deferred: false },
        { step: 7, complete: false, deferred: false },
        { step: 8, complete: false, deferred: false },
      ],
    },
  },

  DeferredStub: {
    type: "object",
    required: ["status", "reason"],
    properties: {
      status: { type: "string", enum: ["deferred"] },
      reason: { type: "string" },
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
    },
    example: { defaultCycleLength: 28 },
  },

  PaymentSetupInput: {
    type: "object",
    description:
      "Setup step 2 (Payment Setup). All fields optional. Connect toggles are Phase-1 stubs (booleans; no real OAuth).",
    properties: {
      paymentRule: {
        type: "string",
        enum: ["COLLECT_AFTER_VISIT", "COLLECT_BEFORE_VISIT", "COLLECT_ON_DATE"],
        description: "Default payment collection rule.",
      },
      debtHoldEnabled: { type: "boolean", description: "Block service if payment is overdue." },
      vatInInvoices: { type: "boolean", description: "Include VAT in invoices by default." },
      gocardlessConnected: { type: "boolean", description: "GoCardless connection flag (Phase-1 stub)." },
      stripeConnected: { type: "boolean", description: "Stripe connection flag (Phase-1 stub)." },
    },
    example: { paymentRule: "COLLECT_AFTER_VISIT", debtHoldEnabled: true, vatInInvoices: true },
  },

  ServiceInput: {
    type: "object",
    required: ["name", "defaultPrice"],
    properties: {
      name: { type: "string", minLength: 1 },
      defaultPrice: { type: "number", description: "Sent as a number; returned as a string." },
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
    },
    example: { businessName: "Northumberland Window Cleaning", currency: "GBP" },
  },

  RoundSettingsUpdateInput: {
    type: "object",
    description: "Partial update — round-settings fields only.",
    properties: {
      defaultCycleLength: { type: "integer", nullable: true, description: "Cycle length in days." },
      defaultWorkingDays: { type: "array", items: { type: "string", enum: ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"] } },
    },
    example: { defaultCycleLength: 28 },
  },

  ServiceCreateInput: {
    type: "object",
    required: ["name", "defaultPrice"],
    properties: {
      name: { type: "string", minLength: 1 },
      defaultPrice: { type: "number", minimum: 0, description: "Sent as a number; returned as a string. Zero is valid for free services." },
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
      defaultPrice: { type: "number", minimum: 0 },
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
    },
  },

  PaymentRulesUpdateInput: {
    type: "object",
    description: "Partial update of payment RULES only — does not touch the connect flags.",
    properties: {
      paymentRule: nullableRef("PaymentTiming"),
      vatInInvoices: { type: "boolean" },
      debtHoldEnabled: { type: "boolean" },
    },
    example: { paymentRule: "COLLECT_AFTER_VISIT", vatInInvoices: true },
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
      serviceAreaId: { type: "string", nullable: true },
      propertyType: { type: "string", nullable: true },
      accessNotes: { type: "string", nullable: true },
      riskNotes: { type: "string", nullable: true },
      status: ref("LifecycleStatus"),
      roundId: { type: "string", nullable: true },
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
      roundId: { type: "string", nullable: true },
      roundName: { type: "string", nullable: true },
      frequency: nullableRef("CleaningFrequency"),
      price: { type: "number", nullable: true },
      technicianId: { type: "string", nullable: true },
      technicianName: { type: "string", nullable: true },
      nextDueDate: { ...dateTime, nullable: true },
      paymentStatus: { type: "string", enum: ["paid", "hold", "pending", "overdue", "failed", "none"], description: "Payment badge. none = no payment history yet (new customer)." },
      onHold: { type: "boolean" },
      amountDue: { type: "number", description: "Total outstanding for this customer. Omitted for TECHNICIAN viewers." },
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
          amountDue: { type: "number", description: "Total outstanding across all customers. Omitted for TECHNICIAN viewers." },
        },
      },
      customers: { type: "array", items: ref("CustomerListRow") },
    },
  },
  VisitHistoryRow: {
    type: "object",
    properties: {
      visitId: { type: "string" },
      date: dateTime,
      roundName: { type: "string", nullable: true },
      status: ref("VisitStatus"),
      paymentStatus: nullableRef("PaymentStatus"),
      notes: { type: "string", nullable: true },
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
    description: "Full Customer Detail aggregate (Screen 15, all 6 tabs). Phase 1: one active property per customer; round/technician/next-visit fields are null when the property is unassigned (Property.roundId = null).",
    properties: {
      customer: {
        type: "object",
        properties: {
          id: { type: "string" }, name: { type: "string" },
          phone: { type: "string", nullable: true }, email: { type: "string", nullable: true },
          status: ref("LifecycleStatus"), ghlContactId: { type: "string", nullable: true },
        },
      },
      property: {
        type: "object",
        nullable: true,
        properties: {
          id: { type: "string" }, addressLine: { type: "string" }, postcode: { type: "string" },
          propertyType: { type: "string", nullable: true }, accessNotes: { type: "string", nullable: true },
          riskNotes: { type: "string", nullable: true }, status: ref("LifecycleStatus"),
          roundId: { type: "string", nullable: true }, roundName: { type: "string", nullable: true },
          serviceAreaId: { type: "string", nullable: true },
        },
      },
      servicePlan: nullableRef("ServicePlanView"),
      standingInfo: {
        type: "object",
        properties: {
          frequency: nullableRef("CleaningFrequency"),
          assignedRound: { type: "string", nullable: true },
          technicianName: { type: "string", nullable: true },
          paymentStatus: { type: "string", enum: ["paid", "hold", "pending", "overdue", "failed", "none"], description: "Payment badge. none = no payment history yet (new customer)." },
          outstandingBalance: { type: "number", description: "Total outstanding for this customer. Omitted for TECHNICIAN viewers." },
          lastPaymentDate: { ...dateTime, nullable: true },
          issuesCount: { type: "integer" },
          nextVisitStatus: nullableRef("VisitStatus"),
        },
      },
      tabs: {
        type: "object",
        properties: {
          overview: { type: "object", nullable: true, additionalProperties: true },
          servicePlan: nullableRef("ServicePlanView"),
          visitHistory: { type: "array", items: ref("VisitHistoryRow") },
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
      email: { type: "string", nullable: true },
      addressLine: { type: "string", minLength: 1 },
      postcode: { type: "string", minLength: 1 },
      propertyName: { type: "string", nullable: true },
      propertyType: { type: "string", nullable: true, enum: ["HOUSE", "FLAT_APARTMENT", "COMMERCIAL", "OFFICE", "CONSERVATORY", null] },
      serviceAreaId: { type: "string", description: "Required. Must exist (404 if not)." },
      serviceId: { type: "string", nullable: true },
      price: { type: "number", description: "Positive number.", minimum: 0, exclusiveMinimum: true },
      cleanMethod: { type: "string", nullable: true },
      paymentMethod: nullableRef("PaymentMethod"),
      nextDueDate: { type: "string", format: "date", nullable: true },
      accessNotes: { type: "string", nullable: true },
      riskNotes: { type: "string", nullable: true },
      roundId: { type: "string", nullable: true, description: "null = Save & Assign Later (unassigned); an id must exist (404 if not)." },
    },
    example: { customerName: "John Smith", addressLine: "12 Market Street", postcode: "NE66 1SS", price: 35, cleanMethod: "Water Fed Pole", paymentMethod: "GOCARDLESS", roundId: null },
  },
  PropertyUpdateInput: {
    type: "object",
    description: "Partial update. roundId: null = unassign, an id = assign/reassign (Move Round).",
    properties: {
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
      email: { type: "string", nullable: true },
      addressLine: { type: "string", minLength: 1 },
      postcode: { type: "string", minLength: 1 },
      propertyType: { type: "string", nullable: true, enum: ["HOUSE", "FLAT_APARTMENT", "COMMERCIAL", "OFFICE", "CONSERVATORY", null] },
      accessNotes: { type: "string", nullable: true },
      riskNotes: { type: "string", nullable: true },
      roundId: { type: "string", nullable: true },
      price: { type: "number", minimum: 0, exclusiveMinimum: true },
      cleanMethod: { type: "string", nullable: true },
      paymentMethod: nullableRef("PaymentMethod"),
    },
  },
  PauseServiceInput: {
    type: "object",
    required: ["reason", "pauseStartDate"],
    properties: {
      reason: { type: "string", minLength: 1, description: "Required by the UI; not persisted (no column)." },
      pauseStartDate: { type: "string", format: "date" },
      pauseEndDate: { type: "string", format: "date", nullable: true, description: "null = indefinite pause." },
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
    "A mutating setup step was called after setup is already complete.",
    "Setup is already complete; wizard endpoints are locked."
  ),
  NotFound: errorResponse("Resource not found.", "Service not found"),
  Conflict: errorResponse(
    "POST /setup/complete when setup is already complete.",
    "Setup is already complete."
  ),
  Gone: errorResponse(
    "Invite has expired or has already been accepted.",
    "Invite has expired"
  ),
  ServerError: errorResponse("Unexpected server error.", "Internal Server Error"),
};

// ---------------------------------------------------------------------------
// 6. Paths.
// ---------------------------------------------------------------------------

/** A deferred-step (2 & 5) response used by both GET and POST. */
const deferredResponses = (): OpenAPIV3.ResponsesObject => ({
  "200": jsonResponse("Deferred stub — no DB write.", ref("DeferredStub")),
  "401": ERR[401],
});

const paths: OpenAPIV3.PathsObject = {
  // ---- Health ----
  "/health": {
    get: {
      tags: ["Health"],
      summary: "Liveness probe",
      description: "Unauthenticated. Returns server status + timestamp.",
      security: [], // public — overrides the global security requirement
      responses: {
        "200": jsonResponse("OK", ref("HealthStatus")),
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

  "/auth/signup": {
    post: {
      tags: ["Auth"],
      summary: "Register a new admin (first-time signup)",
      description:
        "Called by the frontend after Supabase confirms a new session and `GET /auth/me` returns 404. " +
        "Creates a Profile (role: ADMIN) and a Tenant row in one transaction. " +
        "**Idempotent** — if a Profile already exists for this `supabaseUserId` it is returned with 200 instead of 201. " +
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
    post: {
      tags: ["Invites"],
      summary: "Send an invite email",
      description:
        "Creates a `TenantInvite` (7-day TTL) and sends an email to the invitee via Resend. " +
        "Only one pending invite per email+tenant is allowed — 409 if a pending invite already exists. " +
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
        "Per-step completion (derived, not stored) plus `setupCompleted` and `allRequiredComplete`. Required steps: 1,2,3,4,6,7,8. Only step 5 (SMS Templates) is deferred.",
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
      description: "Upserts the BusinessSettings singleton. `businessName` is required.",
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
        "Returns the BusinessSettings singleton (read `paymentRule`, `debtHoldEnabled`, `vatInInvoices`, `gocardlessConnected`, `stripeConnected`). Open after setup completes.",
      responses: {
        "200": jsonResponse("BusinessSettings (or null).", nullableRef("BusinessSettings")),
        "401": ERR[401],
      },
    },
    post: {
      tags: ["Setup"],
      summary: "Step 2 — Payment Setup",
      description:
        "Upserts payment configuration on the BusinessSettings singleton. All fields optional; step 2 counts as complete once `paymentRule` is set. The GoCardless/Stripe connect actions are **Phase-1 stubs** (`gocardlessConnected`/`stripeConnected` are plain booleans — no real OAuth yet).",
      requestBody: jsonBody(ref("PaymentSetupInput")),
      responses: {
        "200": jsonResponse("The updated BusinessSettings.", ref("BusinessSettings")),
        "400": ERR[400],
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
        "Returns the BusinessSettings singleton (same row as step 1; read `defaultCycleLength` / `defaultWorkingDays`). Open after setup completes.",
      responses: {
        "200": jsonResponse("BusinessSettings (or null).", nullableRef("BusinessSettings")),
        "401": ERR[401],
      },
    },
    post: {
      tags: ["Setup"],
      summary: "Step 4 — Round Settings",
      description: "Upserts BusinessSettings. `defaultCycleLength` is required (days).",
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
      description: "Bulk-replaces all message templates with the posted array. Step complete when ≥1 template saved.",
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
        "Marks setup complete. Requires all non-deferred steps (1,2,3,4,6,7,8). After completion, mutating step endpoints return 403.",
      responses: {
        "200": jsonResponse("Final status (setupCompleted = true).", ref("SetupStatus")),
        "400": ERR[400], // required steps missing
        "401": ERR[401],
        "409": ERR[409], // already complete
      },
    },
  },

  // =====================================================================
  // Settings — post-completion editing (always open; no setup-complete lock)
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
        "Partial upsert of step-1 fields (businessName, phone, email, companyNumber, vatRegistered, vatRegistration, timezone, currency, defaultWorkingDays). Omitted = untouched; null clears. Does not touch round-settings fields.",
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
      description: "Returns the BusinessSettings singleton; read `defaultCycleLength` / `defaultWorkingDays`.",
      responses: {
        "200": jsonResponse("BusinessSettings (or null).", nullableRef("BusinessSettings")),
        "401": ERR[401],
      },
    },
    patch: {
      tags: ["Settings"],
      summary: "Update round settings (partial)",
      description: "Partial upsert of round fields only (`defaultCycleLength`, `defaultWorkingDays`).",
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
      description: "Updates `paymentRule` / `vatInInvoices` / `debtHoldEnabled` only. Does NOT touch the connect flags — use the connect endpoint for those.",
      requestBody: jsonBody(ref("PaymentRulesUpdateInput")),
      responses: {
        "200": jsonResponse("Updated BusinessSettings.", ref("BusinessSettings")),
        "400": ERR[400],
        "401": ERR[401],
        "403": ERR[403],
      },
    },
  },
  "/settings/payment/{provider}/connect": {
    parameters: [
      {
        name: "provider",
        in: "path",
        required: true,
        schema: { type: "string", enum: ["gocardless", "stripe"] },
      },
    ],
    post: {
      tags: ["Settings"],
      summary: "Connect a payment provider (Phase-1 stub)",
      description:
        "Phase-1 stub: flips the relevant *Connected boolean to true and returns `{ status: \"connected\" }`. No OAuth / no URL yet — a real `connectUrl` will come from GHL in Phase 2.",
      responses: {
        "200": jsonResponse("Connection result.", ref("ProviderConnectResponse")),
        "400": ERR[400],
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

  // =====================================================================
  // Customers (M2) — reads: any known role; mutations: ADMIN/MANAGER
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
        "Search + filter. `?search=` matches name/addressLine/postcode (case-insensitive contains); `?roundId=` filters by assigned round; `?status=` ∈ ACTIVE|PAUSED|CANCELLED|HOLD (HOLD is derived from paymentHold visits). Summary KPIs are business-wide (not filtered).",
      parameters: [
        { name: "search", in: "query", required: false, schema: { type: "string" } },
        { name: "roundId", in: "query", required: false, schema: { type: "string" } },
        { name: "status", in: "query", required: false, schema: { type: "string", enum: ["ACTIVE", "PAUSED", "CANCELLED", "HOLD"] } },
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

  // =====================================================================
  // Properties (M2)
  // =====================================================================
  "/properties": {
    post: {
      tags: ["Properties"],
      summary: "M6 — Add Property (creates Customer + Property + ServicePlan, atomic)",
      description:
        "The only way customers are created (there is no POST /customers). `roundId: null` = Save & Assign Later (unassigned).",
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
      summary: "Update property (+ Move Round: assign/unassign)",
      requestBody: jsonBody(ref("PropertyUpdateInput")),
      responses: {
        "200": jsonResponse("Updated property.", ref("Property")),
        "400": ERR[400],
        "401": ERR[401],
        "403": ERR[403],
        "404": ERR[404],
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
      summary: "M9 — Pause Service (ServicePlan.status → PAUSED)",
      description: "409 if the plan is already PAUSED. `reason` is validated but not persisted (no column).",
      requestBody: jsonBody(ref("PauseServiceInput")),
      responses: {
        "200": jsonResponse("Updated ServicePlan.", { type: "object", additionalProperties: true }),
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
      description: "409 if the plan is not currently PAUSED.",
      responses: {
        "200": jsonResponse("Updated ServicePlan.", { type: "object", additionalProperties: true }),
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
      summary: "List notes (Notes & Risk), newest first",
      responses: {
        "200": jsonResponse("Notes.", { type: "array", items: ref("PropertyNote") }),
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
};

// ---------------------------------------------------------------------------
// 7. Assembled document.
// ---------------------------------------------------------------------------

// Swagger's "Execute" button targets the FIRST entry in `servers`. In a deployed
// environment we must point it at the public origin, not localhost. Resolution
// order: explicit PUBLIC_API_URL override → Railway's injected RAILWAY_PUBLIC_DOMAIN
// → (neither set, i.e. local dev) → localhost only. The deployed URL is listed
// first so it's the default; localhost stays available in the dropdown.
const PUBLIC_API_URL =
  process.env.PUBLIC_API_URL ??
  (process.env.RAILWAY_PUBLIC_DOMAIN
    ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
    : undefined);

const servers: OpenAPIV3.ServerObject[] = [
  ...(PUBLIC_API_URL ? [{ url: PUBLIC_API_URL, description: "Deployed" }] : []),
  { url: "http://localhost:3000", description: "Local dev" },
];

export const openApiDocument: OpenAPIV3.Document = {
  openapi: "3.0.3",
  info: {
    title: "RoundFlow API",
    version: "0.1.0",
    description: [
      "Backend API for RoundFlow (Phase 1). Frontend/backend contract.",
      "",
      "**Auth:** Supabase issues the token (login/signup happen there); this backend only",
      "**verifies** it. Every endpoint except `/health` requires",
      "`Authorization: Bearer <Supabase ES256 JWT>`.",
      "Get a token via **Auth › login**, then click **Authorize** (top-right).",
      "",
      "**Money fields** (`defaultPrice`, etc.) are returned as strings but sent as numbers.",
      "",
      "**Setup Wizard:** required steps are 1, 2, 3, 4, 6, 7, 8; only step 5 (SMS Templates) is a deferred stub.",
      "Phase 1 is single-tenant (one shared business config).",
    ].join("\n"),
  },
  servers,
  tags: [
    {
      name: "Auth",
      description:
        "Login (token minted by Supabase — external) and the current user's profile.",
    },
    { name: "Health", description: "Liveness." },
    { name: "Setup", description: "First-run Setup Wizard (8 steps)." },
    { name: "Settings", description: "Post-completion settings editing. Mutations (PATCH, POST, DELETE) require setup to be complete; GETs are always open." },
    { name: "Invites", description: "Tenant invite flow — send, validate, and accept invites for new technicians/managers." },
    { name: "Customers", description: "M2 — customer/property list + aggregate detail (Screens 14/15). Reads: any role; mutations: ADMIN/MANAGER." },
    { name: "Properties", description: "M2 — property create/update, pause/resume, notes (Add Property, M9, M20)." },
  ],
  // Global default: all operations require the Bearer token unless they
  // override with `security: []` (e.g. /health).
  security: [{ bearerAuth: [] }],
  paths,
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
