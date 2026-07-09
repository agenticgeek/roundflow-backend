import { DayOfWeek } from "@prisma/client";
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
