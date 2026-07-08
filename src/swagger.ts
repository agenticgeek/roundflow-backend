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
      defaultWorkingDays: { type: "array", items: { type: "string" } },
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
    description: "A geographic service area. Note: no updatedAt field.",
    properties: {
      id: { type: "string" },
      name: { type: "string" },
      postcodeSector: { type: "string", nullable: true },
      isDefault: { type: "boolean" },
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

  StepStatus: {
    type: "object",
    required: ["step", "complete", "deferred"],
    properties: {
      step: { type: "integer", minimum: 1, maximum: 8 },
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
      defaultWorkingDays: { type: "array", items: { type: "string" } },
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
      defaultWorkingDays: { type: "array", items: { type: "string" } },
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
      defaultWorkingDays: { type: "array", items: { type: "string" } },
    },
    example: { businessName: "Northumberland Window Cleaning", currency: "GBP" },
  },

  RoundSettingsUpdateInput: {
    type: "object",
    description: "Partial update — round-settings fields only.",
    properties: {
      defaultCycleLength: { type: "integer", nullable: true, description: "Cycle length in days." },
      defaultWorkingDays: { type: "array", items: { type: "string" } },
    },
    example: { defaultCycleLength: 28 },
  },

  ServiceCreateInput: {
    type: "object",
    required: ["name", "defaultPrice"],
    properties: {
      name: { type: "string", minLength: 1 },
      defaultPrice: { type: "number", description: "Sent as a number; returned as a string." },
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
      defaultPrice: { type: "number" },
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
    'Setup cannot be completed — required steps incomplete: 3, 4, 6, 7, 8'
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

  // ---- Auth — login (token minted by Supabase, external) ----
  "/auth/v1/token": {
    post: {
      tags: ["Auth"],
      summary: "login",
      description:
        "**External Supabase Auth (GoTrue) endpoint — NOT part of the RoundFlow backend.** " +
        "Returns an `access_token` (ES256 JWT). Copy it into **Authorize** (top-right) to call the " +
        "protected endpoints below. The `apikey` header is the Supabase anon (publishable) key, prefilled here.",
      servers: [{ url: SUPABASE_URL, description: "Supabase Auth (GoTrue)" }],
      security: [], // this endpoint is authenticated by the apikey header, not a Bearer token
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
          required: true,
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
      },
    },
  },

  // ---- Auth ----
  "/auth/me": {
    get: {
      tags: ["Auth"],
      summary: "Current user's profile",
      description:
        "Returns the Profile for the authenticated caller (looked up by supabaseUserId from the JWT `sub`). 404 if no Profile exists.",
      responses: {
        "200": jsonResponse("The caller's Profile.", ref("Profile")),
        "404": errorResponse("No Profile for this user.", "Profile not found"),
        "401": ERR[401],
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

  // ---- Setup: Step 5 — SMS Templates (deferred) ----
  "/setup/step/5": {
    get: {
      tags: ["Setup"],
      summary: "Step 5 — SMS Templates (deferred)",
      responses: { "200": jsonResponse("Deferred stub.", ref("DeferredStub")) },
    },
    post: {
      tags: ["Setup"],
      summary: "Step 5 — SMS Templates (deferred, no-op)",
      description: "Deferred stub — performs no DB write.",
      responses: deferredResponses(),
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
        "Marks setup complete. Requires all non-deferred steps (1,3,4,6,7,8). After completion, mutating step endpoints return 403.",
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
      summary: "SMS templates (deferred)",
      description: "Deferred — GHL owns messaging in Phase 2. No DB access.",
      responses: {
        "200": jsonResponse("Deferred stub.", ref("MessageTemplateDeferred")),
        "401": ERR[401],
      },
    },
    patch: {
      tags: ["Settings"],
      summary: "SMS templates (deferred, no-op)",
      description: "Deferred — returns the same payload, performs no DB write.",
      responses: {
        "200": jsonResponse("Deferred stub.", ref("MessageTemplateDeferred")),
        "401": ERR[401],
        "403": ERR[403],
      },
    },
  },
};

// ---------------------------------------------------------------------------
// 7. Assembled document.
// ---------------------------------------------------------------------------

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
      "**Setup Wizard:** required steps are 1, 3, 4, 6, 7, 8; steps 2 & 5 are deferred stubs.",
      "Phase 1 is single-tenant (one shared business config).",
    ].join("\n"),
  },
  servers: [
    { url: "http://localhost:3000", description: "Local dev" },
    // Add your tunnel/staging/prod origin here, e.g.:
    // { url: "https://<subdomain>.loca.lt", description: "localtunnel" },
  ],
  tags: [
    {
      name: "Auth",
      description:
        "Login (token minted by Supabase — external) and the current user's profile.",
    },
    { name: "Health", description: "Liveness." },
    { name: "Setup", description: "First-run Setup Wizard (8 steps)." },
    { name: "Settings", description: "Post-completion settings editing. Mutations (PATCH, POST, DELETE) require setup to be complete; GETs are always open." },
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
