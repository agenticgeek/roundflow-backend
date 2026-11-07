import { DayOfWeek, PaymentMethod, NoteType, CleaningFrequency, RoundStatus, MessageChannel, PropertyType } from "../generated/tenant-client";
import { AppError, ValidationError } from "./app-error";

// Shared request-value validators used by both the /setup and /settings routers,
// so a fix lands in one place (see PR review §9 for the wider dedup this seeds).

// ---- Shared max-length limits -----------------------------------------------
// Name/address/postcode/notes fields previously had no upper bound anywhere in
// the stack (DB columns are plain unconstrained `text`, and requireString/
// optString only checked type + non-empty) — an arbitrarily long value would
// be accepted, stored, and could break list/detail layouts on the frontend.
// These are business-reasonable limits, not DB constraints; passed as
// `{ maxLength }` to requireString/optString/optReqString at each call site.
export const MAX_NAME_LENGTH = 255; // person/business/technician/property names
export const MAX_ADDRESS_LENGTH = 255; // address lines, postcodes
export const MAX_NOTES_LENGTH = 2000; // free-text notes (access/risk notes, etc.)

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
export function assertPositive(v: number, field: string, max?: number): number {
  if (!Number.isFinite(v) || v <= 0) {
    throw new AppError(400, `${field} must be a positive number`);
  }
  if (max !== undefined && v > max) {
    throw new AppError(400, `${field} must not exceed ${max}`);
  }
  return v;
}

/** Assert a numeric value is zero or positive (e.g. a defaultPrice for free services). */
export function assertNonNegative(v: number, field: string, max?: number): number {
  if (!Number.isFinite(v) || v < 0) {
    throw new AppError(400, `${field} must be zero or a positive number`);
  }
  if (max !== undefined && v > max) {
    throw new AppError(400, `${field} must not exceed ${max}`);
  }
  return v;
}

/** True when year/month/day is a real calendar date (Date.UTC would silently roll 2026-02-30 over to March). */
function isRealCalendarDate(year: number, month: number, day: number): boolean {
  const d = new Date(Date.UTC(year, month - 1, day));
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
}

/** Parse a required ISO date string → Date; throws AppError(400) if invalid. A leading YYYY-MM-DD must be a real
 *  calendar date: 2026-02-29 and 2026-04-31 are rejected, never rolled over (BUG-007). */
export function parseIsoDate(v: unknown, field: string): Date {
  if (typeof v !== "string" || v.trim() === "") {
    throw new AppError(400, `"${field}" is required and must be an ISO date string.`);
  }
  const lead = /^(\d{4})-(\d{2})-(\d{2})/.exec(v.trim());
  if (lead && !isRealCalendarDate(Number(lead[1]), Number(lead[2]), Number(lead[3]))) {
    throw new AppError(400, `"${field}" must be a valid calendar date.`);
  }
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) {
    throw new AppError(400, `"${field}" must be a valid ISO date.`);
  }
  return d;
}

/** Strict "YYYY-MM-DD" → UTC-midnight Date (400 for any other shape or an impossible date). */
export function assertCalendarDate(v: unknown, field: string): Date {
  const match = typeof v === "string" ? DATE_ONLY_RE.exec(v) : null;
  if (!match) throw new AppError(400, `"${field}" must be a YYYY-MM-DD date`);
  if (!isRealCalendarDate(Number(match[1]), Number(match[2]), Number(match[3]))) {
    throw new AppError(400, `"${field}" must be a valid calendar date`);
  }
  return new Date(`${v}T00:00:00.000Z`);
}

// YYYY-MM-DD, checked for calendar validity below (not just regex shape) —
// new Date("2026-02-30") silently rolls over to March 2 instead of throwing,
// and new Date("2026-01-00") produces an Invalid Date that NaN-compares as
// false against any other date, silently skipping range-order guards.
const DATE_ONLY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Parse a "YYYY-MM-DD" date-only query param → UTC midnight Date, verifying
 *  it's a real calendar date (rejects 2026-02-30, 2026-01-00, etc.), not just
 *  the right shape. Returns undefined if `v` is undefined (field omitted). */
