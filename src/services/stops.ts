import { Prisma, VisitStatus } from "../generated/tenant-client";

// A stop is every visit for the same property, on the same day, for the same technician: what the technician
// sees as one door. Visits stay one per service; the stop is derived when reading, never stored, so a reschedule,
// reassignment, carry-over or added service moves a visit between stops with nothing to keep in sync.
// docs/PROPERTY_STOPS_PLAN_2026-11-19.md §3.1, §7.1.

const DAY_MS = 86_400_000;

type StopRef = { propertyId: string; date: Date; technicianId: string | null };

const dayOf = (date: Date) => date.toISOString().slice(0, 10);

/** "<propertyId>|<YYYY-MM-DD>|<technicianId or ->" (the UTC day, which is how visit dates are stored). */
export function stopKeyOf(v: StopRef): string {
  return `${v.propertyId}|${dayOf(v.date)}|${v.technicianId ?? "-"}`;
}

/** Stop order: createdAt, then id. The primary plan's visit is created first, so it leads. */
export function sortStopVisits<T extends { id: string; createdAt: Date }>(visits: readonly T[]): T[] {
  // Ids are unique, so two visits never compare equal.
  return [...visits].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : 1));
}

/** Groups in the order each stop is first seen; the visits inside a stop in stop order. */
export function groupByStop<T extends { id: string; createdAt: Date }>(
  visits: readonly T[],
  keyOf: (v: T) => string,
): Array<{ key: string; visits: T[] }> {
  const groups = new Map<string, T[]>();
  for (const v of visits) {
    const key = keyOf(v);
    const bucket = groups.get(key);
    if (bucket) bucket.push(v);
    else groups.set(key, [v]);
  }
  return [...groups.entries()].map(([key, vs]) => ({ key, visits: sortStopVisits(vs) }));
}

const OPEN: ReadonlySet<VisitStatus> = new Set([VisitStatus.SCHEDULED, VisitStatus.IN_PROGRESS]);
export const isOpenVisit = (status: VisitStatus) => OPEN.has(status);

/**
 * The stop's status from its services: while anything is open it is IN_PROGRESS (if started) or SCHEDULED; once
 * nothing is open it is COMPLETED if anything was done, else SKIPPED. CANCELLED visits are never in a stop.
 */
export function stopStatus(statuses: readonly VisitStatus[]): VisitStatus {
  const live = statuses.filter((s) => s !== VisitStatus.CANCELLED);
  if (live.some(isOpenVisit)) {
    return live.includes(VisitStatus.IN_PROGRESS) ? VisitStatus.IN_PROGRESS : VisitStatus.SCHEDULED;
  }
  return live.includes(VisitStatus.COMPLETED) ? VisitStatus.COMPLETED : VisitStatus.SKIPPED;
}

/** Every visit in `v`'s stop (cancelled ones excluded). */
export function stopWhere(v: StopRef): Prisma.VisitWhereInput {
  const start = new Date(`${dayOf(v.date)}T00:00:00.000Z`);
  return {
    propertyId: v.propertyId,
    technicianId: v.technicianId,
    date: { gte: start, lt: new Date(start.getTime() + DAY_MS) },
    status: { not: VisitStatus.CANCELLED },
  };
}

/** The order every stop query uses (see sortStopVisits). */
export const STOP_ORDER: Prisma.VisitOrderByWithRelationInput[] = [{ createdAt: "asc" }, { id: "asc" }];
