import { LifecycleStatus, RoundStatus, VisitStatus } from "../generated/tenant-client";
import type { CleaningFrequency, DayOfWeek } from "../generated/tenant-client";
import type { TenantPrismaClient } from "../lib/tenant-prisma-manager";
import { addWeeks, frequencyWeeks, nextDueAfter, nextOccurrenceOfDay, snapToWeekday, startOfUtcDay } from "../lib/schedule";
import { activeClosures, advanceDueDate, isServedCycle, resolveClosedDate, visitDateFor, type ClosureWindow } from "../lib/closures";
import { getCachedBusinessSettings } from "./settings.service";

// Round Planner calendar: display-only projection of future occurrences (decision 2026-11-07).
// Real visits only exist for the activation window and, after that, one per plan on its due day (nightly job), so
// the calendar showed nothing past the next visit. The planner now also returns forecast entries, flagged
// `projected: true`. They are read-only, computed on the fly and NEVER create a visit row.

/** How far ahead of the next date the series may run (weeks). One place, so it can change without touching logic. */
export const PROJECTION_HORIZON_WEEKS = 13;
/** Most entries per round, real and projected together. */
export const PROJECTION_MAX_ENTRIES = 4;

const DAY_MS = 86_400_000;
const dayKey = (d: Date): string => d.toISOString().slice(0, 10);

export interface ProjectedOccurrence {
  date: string;
  stopCount: number;
  totalValue: number;
  completedCount: 0;
  completionPct: 0;
  holdCount: 0;
  issueCount: 0;
  technicians: [];
  projected: true;
}

/**
 * The dates of one round's series: `next`, then the round's frequency repeated (whole cycles, snapped onto the round
 * day, or onto the tenant's working days when the round has no day), while inside the horizon and under the cap.
 */
export function projectionSeries(
  next: Date,
  frequency: CleaningFrequency,
  defaultDay: DayOfWeek | null,
  workingDays: readonly string[] = [],
  horizonFrom: Date = next
): Date[] {
  const first = startOfUtcDay(next);
  const horizonEnd = addWeeks(startOfUtcDay(horizonFrom), PROJECTION_HORIZON_WEEKS);
  const series = [first];
  while (series.length < PROJECTION_MAX_ENTRIES) {
    const after = nextDueAfter(series[series.length - 1], frequency, defaultDay);
    const date = defaultDay ? after : snapToWeekday(after, workingDays);
    if (date > horizonEnd) break;
    series.push(date);
  }
  return series;
}

/** Most raw cycles looked at per round when closures drop or move entries (a SKIP closure can swallow many). */
const MAX_CLOSURE_CYCLES = 120;

/**
 * The closure-aware series (rules 5.2): the generation rule applied cycle by cycle. `first` is the first cycle's raw visit date.
 * SKIP drops the entry; MOVE shows the moved date; the next cycle always advances from the ORIGINAL raw date; a cycle whose
 * resolved date is on or before the previous entry's date is already served and gives no entry. The 13-week horizon is
 * measured from the earlier of the first entry and `upcomingFrom` (the next real visit). `clampFirstTo` lifts only the first entry.
 */
export function closureProjectionSeries(
  first: Date,
  round: { id: string; defaultDay: DayOfWeek | null },
  frequency: CleaningFrequency,
  workingDays: readonly string[],
  closures: readonly ClosureWindow[],
  upcomingFrom: number = Infinity,
  clampFirstTo: number = -Infinity
): Date[] {
  const weeks = frequencyWeeks(frequency);
  const series: Date[] = [];
  let horizonEnd = Infinity;
  let raw = startOfUtcDay(first);
  for (let i = 0; i < MAX_CLOSURE_CYCLES && series.length < PROJECTION_MAX_ENTRIES; i++) {
    const r = resolveClosedDate({ visitDate: raw, roundId: round.id, defaultDay: round.defaultDay, workingDays, closures });
    if (r.action !== "SKIP" && (series.length === 0 || r.date > series[series.length - 1])) {
      // Only the FIRST entry is clamped up to today (an overdue plan is shown today); the cycles after it keep their phase.
      const date = series.length === 0 ? new Date(Math.max(r.date.getTime(), clampFirstTo)) : r.date;
      if (series.length === 0) horizonEnd = addWeeks(new Date(Math.min(date.getTime(), upcomingFrom)), PROJECTION_HORIZON_WEEKS).getTime();
      if (series.length > 0 && date.getTime() > horizonEnd) break; // the first entry is always shown
      series.push(date);
    }
    raw = advanceDueDate(raw, raw, { weeks, defaultDay: round.defaultDay, workingDays });
  }
  return series;
}

