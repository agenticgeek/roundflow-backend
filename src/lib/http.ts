import { NextFunction, Request, Response } from "express";
import { AppError } from "./app-error";

// Shared HTTP route helpers used by both the /setup and /settings routers.
// These were previously duplicated (with divergent names) in each router; they
// live here so a fix lands in exactly one place. Domain-specific validators
// (validateWorkingDays, assertPositiveInt, optCategory, optPaymentTiming, etc.)
// deliberately stay in their routers — only the generic plumbing lives here.

// ---- async error forwarding ----------------------------------------------

// Forward async errors to the centralised error handler (Express 4 doesn't
// auto-catch rejected promises).
export type Handler = (req: Request, res: Response) => Promise<unknown>;
export const h =
  (fn: Handler) => (req: Request, res: Response, next: NextFunction) =>
    fn(req, res).catch(next);

// ---- body shape coercion --------------------------------------------------

export function asObject(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new AppError(400, "Request body must be a JSON object.");
  }
  return body as Record<string, unknown>;
}

// Accept either a raw array body or `{ [key]: [...] }`.
export function asArray<T>(body: unknown, key: string): T[] {
  if (Array.isArray(body)) return body as T[];
  if (body && typeof body === "object" && Array.isArray((body as Record<string, unknown>)[key])) {
    return (body as Record<string, unknown>)[key] as T[];
  }
  throw new AppError(400, `Expected an array (raw, or under "${key}").`);
}

// ---- required validators (for create bodies) ------------------------------

export function requireString(v: unknown, field: string): string {
  if (typeof v !== "string" || v.trim() === "") {
    throw new AppError(400, `"${field}" is required and must be a non-empty string.`);
  }
  return v;
}

export function requireNumber(v: unknown, field: string): number {
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new AppError(400, `"${field}" is required and must be a number.`);
  }
  return v;
}

// ---- optional validators (for partial updates) ----------------------------
// undefined = omitted (untouched). `null` clears a nullable field; the `*Req*`
// variants reject null.

export function optString(v: unknown, field: string): string | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v === "string") return v;
  throw new AppError(400, `"${field}" must be a string or null.`);
}

// Returns undefined if value is absent, null if value is null or "",
// or the string value if non-empty. Use for optional FK id fields where
// an empty string must be treated as "no value", not a literal id.
export function optId(value: unknown, field: string): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  if (typeof value !== "string") throw new AppError(400, `${field} must be a string`);
  return value;
}

export function optReqString(v: unknown, field: string): string | undefined {
  if (v === undefined) return undefined;
  if (typeof v === "string" && v.trim() !== "") return v;
  throw new AppError(400, `"${field}" must be a non-empty string.`);
}

export function optBool(v: unknown, field: string): boolean | undefined {
  if (v === undefined) return undefined;
  if (typeof v === "boolean") return v;
  throw new AppError(400, `"${field}" must be a boolean.`);
}

export function optNumber(v: unknown, field: string): number | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  throw new AppError(400, `"${field}" must be a number or null.`);
}

export function optReqNumber(v: unknown, field: string): number | undefined {
  if (v === undefined) return undefined;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  throw new AppError(400, `"${field}" must be a number.`);
}

export function optStringArray(v: unknown, field: string): string[] | undefined {
  if (v === undefined) return undefined;
  if (Array.isArray(v) && v.every((x) => typeof x === "string")) return v as string[];
  throw new AppError(400, `"${field}" must be an array of strings.`);
}

// ---- pagination -------------------------------------------------------------
// Shared page/pageSize parsing for list endpoints. Previously each route
// (customers, debt board) re-derived page/pageSize with its own inline
// Number(...) + isFinite check and its own Math.max/min clamp in the service
// layer — none of which rejected a fractional value like "1.5", which then
// reached Prisma's skip/take as a non-integer and surfaced as an unhandled
// 500 instead of a clean 400.

function parsePositiveIntParam(raw: unknown, field: string, fallback: number): number {
  if (raw === undefined) return fallback;
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new AppError(400, `"${field}" must be a positive integer.`);
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new AppError(400, `"${field}" must be a positive integer.`);
  }
  return n;
}

/** Parse `page`/`pageSize` from a route's `req.query`, validating both are
 *  positive integers (not just finite numbers) and clamping pageSize to
 *  `maxPageSize`. Returns a ready-to-use `skip` alongside the validated
 *  page/pageSize so callers don't re-derive or re-clamp it themselves. */
export function parsePageParams(
  query: Record<string, unknown>,
  opts?: { defaultPageSize?: number; maxPageSize?: number }
): { page: number; pageSize: number; skip: number } {
  const maxPageSize = opts?.maxPageSize ?? 100;
  const defaultPageSize = Math.min(opts?.defaultPageSize ?? 50, maxPageSize);

  const page = parsePositiveIntParam(query.page, "page", 1);
  const pageSize = Math.min(
    parsePositiveIntParam(query.pageSize, "pageSize", defaultPageSize),
    maxPageSize
  );

  return { page, pageSize, skip: (page - 1) * pageSize };
}

