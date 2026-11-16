import { LifecycleStatus, RoundStatus, VisitStatus } from "../generated/tenant-client";
import type { CleaningFrequency, DayOfWeek } from "../generated/tenant-client";
import type { TenantPrismaClient } from "../lib/tenant-prisma-manager";
import { addWeeks, nextDueAfter, nextOccurrenceOfDay, snapToWeekday, startOfUtcDay } from "../lib/schedule";
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
  workingDays: readonly string[] = []
): Date[] {
  const first = startOfUtcDay(next);
  const horizonEnd = addWeeks(first, PROJECTION_HORIZON_WEEKS);
  const series = [first];
  while (series.length < PROJECTION_MAX_ENTRIES) {
    const after = nextDueAfter(series[series.length - 1], frequency, defaultDay);
    const date = defaultDay ? after : snapToWeekday(after, workingDays);
    if (date > horizonEnd) break;
    series.push(date);
  }
  return series;
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

  const [plans, visitRows, settings] = await Promise.all([
    tp.servicePlan.findMany({
      where: { property: { roundId: { in: ids } }, status: { in: [LifecycleStatus.ACTIVE, LifecycleStatus.PAUSED] } },
      select: { price: true, cleaningFrequency: true, status: true, nextDueDate: true, pauseEndDate: true, property: { select: { roundId: true } } },
    }),
    tp.visit.groupBy({
      by: ["roundId", "date", "status"],
      where: { roundId: { in: ids }, status: { not: VisitStatus.CANCELLED }, date: { gte: today } },
    }),
    getCachedBusinessSettings(tp),
  ]);
  const workingDays = settings?.defaultWorkingDays ?? [];

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

    // "Next": the earliest upcoming real (scheduled / in progress) visit, else the earliest date a plan comes due.
    const upcoming = roundVisits.filter((v) => v.status === VisitStatus.SCHEDULED || v.status === VisitStatus.IN_PROGRESS).map((v) => v.date.getTime());
    const candidates: number[] = [];
    for (const p of roundPlans) {
      if (p.status === LifecycleStatus.ACTIVE && p.nextDueDate) candidates.push(Math.max(startOfUtcDay(p.nextDueDate).getTime(), today.getTime()));
      if (p.status === LifecycleStatus.PAUSED && p.pauseEndDate) candidates.push(resumeOf(p).getTime());
    }
    const pool = upcoming.length > 0 ? upcoming : candidates;
    if (pool.length === 0) continue;

    const series = projectionSeries(new Date(Math.min(...pool)), frequency, round.defaultDay, workingDays);

    // Real visits win: a date that already has visits is real, and nothing at or before it in the series is projected.
    const realKeys = new Set(roundVisits.map((v) => dayKey(v.date)));
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
