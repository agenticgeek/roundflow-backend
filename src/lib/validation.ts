import { DayOfWeek, PaymentMethod, NoteType } from "../generated/tenant-client";
import { AppError } from "./app-error";

// Shared request-value validators used by both the /setup and /settings routers,
// so a fix lands in one place (see PR review §9 for the wider dedup this seeds).

/** Validate every element of a working-days array against the DayOfWeek enum.
 *  Returns the array unchanged; throws AppError(400) on the first invalid value.
 *  Also catches non-string elements (a number is not a valid enum member). */
export function validateWorkingDays(days: unknown[]): string[] {
  const valid = Object.values(DayOfWeek) as string[];
  for (const val of days) {
    if (typeof val !== "string" || !valid.includes(val)) {
      throw new AppError(
        400,
        `Invalid working day: ${String(val)}. Must be one of: ${valid.join(", ")}`
      );
    }
  }
  return days as string[];
}

/** Assert a numeric value is a positive integer (e.g. a cycle length in days).
 *  Returns it unchanged; throws AppError(400) otherwise. */
export function assertPositiveInt(v: number, field: string): number {
  if (!Number.isInteger(v) || v <= 0) {
    throw new AppError(400, `${field} must be a positive integer`);
  }
  return v;
}

// ---- M2 (Customers & Properties) domain validators ------------------------
// Shared by the /customers and /properties routers.

/** Assert a numeric value is a positive number (e.g. a Decimal price). Allows
 *  non-integers (£35.50); throws AppError(400) otherwise. */
export function assertPositive(v: number, field: string): number {
  if (!Number.isFinite(v) || v <= 0) {
    throw new AppError(400, `${field} must be a positive number`);
  }
  return v;
}

/** Parse a required ISO date string → Date; throws AppError(400) if invalid. */
export function parseIsoDate(v: unknown, field: string): Date {
  if (typeof v !== "string" || v.trim() === "") {
    throw new AppError(400, `"${field}" is required and must be an ISO date string.`);
  }
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) {
    throw new AppError(400, `"${field}" must be a valid ISO date.`);
  }
  return d;
}

/** Optional ISO date: undefined = omitted, null = clear, else parse. */
export function optIsoDate(v: unknown, field: string): Date | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  return parseIsoDate(v, field);
}

/** Optional PaymentMethod: undefined = omitted, null = clear, else validate. */
export function optPaymentMethod(v: unknown): PaymentMethod | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v === "string" && (Object.values(PaymentMethod) as string[]).includes(v)) {
    return v as PaymentMethod;
  }
  throw new AppError(400, `Invalid paymentMethod: ${String(v)}`);
}

/** Required NoteType (INTERNAL | RISK_WARNING | CUSTOMER). */
export function requireNoteType(v: unknown): NoteType {
  if (typeof v === "string" && (Object.values(NoteType) as string[]).includes(v)) {
    return v as NoteType;
  }
  throw new AppError(400, `"type" must be one of: ${Object.values(NoteType).join(", ")}`);
}
