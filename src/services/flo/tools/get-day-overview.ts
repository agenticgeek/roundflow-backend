import { VisitStatus } from "../../../generated/tenant-client";
import type { ResultRow, ToolDefinition } from "../types";
import { addDays, columns, dayToDate, localTimeOf, optDate, parseArgs, pct, round2, tenantClock, toDateRange } from "./shared";

// get_day_overview(date?): what is on a day, who is behind, summarise yesterday. One row per round.
// B0 note: today.service.getTodaysWork is bound to "today" and its row builders are private, so this runs read-only
// visit queries for any date. O4: every figure comes from database groupBy aggregates (no rows are scanned in memory),
// so the totals are exact for any size of day and `truncated` is always false.

interface Args {
  date?: string;
}

/** behindBy assumes a 08:00 to 17:00 local working day: stops are expected to finish at an even pace across it. */
const WORK_START_MIN = 8 * 60;
const WORK_END_MIN = 17 * 60;

const COLUMNS = columns(
  ["round", "Round", "text"],
  ["technician", "Technician", "text"],
  ["total", "Stops", "integer"],
  ["completed", "Completed", "integer"],
  ["skipped", "Skipped", "integer"],
  ["inProgress", "In progress", "integer"],
  ["remaining", "Still to do", "integer"],
  ["scheduledValue", "Scheduled value", "currency"],
  ["completedValue", "Completed value", "currency"],
  ["completionRate", "Completion rate", "percent"],
  ["valueAtRisk", "Value at risk", "currency"],
  ["behindBy", "Behind by (stops)", "integer"],
  ["firstCompletedAt", "First completed", "text"],
  ["lastCompletedAt", "Last completed", "text"]
);

interface RoundAgg {
  technicians: Set<string>;
  total: number;
  completed: number;
  skipped: number;
  inProgress: number;
  scheduledValue: number;
  completedValue: number;
  first: string | null;
  last: string | null;
}

const blank = (): RoundAgg => ({ technicians: new Set(), total: 0, completed: 0, skipped: 0, inProgress: 0, scheduledValue: 0, completedValue: 0, first: null, last: null });

/** Share of the day's stops that should be finished by now: 1 for a past day, 0 for a future day, a working-hours ramp today. */
function expectedShare(day: string, today: string, localTime: string): number {
  if (day < today) return 1;
  if (day > today) return 0;
  const [h, m] = localTime.split(":").map(Number);
  return Math.min(1, Math.max(0, (h * 60 + m - WORK_START_MIN) / (WORK_END_MIN - WORK_START_MIN)));
}

