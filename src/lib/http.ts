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
  if (body && typeof body === "object" && Array.isArray((body as any)[key])) {
    return (body as any)[key] as T[];
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
