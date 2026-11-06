import { DEFAULT_TIMEZONE, localDay, resolveTimeZone } from "./dates";

// ACT-02..04: the single home for "which days does this business work".
// BusinessSettings.defaultWorkingDays is stored as string[] of MON..SUN (empty
// = never configured -> Mon-Fri). Close-day carryover, weather hold, nightly
// visit generation and weekday snapping all go through here.
//
// Dates are date-only values (UTC midnight, the app-wide visit-date
// convention). A Date that is NOT at UTC midnight is an instant and is
// resolved to the tenant-local calendar day first (`tz`, default Europe/London).

export const DEFAULT_WORKING_DAYS = ["MON", "TUE", "WED", "THU", "FRI"] as const;

const CODE_INDEX: Record<string, number> = { SUN: 0, MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6 };
const DAY_MS = 86_400_000;

export interface WorkingDayOpts {
  workingDays?: readonly string[] | null;
  tz?: string;
}

export type CarryoverKey = "NEXT_WORKING_DAY" | "SATURDAY" | "MONDAY";

export interface CarryoverOption {
  key: CarryoverKey;
  /** YYYY-MM-DD */
  date: string;
  label: string;
  default: boolean;
}

/** getUTCDay() indexes (0=Sun) of the working days; Mon-Fri when none are valid. */
export function workingDayIndexes(days?: readonly string[] | null): Set<number> {
  const set = new Set<number>();
  for (const code of days ?? []) {
    const idx = CODE_INDEX[code];
    if (idx !== undefined) set.add(idx);
  }
  return set.size > 0 ? set : new Set(DEFAULT_WORKING_DAYS.map((c) => CODE_INDEX[c]));
}

/** UTC-midnight Date of the calendar day `input` denotes. */
export function toCalendarDay(input: Date | string, tz: string = DEFAULT_TIMEZONE): Date {
  if (typeof input === "string") return new Date(`${input}T00:00:00.000Z`);
  if (input.getTime() % DAY_MS === 0) return new Date(input);
  return localDay(resolveTimeZone(tz), input);
}

export function isWorkingDay(date: Date | string, opts: WorkingDayOpts = {}): boolean {
  return workingDayIndexes(opts.workingDays).has(toCalendarDay(date, opts.tz).getUTCDay());
}

/** First working day strictly after `from`. */
export function nextWorkingDay(from: Date | string, opts: WorkingDayOpts = {}): Date {
  const set = workingDayIndexes(opts.workingDays);
  const d = toCalendarDay(from, opts.tz);
  do {
    d.setUTCDate(d.getUTCDate() + 1);
  } while (!set.has(d.getUTCDay()));
  return d;
}

/** `date` itself when it is a working day, else the next one. */
export function snapToWorkingDay(date: Date | string, opts: WorkingDayOpts = {}): Date {
  const d = toCalendarDay(date, opts.tz);
  return workingDayIndexes(opts.workingDays).has(d.getUTCDay()) ? d : nextWorkingDay(d, opts);
}

const iso = (d: Date) => d.toISOString().slice(0, 10);
const label = (d: Date) =>
  new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", weekday: "long", day: "numeric", month: "short" })
    .format(d)
    .replace(",", "");

/**
 * Where unfinished visits of `date` can be carried to. On a Friday the choice
 * is ALWAYS Saturday or Monday (Sunday is never offered) whatever the
 * working-days setting; the setting only picks the default (Monday, unless
 * Monday is not a working day and Saturday is). Any other day offers just the
 * next working day.
 */
export function carryoverOptions(date: Date | string, opts: WorkingDayOpts = {}): CarryoverOption[] {
  const day = toCalendarDay(date, opts.tz);
  if (day.getUTCDay() !== 5) {
    const next = nextWorkingDay(day, opts);
    return [{ key: "NEXT_WORKING_DAY", date: iso(next), label: label(next), default: true }];
  }
  const saturday = new Date(day.getTime() + DAY_MS);
  const monday = new Date(day.getTime() + 3 * DAY_MS);
  const set = workingDayIndexes(opts.workingDays);
  const saturdayDefault = set.has(6) && !set.has(1);
  return [
    { key: "SATURDAY", date: iso(saturday), label: label(saturday), default: saturdayDefault },
    { key: "MONDAY", date: iso(monday), label: label(monday), default: !saturdayDefault },
  ];
}

/** The UTC-midnight target date for a carryover key, or null when that key is not offered for `date`. */
export function resolveCarryoverTarget(date: Date | string, key: string, opts: WorkingDayOpts = {}): Date | null {
  const option = carryoverOptions(date, opts).find((o) => o.key === key);
  return option ? toCalendarDay(option.date) : null;
}
