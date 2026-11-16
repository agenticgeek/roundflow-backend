// Business closures: the API contract types (2026-11-16). CANONICAL COPY: this file is copied VERBATIM into
//   roundflow-frontend/src/features/closures/types.ts   and   roundflow-e2e/src/scn/closure-types.ts
// (no cross-repo imports). Change it here, then copy; never edit a copy alone.
// Rules: roundflow-backend/docs/handoff/backend/2026-11-16-closure-rules.md. Endpoints: ...-business-closures-backend-plan.md s4.
// No imports and no runtime code on purpose, so the copies stay identical.

/** YYYY-MM-DD, a calendar day (no time of day). */
export type IsoDate = string;

export type ClosureMode = "MOVE" | "SKIP";

export interface Closure {
  id: string;
  /** Free text, 1 to 80 characters, trimmed. */
  label: string;
  startDate: IsoDate;
  /** Inclusive; >= startDate; at most 366 days after startDate (inclusive count). */
  endDate: IsoDate;
  mode: ClosureMode;
  notifyCustomers: boolean;
  /** Empty = every round. */
  roundIds: string[];
  /** Last successful "apply to existing visits", or null. */
  appliedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** POST /closures */
export interface ClosureCreateInput {
  label: string;
  startDate: IsoDate;
  endDate: IsoDate;
  mode: ClosureMode;
  notifyCustomers?: boolean;
  roundIds?: string[];
}

/** PATCH /closures/:id (any subset). */
export type ClosureUpdateInput = Partial<ClosureCreateInput>;

/** GET /closures?from=&to= */
export interface ClosureListResult {
  closures: Closure[];
}

export type ClosureTechnicianConflictReason = "TECHNICIAN_UNAVAILABLE" | "TECHNICIAN_INACTIVE";

export interface ClosureConflict {
  visitId: string;
  technicianId: string;
  reason: ClosureTechnicianConflictReason;
}

/** One entry per (round, from, to). `to` is null for SKIP. Groups, never one row per visit. */
export interface ClosurePreviewGroup {
  from: IsoDate;
  to: IsoDate | null;
  count: number;
}

export interface ClosurePreviewRound {
  roundId: string;
  roundName: string;
  visitCount: number;
  groups: ClosurePreviewGroup[];
}

/** POST /closures/:id/apply/preview (no writes) */
export interface ClosureApplyPreview {
  closureId: string;
  mode: ClosureMode;
  totals: { visits: number; rounds: number; customers: number; technicianConflicts: number };
  rounds: ClosurePreviewRound[];
  conflicts: ClosureConflict[];
  /** The message customers would receive (default text for the mode). */
  customerMessage: string;
}

/** POST /closures/:id/apply body */
export interface ClosureApplyInput {
  /** Defaults to the closure's own notifyCustomers. */
  notifyCustomers?: boolean;
}

/** POST /closures/:id/apply */
export interface ClosureApplyResult {
  closureId: string;
  mode: ClosureMode;
  moved: number;
  skipped: number;
  conflicts: ClosureConflict[];
  notifiedTechnicians: number;
  notifiedCustomers: number;
  /** Set when customers were to be told but that step failed; the visits ARE already changed. */
  customerNotificationError?: string;
  appliedAt: string;
}

/** Non-blocking warning on PATCH /visits/:id/reschedule, POST /visits/carryover and the carryover options. */
export interface ClosureWarning {
  code: "DATE_IN_CLOSURE";
  closureId: string;
  label: string;
  startDate: IsoDate;
  endDate: IsoDate;
}

/** Stable error `code` values returned by the closures endpoints (HTTP status in the comment). */
export type ClosureErrorCode =
  | "VALIDATION_FAILED" // 400
  | "INVALID_CLOSURE_RANGE" // 400 end before start, longer than 366 days, or ends in the past
  | "UNKNOWN_ROUND" // 400 an id in roundIds does not exist
  | "CLOSURE_NOT_FOUND" // 404
  | "CLOSURE_ENDED" // 409 apply on a closure entirely in the past
  | "CLOSURE_RESOLUTION_LIMIT"; // 500 internal guard: more than 400 chained closures

export const CLOSURE_LABEL_MAX = 80;
export const CLOSURE_MAX_DAYS = 366;
