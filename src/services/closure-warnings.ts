import type { TenantPrismaClient } from "../lib/tenant-prisma-manager";
import { activeClosures, closuresCovering, type ClosureWindow } from "../lib/closures";
import type { ClosureWarning } from "../lib/closure-types";

// Business closures, rules s7: non-blocking DATE_IN_CLOSURE warnings on reschedule, carryover,
// the carryover options and close-day. Never blocks a move and never fails one.

const iso = (d: Date) => d.toISOString().slice(0, 10);

/**
 * The active closures (endDate >= today) in ONE query. Best effort: the move this serves is already
 * decided or done, so a failed lookup means "no warnings", never an error for the caller.
 */
export async function loadActiveClosures(prisma: TenantPrismaClient, today: Date): Promise<ClosureWindow[]> {
  try {
    const rows = await prisma.businessClosure.findMany({
      where: { endDate: { gte: today } },
      select: { id: true, label: true, startDate: true, endDate: true, mode: true, roundIds: true },
    });
    return activeClosures(rows, today);
  } catch (err) {
    console.error("[closures] loading closures for warnings failed:", err);
    return [];
  }
}

const bySchedule = (a: ClosureWindow, b: ClosureWindow) =>
  a.startDate.getTime() - b.startDate.getTime() || a.id.localeCompare(b.id);

/** Closures covering `date` for any of `roundIds` (null = a visit without a round: only all-rounds closures), de-duplicated, sorted by startDate. */
function covering(date: Date, roundIds: readonly (string | null)[], closures: readonly ClosureWindow[]): ClosureWindow[] {
  const found = new Map<string, ClosureWindow>();
  for (const roundId of new Set(roundIds)) {
    for (const c of closuresCovering(date, roundId ?? "", closures)) found.set(c.id, c);
  }
  return [...found.values()].sort(bySchedule);
}

/** The warnings for moving visits of `roundIds` onto `date`; undefined when nothing covers it (the field stays absent). */
export function closureWarnings(
  date: Date,
  roundIds: readonly (string | null)[],
  closures: readonly ClosureWindow[],
): ClosureWarning[] | undefined {
  const cov = covering(date, roundIds, closures);
  if (cov.length === 0) return undefined;
  return cov.map((c) => ({
    code: "DATE_IN_CLOSURE" as const,
    closureId: c.id,
    label: c.label,
    startDate: iso(c.startDate),
    endDate: iso(c.endDate),
  }));
}

/** The closure to flag on a carryover option for `date` (options are not tied to a round: any active closure counts). */
export function closureMarker(date: Date, closures: readonly ClosureWindow[]): { closureId: string; label: string } | undefined {
  const [first] = closures.filter((c) => c.startDate.getTime() <= date.getTime() && date.getTime() <= c.endDate.getTime()).sort(bySchedule);
  return first ? { closureId: first.id, label: first.label } : undefined;
}