/**
 * An ACTIVE plan's first forecast cycle (rules 5.1): walk from its own stored `nextDueDate` exactly as generation does. A SKIP
 * cycle, and a cycle whose resolved date is on or before the plan's latest non-cancelled, non-one-off visit (served), are
 * dropped and the next cycle is advanced from the ORIGINAL raw date. Returns the surviving cycle's raw date and resolved
 * date, or null when every cycle looked at is dropped.
 */
export function planFirstCycle(
  nextDueDate: Date,
  latestVisit: Date | null,
  round: { id: string; defaultDay: DayOfWeek | null },
  frequency: CleaningFrequency,
  workingDays: readonly string[],
  closures: readonly ClosureWindow[]
): { raw: Date; date: Date } | null {
  const weeks = frequencyWeeks(frequency);
  let due = startOfUtcDay(nextDueDate);
  for (let i = 0; i < MAX_CLOSURE_CYCLES; i++) {
    const raw = visitDateFor(due, round.defaultDay, workingDays);
    const r = resolveClosedDate({ visitDate: raw, roundId: round.id, defaultDay: round.defaultDay, workingDays, closures });
    if (r.action !== "SKIP" && !isServedCycle(r.date, latestVisit)) return { raw, date: r.date };
    due = advanceDueDate(due, raw, { weeks, defaultDay: round.defaultDay, workingDays });
  }
  return null;
}

/**
 * Projected entries per round id for the given rounds, restricted to the calendar window [from, to] (either bound
 * optional). Only ACTIVE rounds are projected. Rounds with nothing to project are absent from the map.
 */