export function parseOptionalDateOnly(v: unknown, field: string): Date | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== "string") {
    throw new AppError(400, `"${field}" must be a YYYY-MM-DD date`);
  }
  const match = DATE_ONLY_RE.exec(v);
  if (!match) {
    throw new AppError(400, `"${field}" must be a YYYY-MM-DD date`);
  }
  const [, yearStr, monthStr, dayStr] = match;
  const year = Number(yearStr);
  const month = Number(monthStr);
  const day = Number(dayStr);
  const date = new Date(Date.UTC(year, month - 1, day));
  // Date.UTC silently normalizes out-of-range components (e.g. month 13 or
  // day 30 of a 28-day month) instead of throwing — round-trip the parts to
  // catch it.
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new AppError(400, `"${field}" must be a valid calendar date`);
  }
  return date;
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

/** Optional PropertyType: undefined = omitted, null = clear, else validate enum. */
export function optPropertyType(v: unknown): PropertyType | null | undefined {
  if (v === undefined) return undefined;
  if (v === null || v === "") return null; // empty string = clear
  if (typeof v === "string" && (Object.values(PropertyType) as string[]).includes(v)) {
    return v as PropertyType;
  }
  throw new AppError(400, `Invalid propertyType: must be one of ${Object.values(PropertyType).join(", ")}`);
}

/** Required NoteType (INTERNAL | RISK_WARNING | CUSTOMER). */
export function requireNoteType(v: unknown): NoteType {
  if (typeof v === "string" && (Object.values(NoteType) as string[]).includes(v)) {
    return v as NoteType;
  }
  throw new AppError(400, `"type" must be one of: ${Object.values(NoteType).join(", ")}`);
}

// ---- M3 (Rounds) domain validators ----------------------------------------

export function requireCleaningFrequency(v: unknown): CleaningFrequency {
  if (typeof v === "string" && (Object.values(CleaningFrequency) as string[]).includes(v)) {
    return v as CleaningFrequency;
  }
  throw new AppError(400, `"frequency" must be one of: ${Object.values(CleaningFrequency).join(", ")}`);
}

export function optCleaningFrequency(v: unknown): CleaningFrequency | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  return requireCleaningFrequency(v);
}

export function optDayOfWeek(v: unknown): DayOfWeek | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v === "string" && (Object.values(DayOfWeek) as string[]).includes(v)) {
    return v as DayOfWeek;
  }
  throw new AppError(400, `"defaultDay" must be one of: ${Object.values(DayOfWeek).join(", ")}`);
}

// undefined = omit filter (list all); null/"" treated as omit (query-param safe).
export function optRoundStatus(v: unknown): RoundStatus | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v === "string" && (Object.values(RoundStatus) as string[]).includes(v)) {
    return v as RoundStatus;
  }
  throw new AppError(400, `"status" must be one of: ${Object.values(RoundStatus).join(", ")}`);
}

export function requireMessageChannel(v: unknown): MessageChannel {
  if (typeof v === "string" && (Object.values(MessageChannel) as string[]).includes(v)) {
    return v as MessageChannel;
  }
  throw new AppError(400, `"channel" must be one of: ${Object.values(MessageChannel).join(", ")}`);
}

export function optMessageChannel(v: unknown): MessageChannel | undefined {
  if (v === undefined) return undefined;
  return requireMessageChannel(v);
}

// ---- Invite helpers --------------------------------------------------------

// Strict: no whitespace, CR/LF, angle brackets or quotes (header injection once email is sent), real domain labels,
// RFC length caps (BUG-008).
const EMAIL_RE = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

export function isValidEmail(v: string): boolean {
  return v.length <= 254 && v.indexOf("@") <= 64 && EMAIL_RE.test(v);
}

const fieldError = (field: string, code: string, message: string) => new ValidationError(message, [{ path: field, code, message }], code);

/** Optional email: undefined = omitted, null/blank = clear, else a valid address (trimmed). 400 with fields[] otherwise. */
export function optEmail(v: unknown, field: string): string | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  const email = typeof v === "string" ? v.trim() : "";
  if (typeof v === "string" && email === "") return null;
  if (!isValidEmail(email)) throw fieldError(field, "INVALID_EMAIL_ADDRESS", `"${field}" must be a valid email address`);
  return email;
}

