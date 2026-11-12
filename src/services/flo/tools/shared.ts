import type { AppError } from "../../../lib/app-error";
import { localDateTime } from "../../../lib/dates";
import { parseOptionalDateOnly } from "../../../lib/validation";
import { tenantTimeZone } from "../../business-time";
import { tenantDayWindow } from "../limits";
import type { ResultColumn, ToolContext, ToolDateRange } from "../types";

// Shared helpers for the Flo tools: argument validation (a ToolInputError message is shown to the model so it can
// retry), tenant-local date arithmetic and the money convention.
//
// MONEY CONVENTION (B0 finding): the whole API uses DECIMAL POUNDS (GBP), e.g. Visit.price is Decimal(10,2) and every
// service returns `price.toNumber()` / `Number(...)`. Never pence. Tools return numbers rounded to 2 dp with
// column format "currency"; the frontend formats them as GBP. "percent" columns hold a percentage number (12.5 = 12.5%).

export class ToolInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolInputError";
  }
}

export const MAX_RANGE_DAYS = 366;
export const MAX_LIMIT = 200;
export const DEFAULT_LIMIT = 50;
export const MAX_QUERY_CHARS = 80;
/** Safety cap on rows scanned in memory by aggregating tools. */
export const SCAN_CAP = 20_000;
export const DAY_MS = 86_400_000;

export const round2 = (n: number): number => Math.round(n * 100) / 100;

// ---- argument parsing ----------------------------------------------------------------------------------------------

export type Args = Record<string, unknown>;

/** The raw model input must be an object (or omitted); only the listed keys are accepted. */
export function parseArgs(raw: unknown, allowed: readonly string[]): Args {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) throw new ToolInputError("Arguments must be a JSON object");
  const obj = raw as Args;
  const unknown = Object.keys(obj).filter((k) => !allowed.includes(k));
  if (unknown.length > 0) throw new ToolInputError(`Unknown argument(s): ${unknown.slice(0, 5).join(", ")}. Allowed: ${allowed.join(", ") || "none"}`);
  return obj;
}

export function optDate(obj: Args, key: string): string | undefined {
  const v = obj[key];
  try {
    const d = parseOptionalDateOnly(v === null ? undefined : v, key);
    return d ? (v as string) : undefined;
  } catch (e) {
    throw new ToolInputError((e as AppError).message);
  }
}

export function optEnum<T extends string>(obj: Args, key: string, values: readonly T[]): T | undefined {
  const v = obj[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string" || !(values as readonly string[]).includes(v)) {
    throw new ToolInputError(`"${key}" must be one of: ${values.join(", ")}`);
  }
  return v as T;
}

export function optInt(obj: Args, key: string, min: number, max: number): number | undefined {
  const v = obj[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) {
    throw new ToolInputError(`"${key}" must be a whole number from ${min} to ${max}`);
  }
  return v;
}

export function optNumber(obj: Args, key: string, min: number, max: number): number | undefined {
  const v = obj[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max) {
    throw new ToolInputError(`"${key}" must be a number from ${min} to ${max}`);
  }
  return v;
}

