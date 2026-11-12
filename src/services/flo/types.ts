import type { TenantPrismaClient } from "../../lib/tenant-prisma-manager";

// Shared types for Flo AI (admin-only, read-only assistant). Types only: nothing here runs, so this file is not in the
// coverage gate. The orchestrator, answer builder and SSE service build on these shapes.

// ---- modes ------------------------------------------------------------------

export type Mode = "THOROUGH" | "BALANCED" | "QUICK";

export interface ModeConfig {
  key: Mode;
  label: string;
  description: string;
  model: string;
  maxRounds: number;
  maxOutputTokens: number;
  maxTables: number;
  maxCards: number;
  maxInsights: number;
  maxIntroSentences: number;
}

// ---- tools ------------------------------------------------------------------

/** v1 has one member. The customer agent later adds `{ scope: "CUSTOMER"; customerId }` (plan 3.4). */
export type ToolContext = {
  scope: "ADMIN";
  tenantPrisma: TenantPrismaClient;
  profileId: string;
  /** Injectable clock for tests; defaults to `new Date()`. */
  now?: Date;
};

export type ColumnFormat = "text" | "integer" | "currency" | "percent" | "date";

export interface ResultColumn {
  key: string;
  label: string;
  format: ColumnFormat;
  align: "left" | "right";
}

export type CellValue = string | number | boolean | null;
export type ResultRow = Record<string, CellValue>;

export interface ToolDateRange {
  /** YYYY-MM-DD, tenant-local. */
  from: string;
  to: string;
  label: string;
}

/** What a tool returns (the registry adds `sourceId`). Money is decimal pounds (GBP), never pence. */
export interface ToolResult {
  sourceId: string;
  tool: string;
  label: string;
  dateRange: ToolDateRange | null;
  rows: ResultRow[];
  totals: ResultRow | null;
  truncated: boolean;
  columns: ResultColumn[];
}

export type ToolOutput = Omit<ToolResult, "sourceId" | "tool" | "label">;

export const TOOL_NAMES = [
  "get_day_overview",
  "list_rounds_due",
  "list_debtors",
  "list_payments",
  "compare_technicians",
  "list_complaints",
  "list_at_risk_customers",
  "revenue_summary",
  "list_skipped_visits",
  "get_customer_summary",
] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

export interface ToolDefinition<A = unknown> {
  name: ToolName;
  /** Short human label for the "Checking: ..." status line and `sources`. */
  label: string;
  description: string;
  /** JSON Schema sent to the provider as `input_schema`. */
  inputSchema: { type: "object"; properties: Record<string, unknown>; required?: string[]; additionalProperties: false };
  /** Every tool is read-only. Typed as `true` so a write tool cannot be registered. */
  readOnly: true;
  /** Validates the raw model input; throws ToolInputError (a message the model can act on). */
  parse(raw: unknown): A;
  run(args: A, ctx: ToolContext): Promise<ToolOutput>;
}

/** executeTool never throws. args = the validated arguments (for the audit trail), ms = the run time. */
export type ToolOutcome =
  | { ok: true; result: ToolResult; args: unknown; ms: number }
  | { ok: false; error: string; args?: unknown; ms: number };

export interface ToolSpec {
  name: string;
  description: string;
  input_schema: ToolDefinition["inputSchema"];
}

// ---- provider (Anthropic) wrapper interface ---------------------------------------

export type ProviderContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };

export interface ProviderMessage {
  role: "user" | "assistant";
  content: string | ProviderContentBlock[];
}

export interface ProviderRequest {
  model: string;
  /** Stable system prompt. Sent with a cache breakpoint when `cache` is true (default true). */
  system: string;
  messages: ProviderMessage[];
  tools?: ToolSpec[];
  maxTokens: number;
  /** Aborts the call (client disconnect, whole-request budget). The wrapper also applies its own timeout. */
  signal?: AbortSignal;
  /** Cache the system prompt and tool definitions (default true). */
  cache?: boolean;
}

export interface ProviderUsage {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
}

export type ProviderStopReason = "end_turn" | "tool_use" | "max_tokens" | "refusal" | "other";

export interface ProviderResponse {
  content: ProviderContentBlock[];
  stopReason: ProviderStopReason;
  usage: ProviderUsage;
  model: string;
}

export type ProviderStreamEvent =
  | { type: "text_delta"; text: string }
  /** A complete tool call (input already parsed). Emitted when its content block finishes. */
  | { type: "tool_use"; id: string; name: string; input: unknown }
  /** Always the last event of a successful stream. */
  | { type: "message_end"; stopReason: ProviderStopReason; usage: ProviderUsage; content: ProviderContentBlock[] };

export interface ProviderClient {
  createMessage(req: ProviderRequest): Promise<ProviderResponse>;
  streamMessage(req: ProviderRequest): AsyncGenerator<ProviderStreamEvent, void, void>;
}

export type ProviderErrorCode = "PROVIDER_UNAVAILABLE" | "PROVIDER_TIMEOUT" | "PROVIDER_ABORTED" | "PROVIDER_REJECTED";

// ---- scope gate -------------------------------------------------------------------

export const SCOPE_VERDICTS = ["IN_SCOPE", "OUT_OF_SCOPE", "WRITE_REQUEST", "CAPABILITY_QUESTION", "UNSAFE"] as const;
export type ScopeVerdict = (typeof SCOPE_VERDICTS)[number];

export type DeclineReason = "OUT_OF_SCOPE" | "WRITE_REQUEST" | "UNSAFE" | "NO_DATA_USED" | "CAPABILITY";

export interface ScopeDecision {
  verdict: ScopeVerdict;
  /** "precheck" = decided without a model call; "classifier" = Haiku verdict; "fail_closed" = classifier error or garbage. */
  source: "precheck" | "classifier" | "fail_closed";
}

export interface DeclineCopy {
  reason: DeclineReason;
  text: string;
  suggestions: string[];
}
