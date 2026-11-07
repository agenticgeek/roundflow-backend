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

/** BUG-05: list of accepted payment methods (deduped). [] = not configured. */
export function optPaymentMethods(v: unknown, field = "acceptedPaymentMethods"): PaymentMethod[] | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v)) throw new AppError(400, `${field} must be an array of payment methods`);
  const allowed = Object.values(PaymentMethod) as string[];
  const out: PaymentMethod[] = [];
  for (const item of v) {
    if (typeof item !== "string" || !allowed.includes(item)) {
      throw new AppError(400, `Invalid ${field} entry: ${String(item)}. Must be one of: ${allowed.join(", ")}`);
    }
    if (!out.includes(item as PaymentMethod)) out.push(item as PaymentMethod);
  }
  return out;
}

/** BUG-05: reconciles acceptedPaymentMethods with defaultPaymentMethod.
 *  The default must be one of the accepted methods; when the list is empty
 *  (not configured yet) setting a default also seeds the list. No provider
 *  connection is required to accept GOCARDLESS / STRIPE. */
export function resolvePaymentMethods(
  input: { acceptedPaymentMethods?: PaymentMethod[]; defaultPaymentMethod?: PaymentMethod | null },
  current: { acceptedPaymentMethods?: PaymentMethod[] | null; defaultPaymentMethod?: PaymentMethod | null } | null
): { acceptedPaymentMethods?: PaymentMethod[]; defaultPaymentMethod?: PaymentMethod | null } {
  if (input.acceptedPaymentMethods === undefined && input.defaultPaymentMethod === undefined) return {};
  let accepted = input.acceptedPaymentMethods ?? current?.acceptedPaymentMethods ?? [];
  const def = input.defaultPaymentMethod !== undefined ? input.defaultPaymentMethod : current?.defaultPaymentMethod ?? null;
  let seeded = false;
  if (def && accepted.length === 0) {
    accepted = [def];
    seeded = true;
  }
  if (def && !accepted.includes(def)) {
    throw new AppError(400, `defaultPaymentMethod ${def} must be one of acceptedPaymentMethods (${accepted.join(", ")})`);
  }
    return {
    acceptedPaymentMethods: input.acceptedPaymentMethods !== undefined || seeded ? accepted : undefined,
    defaultPaymentMethod: input.defaultPaymentMethod,
  };
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

// BUG-01: pre-clean reminders are a list of { type, time } entries (at most one
// per type). The legacy single reminderMode/reminderTime pair is still accepted
// and kept in sync with the first list entry for old clients.
export type ReminderType = "EVENING_BEFORE" | "MORNING_OF";
export interface PreCleanReminder {
  type: ReminderType;
  time: string; // "HH:mm", tenant-local
}
export const REMINDER_TYPES: ReminderType[] = ["EVENING_BEFORE", "MORNING_OF"];
export const DEFAULT_REMINDER_TIME: Record<ReminderType, string> = { EVENING_BEFORE: "19:00", MORNING_OF: "07:00" };
export const DEFAULT_PRE_CLEAN_REMINDERS: PreCleanReminder[] = [{ type: "EVENING_BEFORE", time: "19:00" }];

/** Request body list: [{ type: "EVENING_BEFORE"|"MORNING_OF", time?: "HH:mm" }].
 *  A missing time takes the type's default; [] switches reminders off. */
export function optPreCleanReminders(v: unknown): PreCleanReminder[] | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v)) throw new AppError(400, "preCleanReminders must be an array of { type, time }");
  if (v.length > REMINDER_TYPES.length) {
    throw new AppError(400, `preCleanReminders must have at most ${REMINDER_TYPES.length} entries`);
  }
  const seen = new Set<string>();
  return v.map((raw, i) => {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw new AppError(400, `preCleanReminders[${i}] must be an object`);
    }
    const item = raw as Record<string, unknown>;
    const type = item.type;
    if (typeof type !== "string" || !REMINDER_TYPES.includes(type as ReminderType)) {
      throw new AppError(400, `preCleanReminders[${i}].type must be one of: ${REMINDER_TYPES.join(", ")}`);
    }
    if (seen.has(type)) throw new AppError(400, `preCleanReminders has more than one ${type} entry`);
    seen.add(type);
    const time = item.time === undefined ? DEFAULT_REMINDER_TIME[type as ReminderType] : optReminderTime(item.time)!;
    return { type: type as ReminderType, time };
  });
}