export function optString(obj: Args, key: string, maxChars: number): string | undefined {
  const v = obj[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") throw new ToolInputError(`"${key}" must be text`);
  const t = v.trim();
  if (t.length > maxChars) throw new ToolInputError(`"${key}" must be at most ${maxChars} characters`);
  return t === "" ? undefined : t;
}

export function reqString(obj: Args, key: string, maxChars: number): string {
  const v = optString(obj, key, maxChars);
  if (v === undefined) throw new ToolInputError(`"${key}" is required`);
  return v;
}

export function parseLimit(obj: Args): number {
  return optInt(obj, "limit", 1, MAX_LIMIT) ?? DEFAULT_LIMIT;
}

export const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
export function optId(obj: Args, key: string): string | undefined {
  const v = optString(obj, key, 64);
  if (v !== undefined && !ID_RE.test(v)) throw new ToolInputError(`"${key}" is not a valid id`);
  return v;
}

// ---- tenant-local dates --------------------------------------------------------------------------------------------

export const dayToDate = (day: string): Date => new Date(`${day}T00:00:00.000Z`);
export const dateToDay = (d: Date): string => d.toISOString().slice(0, 10);
export const addDays = (day: string, n: number): string => dateToDay(new Date(dayToDate(day).getTime() + n * DAY_MS));
export const daysBetween = (fromDay: string, toDay: string): number =>
  Math.round((dayToDate(toDay).getTime() - dayToDate(fromDay).getTime()) / DAY_MS);

export interface Clock {
  tz: string;
  today: string;
  now: Date;
}

export async function tenantClock(ctx: ToolContext): Promise<Clock> {
  const now = ctx.now ?? new Date();
  const tz = await tenantTimeZone(ctx.tenantPrisma);
  return { tz, today: localDateTime(now, tz).date, now };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "1 to 30 Oct 2026", "28 Oct to 3 Nov 2026", "30 Dec 2026 to 2 Jan 2027", "5 Oct 2026". */
export function rangeLabel(from: string, to: string): string {
  const [fy, fm, fd] = from.split("-").map(Number);
  const [ty, tm, td] = to.split("-").map(Number);
  const fMon = MONTHS[fm - 1];
  const tMon = MONTHS[tm - 1];
  if (from === to) return `${fd} ${fMon} ${fy}`;
  if (fy !== ty) return `${fd} ${fMon} ${fy} to ${td} ${tMon} ${ty}`;
  if (fm !== tm) return `${fd} ${fMon} to ${td} ${tMon} ${ty}`;
  return `${fd} to ${td} ${tMon} ${ty}`;
}

export function toDateRange(from: string, to: string): ToolDateRange {
  return { from, to, label: rangeLabel(from, to) };
}

/**
 * Resolves an optional from/to pair (already format-validated; inclusive, tenant-local days). Defaults: the first of the
 * current month .. today. Rejects from > to and ranges over 366 days.
 */
export function resolveRange(range: { from?: string; to?: string }, clock: Clock): { from: string; to: string } {
  return checkRange(range.from ?? `${clock.today.slice(0, 8)}01`, range.to ?? clock.today);
}

export function checkRange(from: string, to: string): { from: string; to: string } {
  if (from > to) throw new ToolInputError('"from" must not be after "to"');
  if (daysBetween(from, to) + 1 > MAX_RANGE_DAYS) throw new ToolInputError(`The date range must be at most ${MAX_RANGE_DAYS} days`);
  return { from, to };
}

/** [gte, lt) UTC-midnight bounds for Visit.date (date-only values stored as UTC midnight), inclusive of `to`. */
export function visitDateWhere(from: string, to: string): { gte: Date; lt: Date } {
  return { gte: dayToDate(from), lt: dayToDate(addDays(to, 1)) };
}

/** [start, end) instants of the tenant-local day `day` (for timestamp columns such as Payment.createdAt). */
export function localDayBounds(tz: string, day: string): { start: Date; end: Date } {
  const probe = new Date(`${day}T12:00:00.000Z`);
  let w = tenantDayWindow(tz, probe);
  // Zones ahead of UTC+12 are already on the next local day at 12:00 UTC.
  if (w.date > day) w = tenantDayWindow(tz, new Date(probe.getTime() - DAY_MS));
  return { start: w.start, end: w.end };
}

/** Instants covering the tenant-local days from..to inclusive. */
export function instantRange(tz: string, from: string, to: string): { gte: Date; lt: Date } {
  return { gte: localDayBounds(tz, from).start, lt: localDayBounds(tz, to).end };
}

export function localDayOf(d: Date, tz: string): string {
  return localDateTime(d, tz).date;
}

// ---- columns -------------------------------------------------------------------------------------------------------

type ColumnSpec = [key: string, label: string, format: ResultColumn["format"]];

/** Builds a fixed column list. Numeric formats are right-aligned, text and dates left-aligned. */
export function columns(...specs: ColumnSpec[]): ResultColumn[] {
  return specs.map(([key, label, format]) => ({ key, label, format, align: format === "text" || format === "date" ? "left" : "right" }));
}