export async function projectOccurrences(
  tp: TenantPrismaClient,
  roundIds: string[],
  today: Date,
  from?: Date,
  to?: Date
): Promise<Map<string, ProjectedOccurrence[]>> {
  const out = new Map<string, ProjectedOccurrence[]>();
  const rounds = await tp.round.findMany({
    where: { id: { in: roundIds }, status: RoundStatus.ACTIVE },
    select: { id: true, defaultDay: true, frequency: true },
  });
  if (rounds.length === 0) return out;
  const ids = rounds.map((r) => r.id);

  // Closures that ended up to 366 days ago still matter to a catch-up cycle (same rule as generation).
  const closuresSince = new Date(startOfUtcDay(today).getTime() - 366 * DAY_MS);
  const [plans, visitRows, settings, closureRows] = await Promise.all([
    tp.servicePlan.findMany({
      where: { property: { roundId: { in: ids } }, status: { in: [LifecycleStatus.ACTIVE, LifecycleStatus.PAUSED] } },
      select: { id: true, price: true, cleaningFrequency: true, status: true, nextDueDate: true, pauseEndDate: true, property: { select: { roundId: true } } },
    }),
    tp.visit.groupBy({
      by: ["roundId", "date", "status"],
      where: { roundId: { in: ids }, status: { not: VisitStatus.CANCELLED }, isOneOff: false, date: { gte: today } },
    }),
    getCachedBusinessSettings(tp),
    tp.businessClosure.findMany({ where: { endDate: { gte: closuresSince } } }),
  ]);
  // Closures are loaded once per call.
  const closures = activeClosures(
    closureRows.map((c) => ({
      id: c.id, label: c.label, startDate: startOfUtcDay(c.startDate), endDate: startOfUtcDay(c.endDate), mode: c.mode, roundIds: c.roundIds,
    })),
    closuresSince
  );
  const workingDays = settings?.defaultWorkingDays ?? [];

  // Each plan's latest non-cancelled, non-one-off visit date, of ANY date: the served-cycle guard's input (as in generation).
  const latestRows = await tp.visit.groupBy({
    by: ["servicePlanId"],
    where: { servicePlanId: { in: plans.map((p) => p.id) }, status: { not: VisitStatus.CANCELLED }, isOneOff: false },
    _max: { date: true },
  });
  const latestByPlan = new Map<string, Date>();
  for (const row of latestRows) {
    if (row.servicePlanId && row._max.date) latestByPlan.set(row.servicePlanId, row._max.date);
  }

  type PlanRow = (typeof plans)[number];
  type VisitRow = (typeof visitRows)[number];
  const plansByRound = new Map<string, PlanRow[]>();
  for (const p of plans) {
    const id = p.property.roundId;
    if (id) plansByRound.set(id, [...(plansByRound.get(id) ?? []), p]);
  }
  const visitsByRound = new Map<string, VisitRow[]>();
  for (const v of visitRows) {
    if (v.roundId) visitsByRound.set(v.roundId, [...(visitsByRound.get(v.roundId) ?? []), v]);
  }

  const inWindow = (d: Date) => (!from || d >= from) && (!to || d <= to);

  for (const round of rounds) {
    const roundPlans = plansByRound.get(round.id) ?? [];
    const roundVisits = visitsByRound.get(round.id) ?? [];
    const frequency = round.frequency ?? roundPlans.find((p) => p.cleaningFrequency)?.cleaningFrequency ?? null;
    if (!frequency) continue;

    // The day a paused plan comes back: the day after its pause ends, on the round day / a working day (as resumePlan does).
    const resumeOf = (p: PlanRow): Date => {
      const dayAfter = new Date(startOfUtcDay(p.pauseEndDate!).getTime() + DAY_MS);
      return round.defaultDay ? nextOccurrenceOfDay(dayAfter, round.defaultDay) : snapToWeekday(dayAfter, workingDays);
    };

    // Anchor (rules 5.1): per plan, the first cycle generation would still act on, walked from the plan's own stored
    // nextDueDate (no clamp to today, no re-snap). NEVER the dates of existing visits, except as the served-cycle guard.
    // `raw` is the cycle's original date (the series continues from it); `first` is the date shown (clamped up to today).
    const candidates: Array<{ raw: Date; first: Date }> = [];
    for (const p of roundPlans) {
      if (p.status === LifecycleStatus.ACTIVE && p.nextDueDate) {
        const cycle = planFirstCycle(p.nextDueDate, latestByPlan.get(p.id) ?? null, round, p.cleaningFrequency ?? frequency, workingDays, closures);
        if (cycle) candidates.push({ raw: cycle.raw, first: new Date(Math.max(cycle.date.getTime(), today.getTime())) });
      }
      if (p.status === LifecycleStatus.PAUSED && p.pauseEndDate) candidates.push({ raw: resumeOf(p), first: resumeOf(p) });
    }
    if (candidates.length === 0) continue;
    const start = candidates.reduce((best, c) => (c.first < best.first ? c : best));

    // The 13-week horizon is measured from the earliest of the next upcoming real visit and the first series date.
    const upcoming = roundVisits.filter((v) => v.status === VisitStatus.SCHEDULED || v.status === VisitStatus.IN_PROGRESS).map((v) => v.date.getTime());
    const fullSeries = closureProjectionSeries(start.raw, round, frequency, workingDays, closures, Math.min(...upcoming), today.getTime());
    // Real visits that come before the series still use up slots of the cap of 4 (real and forecast together).
    const realKeys = new Set(roundVisits.map((v) => dayKey(v.date)));
    const realBefore = [...realKeys].filter((k) => k < dayKey(fullSeries[0])).length;
    const series = fullSeries.slice(0, Math.max(0, PROJECTION_MAX_ENTRIES - realBefore));

    // Real visits win: a date that already has visits is real, and nothing at or before it in the series is projected.
    let lastReal = -1;
    series.forEach((date, i) => {
      if (realKeys.has(dayKey(date))) lastReal = i;
    });

    const entries: ProjectedOccurrence[] = [];
    for (const date of series.slice(lastReal + 1)) {
      if (!inWindow(date)) continue;
      // Estimate: the plans on this round's frequency that will be back by then.
      const due = roundPlans.filter(
        (p) =>
          (p.cleaningFrequency === null || p.cleaningFrequency === frequency) &&
          (p.status === LifecycleStatus.ACTIVE || (p.pauseEndDate !== null && p.pauseEndDate < date))
      );
      if (due.length === 0) continue;
      entries.push({
        date: dayKey(date),
        stopCount: due.length,
        totalValue: Math.round(due.reduce((sum, p) => sum + p.price.toNumber(), 0) * 100) / 100,
        completedCount: 0,
        completionPct: 0,
        holdCount: 0,
        issueCount: 0,
        technicians: [],
        projected: true,
      });
    }
    if (entries.length > 0) out.set(round.id, entries);
  }
  return out;
}
