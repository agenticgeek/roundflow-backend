import { ReminderMode, CleanMethod, PaymentMethod, NoDirectDebitAction } from "../generated/tenant-client";
import { AppError } from "./app-error";
import { optStringArray, optId } from "./http";

// Request validators for the BusinessSettings fields added in the Phase 1
// audit (B1 address/VAT, B2 reminders, GAP-008 payment defaults). Shared by
// POST /setup/step/1|2|4 and PATCH /settings/business-profile|round-settings|payment
// so the wizard and Settings can't drift. undefined = omitted (untouched).

function optEnum<T extends string>(
  values: Record<string, T>,
  v: unknown,
  field: string,
  opts: { nullable: boolean }
): T | null | undefined {
  if (v === undefined) return undefined;
  if (v === null && opts.nullable) return null;
  const allowed = Object.values(values) as string[];
  if (typeof v === "string" && allowed.includes(v)) return v as T;
  throw new AppError(400, `Invalid ${field}: ${String(v)}. Must be one of: ${allowed.join(", ")}`);
}

export function optReminderMode(v: unknown): ReminderMode | undefined {
  return optEnum(ReminderMode, v, "reminderMode", { nullable: false }) as ReminderMode | undefined;
}

export function optCleanMethod(v: unknown): CleanMethod | null | undefined {
  return optEnum(CleanMethod, v, "defaultCleanMethod", { nullable: true });
}

export function optPaymentMethod(v: unknown, field: string): PaymentMethod | null | undefined {
  return optEnum(PaymentMethod, v, field, { nullable: true });
}

export function optNoDirectDebitAction(v: unknown): NoDirectDebitAction | undefined {
  return optEnum(NoDirectDebitAction, v, "noDirectDebitAction", { nullable: false }) as
    | NoDirectDebitAction
    | undefined;
}

const HH_MM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** "HH:mm", 24-hour, tenant-local (e.g. "19:00"). */
export function optReminderTime(v: unknown): string | undefined {
  if (v === undefined) return undefined;
  if (typeof v === "string" && HH_MM.test(v)) return v;
  throw new AppError(400, 'reminderTime must be a 24-hour time in "HH:mm" format');
}

/** VAT rate as a percentage, 0–100 (up to 2dp — Decimal(5,2)). */
export function optVatRate(v: unknown): number | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 100) {
    throw new AppError(400, "vatRate must be a number between 0 and 100");
  }
  return Math.round(v * 100) / 100;
}

/** Days from invoice date to due date, 1–90. */
export function optInvoiceDueDays(v: unknown): number | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > 90) {
    throw new AppError(400, "invoiceDueDays must be an integer between 1 and 90");
  }
  return v;
}

// A6: connection state only changes through the real connect flows. Sending a
// removed field is a 400 with code FIELD_REMOVED (one release), not a silent drop.
export function rejectRemovedFields(body: Record<string, unknown>, fields: string[]): void {
  const sent = fields.filter((f) => body[f] !== undefined);
  if (sent.length > 0) {
    throw new AppError(
      400,
      `${sent.join(", ")} can no longer be set here. Connect or disconnect the provider from Settings › Payments.`,
      "FIELD_REMOVED"
    );
  }
}

// B2: map the deprecated preCleanReminderTimings array onto reminderMode, for
// clients that still send the old field. EVENING_BEFORE wins; the old
// "two hours before" option is closest to MORNING_OF; an empty list is NONE.
export function reminderModeFromLegacy(timings: string[]): ReminderMode {
  if (timings.includes("EVENING_BEFORE")) return ReminderMode.EVENING_BEFORE;
  if (timings.includes("TWO_HOURS_BEFORE")) return ReminderMode.MORNING_OF;
  return ReminderMode.NONE;
}

// GAP-004: old clients send a singular serviceAreaId. Fold it into
// serviceAreaIds (deduped) instead of silently dropping it.
export function foldServiceAreaIds(body: Record<string, unknown>, prefix = ""): string[] | undefined {
  const ids = optStringArray(body.serviceAreaIds, `${prefix}serviceAreaIds`);
  const single = optId(body.serviceAreaId, `${prefix}serviceAreaId`);
  if (!single) return ids;
  return [...new Set([...(ids ?? []), single])];
}