/** Optional IANA time zone (Europe/London). An invented zone would break every date calculation of the tenant. */
export function optTimeZone(v: unknown, field: string): string | null | undefined {
  if (v === undefined || v === null) return v;
  const ok =
    typeof v === "string" &&
    /^[A-Za-z_]+(\/[A-Za-z_+\-0-9]+)*$/.test(v) &&
    (() => {
      try {
        new Intl.DateTimeFormat("en-GB", { timeZone: v });
        return true;
      } catch {
        return false;
      }
    })();
  if (!ok) throw fieldError(field, "INVALID_TIMEZONE", `"${field}" must be an IANA time zone such as Europe/London`);
  return v as string;
}

const CURRENCY_SYMBOLS = ["£", "$", "€", "¥", "₹", "kr", "zł", "Fr"];
const ISO_CURRENCIES: Set<string> = new Set((Intl as unknown as { supportedValuesOf(k: string): string[] }).supportedValuesOf("currency"));

/** Optional currency: an ISO 4217 code (GBP) or a currency symbol (£), which is what BusinessSettings has always stored. */
export function optCurrency(v: unknown, field: string): string | null | undefined {
  if (v === undefined || v === null) return v;
  if (typeof v === "string") {
    if (CURRENCY_SYMBOLS.includes(v)) return v;
    if (ISO_CURRENCIES.has(v.toUpperCase())) return v.toUpperCase();
  }
  throw fieldError(field, "INVALID_CURRENCY", `"${field}" must be an ISO 4217 code such as GBP, or a symbol such as £`);
}

/** UK bank details: 6-digit sort code (dashes optional) and 8-digit account number. */
export function assertUkBankFormat(sortCode: string, accountNumber: string): void {
  const problems: Array<{ path: string; code: string; message: string }> = [];
  if (!/^\d{2}-?\d{2}-?\d{2}$/.test(sortCode)) problems.push({ path: "bankDetails.sortCode", code: "INVALID_BANK_DETAILS", message: "sortCode must be 6 digits, e.g. 12-34-56" });
  if (!/^\d{8}$/.test(accountNumber)) problems.push({ path: "bankDetails.accountNumber", code: "INVALID_BANK_DETAILS", message: "accountNumber must be 8 digits" });
  if (problems.length > 0) throw new ValidationError("Invalid bank details", problems, "INVALID_BANK_DETAILS");
}

/** Optional working-days list: omitted = untouched; anything but an array of DayOfWeek values is a 400. */
export function optWorkingDaysArray(v: unknown): string[] | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v)) throw fieldError("defaultWorkingDays", "VALIDATION_FAILED", '"defaultWorkingDays" must be an array of day names');
  return validateWorkingDays(v);
}

/** Optional whole number >= 0 (null clears). */
export function optNonNegativeInt(v: unknown, field: string): number | null | undefined {
  if (v === undefined || v === null) return v;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0) throw fieldError(field, "VALIDATION_FAILED", `"${field}" must be a whole number of 0 or more`);
  return v;
}

/** Optional money amount >= 0, at most 99,999,999.99 (null clears). */
export function optNonNegativeAmount(v: unknown, field: string): number | null | undefined {
  if (v === undefined || v === null) return v;
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 99_999_999.99) {
    throw fieldError(field, "VALIDATION_FAILED", `"${field}" must be an amount of 0 or more`);
  }
  return v;
}

// ---- Technician role --------------------------------------------------------
// Technician.role is a free-text DB column (not a Prisma enum — changing the
// column type would need a backfill of existing free-text production values),
// but both write paths (POST/PATCH /technicians and POST/PATCH
// /settings/technicians) previously accepted ANY string with zero validation.
// This is the one shared vocabulary both routers validate against.
export const TECHNICIAN_ROLES = ["TRAINEE", "STANDARD", "SENIOR", "LEAD"] as const;
export type TechnicianRole = (typeof TECHNICIAN_ROLES)[number];

/** Optional technician role: undefined = omitted, null/"" = clear, else validate. */
export function optTechnicianRole(v: unknown): TechnicianRole | null | undefined {
  if (v === undefined) return undefined;
  if (v === null || v === "") return null;
  if (typeof v === "string" && (TECHNICIAN_ROLES as readonly string[]).includes(v)) {
    return v as TechnicianRole;
  }
  throw new AppError(400, `"role" must be one of: ${TECHNICIAN_ROLES.join(", ")}`);
}
