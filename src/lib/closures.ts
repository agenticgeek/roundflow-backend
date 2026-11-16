import type { DayOfWeek } from "../generated/tenant-client";
import type { ClosureMode } from "./closure-types";
import { addWeeks, nextOccurrenceOfDay, snapToWeekday, startOfUtcDay } from "./schedule";

// Business closures: pure date helpers (rules: docs/handoff/backend/2026-11-16-closure-rules.md).
// No I/O, no clock reads. Every Date is a calendar day at UTC midnight.

export interface ClosureWindow {
  id: string;
  label: string;
  /** Inclusive, UTC midnight. */
  startDate: Date;
  /** Inclusive, UTC midnight. */
  endDate: Date;
  mode: ClosureMode;
  /** Empty = all rounds. */
  roundIds: readonly string[];
}

export type ClosureResolution =
  | { action: "KEEP"; date: Date }
  | { action: "MOVE"; date: Date; closureIds: string[] }
  | { action: "SKIP"; closureId: string };

export const CLOSURE_RESOLUTION_LIMIT = 400;

export class ClosureResolutionLimitError extends Error {
  constructor() {
    super("CLOSURE_RESOLUTION_LIMIT");
    this.name = "ClosureResolutionLimitError";
  }
}

const DAY_MS = 86_400_000;

/**
 * The visit date for a plan due on `date`: the round day on or after it, or the
 * nearest working day when the round has no day. The round day is NOT checked
 * against the working days (rules s1). Same rule as the nightly generator.
 */
export function visitDateFor(
  date: Date,
  defaultDay: DayOfWeek | null | undefined,
  workingDays: readonly string[],
): Date {
  return defaultDay ? nextOccurrenceOfDay(date, defaultDay) : snapToWeekday(startOfUtcDay(date), workingDays);
}

/** The closures that apply to `roundId` and cover `date` (both ends inclusive). */
export function closuresCovering(date: Date, roundId: string, closures: readonly ClosureWindow[]): ClosureWindow[] {
  const t = date.getTime();
  return closures.filter(
    (c) =>
      (c.roundIds.length === 0 || c.roundIds.includes(roundId)) &&
      c.startDate.getTime() <= t &&
      t <= c.endDate.getTime(),
  );
}

/** rules s3: where does a visit due on `visitDate` go? */
export function resolveClosedDate(input: {
  visitDate: Date;
  roundId: string;
  defaultDay: DayOfWeek | null;
  workingDays: readonly string[];
  closures: readonly ClosureWindow[];
}): ClosureResolution {
  let x = input.visitDate;
  const forced = new Set<string>();

  for (let i = 0; i < CLOSURE_RESOLUTION_LIMIT; i++) {
    const cov = closuresCovering(x, input.roundId, input.closures);
    if (cov.length === 0) {
      return x.getTime() === input.visitDate.getTime()
        ? { action: "KEEP", date: x }
        : { action: "MOVE", date: x, closureIds: [...forced] };
    }
    const skip = cov.find((c) => c.mode === "SKIP");
    if (skip) return { action: "SKIP", closureId: skip.id };

    let latestEnd = cov[0].endDate.getTime();
    for (const c of cov) {
      forced.add(c.id);
      latestEnd = Math.max(latestEnd, c.endDate.getTime());
    }
    x = visitDateFor(new Date(latestEnd + DAY_MS), input.defaultDay, input.workingDays);
  }
  throw new ClosureResolutionLimitError();
}

/** Closures that have not ended before `today` (endDate >= today). */
export function activeClosures(closures: readonly ClosureWindow[], today: Date): ClosureWindow[] {
  return closures.filter((c) => c.endDate.getTime() >= today.getTime());
}

/**
 * rules s4.1 served-cycle guard: the cycle is already served when the plan has
 * a non-cancelled visit dated on or after the date this cycle's visit would get.
 */
export function isServedCycle(candidateVisitDate: Date, latestPlanVisitDate: Date | null): boolean {
  return latestPlanVisitDate !== null && latestPlanVisitDate.getTime() >= candidateVisitDate.getTime();
}

/**
 * rules s1 nextDue(V): `visitDate` plus `weeks` weeks, then the round day (or a
 * working day when the round has none). Always computed from the ORIGINAL raw
 * visit date, never from a moved one. `dueDate` is the cycle's current due
 * date; the rule does not depend on it (the visit date already derives from it),
 * it is kept so callers state which cycle they advance.
 */
export function advanceDueDate(
  _dueDate: Date,
  visitDate: Date,
  input: { weeks: number; defaultDay: DayOfWeek | null; workingDays: readonly string[] },
): Date {
  return visitDateFor(addWeeks(startOfUtcDay(visitDate), input.weeks), input.defaultDay, input.workingDays);
}
