import { round2 } from "./shared";

// Small pure helpers shared by the E2 Flo tools (round_performance, technician_workload, technician_incidents,
// list_messages_delivery, list_issues_photos, forecast_schedule, closures_and_weather).

/** part / whole as a percentage number (12.5 = 12.5%), null when there is no whole. */
export const pct = (part: number, whole: number): number | null => (whole === 0 ? null : round2((part / whole) * 100));

/** "ACCESS_PROBLEM" -> "Access problem". */
export function humanize(value: string): string {
  const t = value.toLowerCase().replace(/_/g, " ");
  return t.charAt(0).toUpperCase() + t.slice(1);
}

export const sortedUnique = (xs: Iterable<string>): string[] => [...new Set(xs)].sort((a, b) => a.localeCompare(b));

/** Whole minutes from `start` to `end`; null when either is missing or the order is impossible. */
export function minutesBetween(start: Date | null | undefined, end: Date | null | undefined): number | null {
  if (!start || !end) return null;
  const m = (end.getTime() - start.getTime()) / 60_000;
  return m < 0 ? null : m;
}

/** Shortens free-ish text (a reason, a label) so a row stays small. */
export const clip = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max - 1)}…` : s);