/** Legacy single reminderMode/reminderTime -> list (NONE = no reminders). */
export function remindersFromLegacy(mode: ReminderMode, time?: string | null): PreCleanReminder[] {
  if (mode === ReminderMode.NONE) return [];
  return [{ type: mode as ReminderType, time: time ?? DEFAULT_REMINDER_TIME[mode as ReminderType] }];
}

/** List -> the legacy columns, derived from the first entry (NONE when empty). */
export function legacyFromReminders(list: PreCleanReminder[]): { reminderMode: ReminderMode; reminderTime: string } {
  const first = list[0];
  return first
    ? { reminderMode: first.type as ReminderMode, reminderTime: first.time }
    : { reminderMode: ReminderMode.NONE, reminderTime: DEFAULT_REMINDER_TIME.EVENING_BEFORE };
}

/** Tolerant read of the stored Json column: junk entries are dropped, and a
 *  row that has no list yet falls back to the legacy mode/time columns. */
export function parseStoredReminders(
  stored: unknown,
  legacyMode?: ReminderMode | null,
  legacyTime?: string | null
): PreCleanReminder[] {
  if (Array.isArray(stored)) {
    const out: PreCleanReminder[] = [];
    for (const raw of stored) {
      const item = raw as { type?: unknown; time?: unknown } | null;
      const type = item?.type;
      if (typeof type !== "string" || !REMINDER_TYPES.includes(type as ReminderType)) continue;
      if (out.some((r) => r.type === type)) continue;
      const time = typeof item?.time === "string" && HH_MM.test(item.time) ? item.time : DEFAULT_REMINDER_TIME[type as ReminderType];
      out.push({ type: type as ReminderType, time });
    }
    return out;
  }
  return legacyMode ? remindersFromLegacy(legacyMode, legacyTime) : [...DEFAULT_PRE_CLEAN_REMINDERS];
}

/** Resolves every way a client can express reminders (list, legacy
 *  mode/time, deprecated timings) into the list to store, or undefined when
 *  the request doesn't touch reminders. A bare reminderTime re-times the
 *  current first entry (`current` = the stored list). */
export function resolveReminderInput(
  input: { preCleanReminders?: PreCleanReminder[]; reminderMode?: ReminderMode; reminderTime?: string },
  current: PreCleanReminder[]
): PreCleanReminder[] | undefined {
  if (input.preCleanReminders !== undefined) return input.preCleanReminders;
  if (input.reminderMode !== undefined) return remindersFromLegacy(input.reminderMode, input.reminderTime);
  if (input.reminderTime !== undefined) {
    return current.map((r, i) => (i === 0 ? { ...r, time: input.reminderTime! } : r));
  }
  return undefined;
}

/** VAT rate as a percentage, 0–100 (up to 2dp — Decimal(5,2)). */
export function optVatRate(v: unknown): number | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 100) {
    throw new AppError(400, "vatRate must be a number between 0 and 100");
  }
  return Math.round(v * 100) / 100;
}

/** Optional free text (trimmed; blank -> null clears). Used for invoiceFooter / paymentTerms. */
export function optFreeText(v: unknown, field: string, maxLength: number): string | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v !== "string") throw new AppError(400, `${field} must be a string or null`);
  const t = v.trim();
  if (t.length > maxLength) throw new AppError(400, `${field} must be at most ${maxLength} characters`);
  return t === "" ? null : t;
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