export const getDayOverview: ToolDefinition<Args> = {
  name: "get_day_overview",
  label: "Today's work",
  readOnly: true,
  description:
    "Visits for one day grouped by round: stops, completed, skipped, in progress, still to do, their value, completion rate, value at risk and how far behind each round is. Use for 'what is on today', 'who is behind' and 'summarise yesterday'. " +
    "Do NOT use for a date range or a week (use list_rounds_due for upcoming rounds, revenue_summary for revenue over time) or for one technician's performance over a period (use compare_technicians). " +
    "date is YYYY-MM-DD in the business's local time; omit for today. Example: {\"date\":\"2026-11-09\"}. " +
    "Fields: completionRate = completed / stops as a percentage (null when no stops); valueAtRisk = pounds of stops not completed (still to do plus skipped); " +
    "behindBy = stops that should be finished by now (even pace across 08:00 to 17:00 local on today, all of a past day, none of a future day) minus those completed or skipped; " +
    "firstCompletedAt and lastCompletedAt are local HH:mm. Cancelled visits are excluded.",
  inputSchema: {
    type: "object",
    properties: { date: { type: "string", description: "YYYY-MM-DD, local business date. Defaults to today." } },
    additionalProperties: false,
  },
  parse(raw) {
    const obj = parseArgs(raw, ["date"]);
    return { date: optDate(obj, "date") };
  },
  async run(args, ctx) {
    const clock = await tenantClock(ctx);
    const tp = ctx.tenantPrisma;
    const day = args.date ?? clock.today;
    const where = { date: { gte: dayToDate(day), lt: dayToDate(addDays(day, 1)) }, status: { not: VisitStatus.CANCELLED } };
    const [byStatus, byTech, times] = await Promise.all([
      tp.visit.groupBy({ by: ["roundId", "status"], where, _count: true, _sum: { price: true } }),
      tp.visit.groupBy({ by: ["roundId", "technicianId"], where: { ...where, technicianId: { not: null } }, _count: true }),
      tp.visit.groupBy({
        by: ["roundId"],
        where: { date: where.date, status: VisitStatus.COMPLETED, completedAt: { not: null } },
        _min: { completedAt: true },
        _max: { completedAt: true },
      }),
    ]);
    const roundIds = [...new Set([...byStatus, ...byTech, ...times].map((g) => g.roundId).filter((id): id is string => id !== null))];
    const techIds = [...new Set(byTech.map((g) => g.technicianId).filter((id): id is string => id !== null))];
    const [rounds, techs] = await Promise.all([
      roundIds.length === 0 ? [] : tp.round.findMany({ where: { id: { in: roundIds } }, select: { id: true, name: true } }),
      techIds.length === 0 ? [] : tp.technician.findMany({ where: { id: { in: techIds } }, select: { id: true, name: true } }),
    ]);
    const roundName = new Map(rounds.map((r) => [r.id, r.name]));
    const techName = new Map(techs.map((t) => [t.id, t.name]));
    const nameOf = (id: string | null): string => (id === null ? "No round" : roundName.get(id) ?? "Unknown round");

    const byRound = new Map<string, RoundAgg>();
    const agg = (id: string | null): RoundAgg => {
      const key = nameOf(id);
      const r = byRound.get(key) ?? blank();
      byRound.set(key, r);
      return r;
    };
    for (const g of byStatus) {
      const r = agg(g.roundId);
      const n = g._count as unknown as number;
      const value = Number(g._sum.price ?? 0);
      r.total += n;
      r.scheduledValue += value;
      if (g.status === VisitStatus.COMPLETED) {
        r.completed += n;
        r.completedValue += value;
      } else if (g.status === VisitStatus.SKIPPED) r.skipped += n;
      else if (g.status === VisitStatus.IN_PROGRESS) r.inProgress += n;
    }
    for (const g of byTech) {
      const name = g.technicianId ? techName.get(g.technicianId) : undefined;
      if (name) agg(g.roundId).technicians.add(name);
    }
    for (const g of times) {
      const r = agg(g.roundId);
      const first = g._min.completedAt ? localTimeOf(g._min.completedAt, clock.tz) : null;
      const last = g._max.completedAt ? localTimeOf(g._max.completedAt, clock.tz) : null;
      if (first && (r.first === null || first < r.first)) r.first = first;
      if (last && (r.last === null || last > r.last)) r.last = last;
    }

    const share = expectedShare(day, clock.today, localTimeOf(clock.now, clock.tz));
    const behind = (total: number, done: number) => Math.max(0, Math.round(total * share) - done);
    const rows: ResultRow[] = [...byRound.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([round, r]) => ({
        round,
        technician: [...r.technicians].sort().join(", ") || null,
        total: r.total,
        completed: r.completed,
        skipped: r.skipped,
        inProgress: r.inProgress,
        remaining: r.total - r.completed - r.skipped,
        scheduledValue: round2(r.scheduledValue),
        completedValue: round2(r.completedValue),
        completionRate: pct(r.completed, r.total),
        valueAtRisk: round2(r.scheduledValue - r.completedValue),
        behindBy: behind(r.total, r.completed + r.skipped),
        firstCompletedAt: r.first,
        lastCompletedAt: r.last,
      }));
    const sum = (k: string) => rows.reduce((n, r) => n + (r[k] as number), 0);
    const firsts = rows.map((r) => r.firstCompletedAt as string | null).filter((t): t is string => t !== null);
    const lasts = rows.map((r) => r.lastCompletedAt as string | null).filter((t): t is string => t !== null);
    return {
      dateRange: toDateRange(day, day),
      rows,
      totals: rows.length === 0 ? null : {
        round: "Total",
        technician: null,
        total: sum("total"),
        completed: sum("completed"),
        skipped: sum("skipped"),
        inProgress: sum("inProgress"),
        remaining: sum("remaining"),
        scheduledValue: round2(sum("scheduledValue")),
        completedValue: round2(sum("completedValue")),
        completionRate: pct(sum("completed"), sum("total")),
        valueAtRisk: round2(sum("valueAtRisk")),
        behindBy: sum("behindBy"),
        firstCompletedAt: firsts.length === 0 ? null : firsts.reduce((a, b) => (b < a ? b : a)),
        lastCompletedAt: lasts.length === 0 ? null : lasts.reduce((a, b) => (b > a ? b : a)),
      },
      truncated: false,
      columns: COLUMNS,
    };
  },
};
