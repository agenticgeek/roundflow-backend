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
      bankDetails: { ...nullableRef("BankDetails"), description: "Printed in the invoice footer for bank transfer customers." },
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
      resolvedBy: { type: "string", nullable: true, description: "Profile id of the user who resolved it." },
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
    required: ["skippedNeedingReview", "failedPayments", "complaintRevisitsDue"],
    properties: {
      skippedNeedingReview: { type: "integer", description: "Visits skipped today.", example: 4 },
      failedPayments: { type: "integer", description: "Payments with status FAILED or OVERDUE.", example: 7 },
      complaintRevisitsDue: { type: "integer", description: "Open complaints with a revisit date on or before end of this week.", example: 2 },
    },
    example: { skippedNeedingReview: 4, failedPayments: 7, complaintRevisitsDue: 2 },
  },

  DashboardRoundRow: {
    type: "object",
    required: ["roundId", "roundName", "status", "total", "completed", "skipped", "issueCount", "paymentHolds", "value"],
    properties: {
      roundId: { type: "string" },
      roundName: { type: "string", example: "Alnwick Monday" },
      technicianId: { type: "string", nullable: true },
      technicianName: { type: "string", nullable: true, example: "James" },
      status: { type: "string", enum: ["not_started", "in_progress", "complete"], example: "in_progress" },
      total: { type: "integer", description: "Total visits in this round today.", example: 12 },
      completed: { type: "integer", example: 8 },
      skipped: { type: "integer", example: 1 },
      issueCount: { type: "integer", example: 1 },
      paymentHolds: { type: "integer", example: 0 },
      value: { type: "number", description: "Sum of prices for all visits in round today.", example: 220 },
      etaMinutes: { type: "integer", nullable: true, description: "Phase 2 stub — always null.", example: null },
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
      timeOnJobMinutes: { type: "integer", nullable: true, description: "Phase 2 stub — always null (no time-tracking schema yet).", example: null },
      strikes: { type: "integer", nullable: true, description: "Phase 2 stub — always null.", example: null },
      damages: { type: "integer", nullable: true, description: "Phase 2 stub — always null.", example: null },
      upsells: { type: "integer", nullable: true, description: "Phase 2 stub — always null.", example: null },
    },
    example: {
      technicianId: "t1",
      technicianName: "James",
      jobsCompleted: 42,
      valueCompleted: 840,
      openComplaints: 1,
      issueCount: 3,
      timeOnJobMinutes: null,
      strikes: null,
      damages: null,
      upsells: null,
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
      status: { type: "string", enum: ["SCHEDULED", "COMPLETED", "SKIPPED"], example: "SCHEDULED" },
      isOneOff: { type: "boolean", example: true },
      price: { type: "number", example: 45 },
      notes: { type: "string", nullable: true },
      paymentMethod: { type: "string", nullable: true, enum: ["GOCARDLESS", "STRIPE", "CASH", "BACS", "CHEQUE"] },
      propertyId: { type: "string" },
      addressLine: { type: "string", example: "12 Market Street" },
      postcode: { type: "string", example: "NE66 1SS" },
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
    required: ["updatedCount"],
    properties: { updatedCount: { type: "integer", description: "Visits whose technicianId was switched." } },
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
      value: { type: "number", description: "Sum of completed-visit prices for this round today; 0 until the first completion." },
      etaMinutes: { type: "integer", nullable: true, description: "remaining stops × 20; null once there's nothing left to do." },
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
    required: ["date", "dayClosed", "kpi", "rounds", "technicians"],
    properties: {
      date: { type: "string", format: "date" },
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
    required: ["status"],
    properties: { status: { type: "string", enum: ["sent"] } },
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
    },
  },

  SetupPropertyRowError: {
    type: "object",
    required: ["row", "field", "message"],
    properties: {
      row: { type: "integer", description: "0-based index into the submitted properties[] array." },
      field: { type: "string" },
      message: { type: "string" },
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
    required: ["totalOutstandings", "badDebt", "failedGoCardless", "dueBeforeClean", "holdNextClean"],
    properties: {
      totalOutstandings: { type: "number", description: "Sum of SENT invoice amounts, excluding bad-debt customers." },
      badDebt: { type: "number", description: "Sum of SENT invoice amounts for customers flagged badDebt." },
      failedGoCardless: { type: "integer" },
      dueBeforeClean: { type: "integer" },
      holdNextClean: { type: "integer", description: "Distinct customers currently on hold." },
    },
  },

  DebtBoardRow: {
    type: "object",
    required: ["invoiceId", "invoiceNumber", "amount", "customerId", "customerName", "addressLine", "badDebt", "holdNextClean"],
    properties: {
      invoiceId: { type: "string" },
      invoiceNumber: { type: "string" },
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
    required: ["id", "paymentUrl", "provider"],
    properties: {
      id: { type: "string", description: "The outbound Message record created for this link." },
      paymentUrl: { type: "string" },
      provider: { type: "string", enum: ["stripe", "static"], description: "stripe when a real Stripe Checkout session was created; static otherwise (falls back to the pay.roundflow.app link)." },
      expiresAt: { ...dateTime, nullable: true, description: "Set only when provider is stripe." },
    },
  },

  ReminderResult: {
    type: "object",
    required: ["id"],
    properties: { id: { type: "string", description: "The outbound Message record created for this reminder." } },
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
    },
    example: { businessName: "Northumberland Window Cleaning", currency: "GBP" },
  },

  RoundSettingsUpdateInput: {
    type: "object",
    description: "Partial update — round-settings fields only.",
    properties: {
      defaultCycleLength: { type: "integer", nullable: true, minimum: 1, maximum: 365, description: "Cycle length in days." },
      defaultWorkingDays: { type: "array", items: { type: "string", enum: ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"] } },
      preCleanReminderTimings: {
        type: "array",
        items: { type: "string", enum: ["EVENING_BEFORE", "TWO_HOURS_BEFORE"] },
        maxItems: 2,
        description: "Up to two reminder timings. Omit to leave unchanged.",
      },
    },
    example: { defaultCycleLength: 28, preCleanReminderTimings: ["EVENING_BEFORE", "TWO_HOURS_BEFORE"] },
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
      accessNotes: { type: "string", nullable: true },
      riskNotes: { type: "string", nullable: true },
      roundId: { type: "string", nullable: true, description: "null = Save & Assign Later (unassigned); an id must exist (404 if not)." },
    },
    example: { customerName: "John Smith", addressLine: "12 Market Street", postcode: "NE66 1SS", price: 35, serviceAreaId: "csa_example", cleanMethod: "Water Fed Pole", paymentMethod: "GOCARDLESS", roundId: null },
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
    },
    example: { technicianIds: ["t1", "t2"] },
  },

  ReassignTechnicianInput: {
    type: "object",
    required: ["fromTechnicianId", "toTechnicianId", "scope"],
    properties: {
      fromTechnicianId: { type: "string" },
      toTechnicianId: { type: "string", description: "Must be an active, invite-accepted technician." },
      scope: { type: "string", enum: ["remaining", "all"], description: "remaining = only today's SCHEDULED/IN_PROGRESS visits; all = also COMPLETED/SKIPPED." },
      note: { type: "string", nullable: true },
      notify: { type: "boolean", default: false },
    },
    example: { fromTechnicianId: "t1", toTechnicianId: "t2", scope: "remaining", notify: false },
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
      serviceAreaId: { type: "string", nullable: true, description: "Must exist (404 if not)." },
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
      serviceAreaId: { type: "string", nullable: true, description: "null clears all service areas; an id replaces with that single area (404 if it doesn't exist)." },
    },
  },

  // ---- Messages ----
  MessageSendInput: {
    type: "object",
    required: ["channel", "body"],
    description: "Either propertyId or customerId is required (a property resolves to its customer).",
    properties: {
      propertyId: { type: "string", nullable: true },
      customerId: { type: "string", nullable: true },
      channel: { type: "string", enum: ["sms", "email", "whatsapp"], description: "Case-insensitive." },
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
    required: ["channel", "message"],
    properties: {
      channel: ref("MessageChannel"),
      message: { type: "string", minLength: 1 },
    },
    example: { channel: "SMS", message: "Reminder: invoice INV-2026-004 is overdue." },
  },

  DebtPaymentLinkInput: {
    type: "object",
    required: ["message"],
    description: "Creates a real Stripe Checkout session if Stripe is connected and the invoice isn't PAID/VOID; otherwise falls back to the static pay.roundflow.app link. Requires the customer to have an email address.",
    properties: {
      message: { type: "string", minLength: 1 },
    },
    example: { message: "Here's your payment link for INV-2026-004." },
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
      sendEmail: { type: "boolean", default: false, description: "Accepted but not yet wired to actual delivery (GHL outbox is stubbed)." },
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
    },
    example: { price: 40, cleaningFrequency: "SIX_WEEKLY" },
  },

  // ---- Complaints (step-9/resolve update) ----
  ResolveComplaintInput: {
    type: "object",
    description: "Optional resolution notes, persisted alongside resolvedAt/resolvedBy.",
    properties: {
      notes: { type: "string", nullable: true },
    },
    example: { notes: "Returned next day; customer confirmed satisfied." },
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
        "Creates a `TenantInvite` (7-day TTL) and sends an email to the invitee via Supabase Auth. " +
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
      parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
      requestBody: jsonBody(ref("ScheduleRevisitInput")),
      responses: {
        "200": jsonResponse("Updated complaint.", ref("Complaint")),
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
      description: "Sets resolvedAt (now) and resolvedBy (the calling user's Profile id). Optional `notes` body field is persisted alongside them.",
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
        "One row per active technician with jobs completed, value completed, open complaints, and issue count for the requested period. Phase-2 fields (timeOnJobMinutes, strikes, damages, upsells) are always null. ADMIN/MANAGER only.",
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
      summary: "Replace the round's technician list",
      description: "Full replace semantics — send the complete list you want to keep. An empty array clears all assignments. Every id must reference an active, invite-accepted technician (400 otherwise); unknown ids 404.",
      requestBody: jsonBody(ref("SetRoundTechniciansInput")),
      responses: {
        "200": jsonResponse("Updated round.", ref("RoundDetail")),
        "400": ERR[400],
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
      summary: "Reassign technician for today's visits (M15)",
      description:
        "Bulk-moves today's visits on this round from `fromTechnicianId` to `toTechnicianId`. `scope: \"remaining\"` only touches SCHEDULED/IN_PROGRESS visits; `\"all\"` also includes COMPLETED/SKIPPED. 409 if the operational day has already been closed.",
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

  // =====================================================================
  // Messages — direct GoHighLevel-backed send (single customer or bulk to
  // a round). ADMIN/MANAGER only.
  // =====================================================================
  "/messages/send": {
    post: {
      tags: ["Messages"],
      summary: "Send one message to a single customer",
      description: "Resolves the customer by `customerId`, or by `propertyId` (looked up to its property's customer) — one of the two is required. 409 if GoHighLevel isn't connected.",
      requestBody: jsonBody(ref("MessageSendInput")),
      responses: {
        "201": jsonResponse("Sent.", ref("MessageSendResult")),
        "400": ERR[400],
        "401": ERR[401],
        "403": ERR[403],
        "404": errorResponse("Property or customer not found.", "Customer not found"),
        "409": errorResponse("GoHighLevel is not connected.", "GoHighLevel is not connected"),
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
        "One-time setup property creation — does not reuse POST /properties. Call multiple times to add multiple properties. `roundId` is required (and must reference an ACTIVE round) so the property counts toward step 9/10 completion.",
      requestBody: jsonBody(ref("SetupPropertyInput")),
      responses: {
        "201": jsonResponse("Created property.", ref("SetupPropertyResult")),
        "400": ERR[400],
        "401": ERR[401],
        "403": ERR[403],
      },
    },
  },

  "/setup/step/9/bulk": {
    post: {
      tags: ["Setup"],
      summary: "Step 9 — bulk import properties",
      description:
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
        "Generates the initial batch of SCHEDULED visits for every property on the targeted round(s), from `startDate` through `startDate + cycleWeeks`. `startDate` must be today or later. 409 if the system is already activated (setup already complete); 404 if `generateAll: false` and none of the given `roundIds` matched an ACTIVE round.",
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
        "`bucket` is required. The 6 named buckets are mutually exclusive by construction; anything else (including the literal `ALL`) falls into the catch-all \"everything not in the other buckets\" bucket.",
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
      summary: "Send a payment reminder",
      description: "Sends `message` over `channel` and logs it as an outbound Message. 400 if `channel` is EMAIL and the customer has no email address.",
      requestBody: jsonBody(ref("DebtRemindInput")),
      responses: {
        "200": jsonResponse("Reminder sent.", ref("ReminderResult")),
        "400": ERR[400],
        "401": ERR[401],
        "403": ERR[403],
        "404": ERR[404],
      },
    },
  },

  "/debt/{id}/payment-link": {
    parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" }, description: "Invoice id." }],
    post: {
      tags: ["Debt"],
      summary: "Send a payment link",
      description:
        "Creates a real Stripe Checkout session (reusing an existing PENDING one for this invoice if present) when Stripe is connected and the invoice isn't PAID/VOID; otherwise falls back to the static pay.roundflow.app link. Requires the customer to have an email address.",
      requestBody: jsonBody(ref("DebtPaymentLinkInput")),
      responses: {
        "200": jsonResponse("Payment link sent.", ref("PaymentLinkResult")),
        "400": errorResponse("message is required, or the customer has no email address.", "message is required"),
        "401": ERR[401],
        "403": ERR[403],
        "404": ERR[404],
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
      description: "`reason`/`date`/`notify`/`message` are only meaningful when `flag` is true. `notify: true` sends an SMS (best-effort — a send failure is logged, not surfaced as an error).",
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
        { name: "period", in: "query", required: false, schema: { type: "string", enum: ["today", "last7", "last30"], default: "last30" } },
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
        { name: "period", in: "query", required: false, schema: { type: "string", enum: ["today", "last7", "last30"], default: "last30" } },
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
        { name: "period", in: "query", required: false, schema: { type: "string", enum: ["today", "last7", "last30"], default: "last30" } },
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
        { name: "period", in: "query", required: false, schema: { type: "string", enum: ["today", "last7", "last30"], default: "last30" } },
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
        { name: "period", in: "query", required: false, schema: { type: "string", enum: ["today", "last7", "last30"], default: "last30" } },
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
      description: "Computed live from the visit — nothing is persisted. 409 if the visit already has an invoice.",
      parameters: [{ name: "visitId", in: "query", required: true, schema: { type: "string" } }],
      responses: {
        "200": jsonResponse("Invoice preview.", ref("InvoicePreview")),
        "400": errorResponse("visitId query param is required.", "visitId query param is required"),
        "401": ERR[401],
        "403": ERR[403],
        "404": ERR[404],
        "409": errorResponse("Visit already has an invoice.", "Visit already has an invoice"),
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
        "409": errorResponse("Visit already has an invoice.", "Visit already has an invoice"),
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
    post: {
      tags: ["Invoices"],
      summary: "Create (save) an invoice for a visit",
      description: "409 if the visit already has an invoice.",
      requestBody: jsonBody(ref("InvoiceCreateInput")),
      responses: {
        "201": jsonResponse("Created invoice.", ref("InvoiceActionResult")),
        "400": errorResponse("visitId is required.", "visitId is required"),
        "401": ERR[401],
        "403": ERR[403],
        "404": ERR[404],
        "409": errorResponse("Visit already has an invoice.", "Visit already has an invoice"),
      },
    },
  },

  "/invoices/{id}/send": {
    parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
    post: {
      tags: ["Invoices"],
      summary: "Send an invoice to the customer",
      description: "Marks the invoice SENT. 400 if the customer has no email address; 409 if it's already SENT.",
      responses: {
        "200": jsonResponse("Updated invoice.", ref("InvoiceActionResult")),
        "400": errorResponse("Customer has no email address.", "Customer has no email address — cannot send invoice"),
        "401": ERR[401],
        "403": ERR[403],
        "404": ERR[404],
        "409": errorResponse("Invoice has already been sent.", "Invoice has already been sent"),
      },
    },
  },

  // =====================================================================
  // Payments — Stripe Checkout session creation (one-time payment, and
  // card-on-file setup). ADMIN/MANAGER only.
  // =====================================================================
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
      description: "Price, clean method, payment method, cleaning frequency.",
      requestBody: jsonBody(ref("ServicePlanUpdateInput")),
      responses: {
        "200": jsonResponse("Updated service plan.", ref("ServicePlan")),
        "400": ERR[400],
        "401": ERR[401],
        "403": ERR[403],
        "404": ERR[404],
      },
    },
  },

  "/service-plans/{id}/pause": {
    parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
    post: {
      tags: ["Service Plans"],
      summary: "Pause a service plan",
      description: "Mirrors POST /properties/{id}/pause. `reason` is required by the UI but not persisted (no column).",
      requestBody: jsonBody(ref("PauseServiceInput")),
      responses: {
        "200": jsonResponse("Paused service plan.", ref("ServicePlan")),
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
      responses: {
        "200": jsonResponse("Resumed service plan.", ref("ServicePlan")),
        "401": ERR[401],
        "403": ERR[403],
        "404": ERR[404],
        "409": errorResponse("Service plan is not paused.", "Service plan is not paused"),
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
    { name: "Setup", description: "First-run Setup Wizard (12 steps)." },
    { name: "Settings", description: "Post-completion settings editing. Mutations (PATCH, POST, DELETE) require setup to be complete; GETs are always open." },
    { name: "Invites", description: "Tenant invite flow — send, validate, and accept invites for new technicians/managers." },
    { name: "Customers", description: "M2 — customer/property list + aggregate detail (Screens 14/15). Reads: any role; mutations: ADMIN/MANAGER." },
    { name: "Properties", description: "M2 — property create/update, pause/resume, notes (Add Property, M9, M20)." },
    { name: "Visits", description: "One-off (ad-hoc) visit creation. Reads: any role; mutations: ADMIN/MANAGER." },
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
    { name: "Payments", description: "Stripe Checkout session creation — one-time invoice payment and card-on-file setup. ADMIN/MANAGER only." },
    { name: "Service Plans", description: "Per-plan price/method/frequency edits and pause/resume, targeting one ServicePlan directly by id. ADMIN/MANAGER only." },
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
