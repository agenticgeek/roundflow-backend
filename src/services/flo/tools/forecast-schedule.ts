import { RoundStatus, VisitStatus } from "../../../generated/tenant-client";
import { projectOccurrences } from "../../round-projection";
import type { ResultRow, ToolDefinition, ToolName } from "../types";
import { addDays, columns, daysBetween, dateToDay, dayToDate, optInt, parseArgs, parseLimit, round2, SCAN_CAP, tenantClock, toDateRange } from "./shared";
import { clip, sortedUnique } from "./e2-helpers";

// forecast_schedule(weeks?, limit?): the next N weeks (default 4, max 12) from today, in 7-day weeks starting today.
// Scheduled stops and value come from existing Visit rows (SCHEDULED or IN_PROGRESS, one-offs included). Dates the
// nightly job has not generated yet are added from round-projection.projectOccurrences (read-only, display forecast:
// at most the next 4 occurrences per round, within its 13-week horizon, never creates a visit). Weeks that overlap a
// BusinessClosure are flagged.

interface Args {
  weeks: number;
  limit: number;
}

const DEFAULT_WEEKS = 4;
const MAX_WEEKS = 12;

const COLUMNS = columns(
  ["weekStart", "Week starts", "date"],
  ["weekEnd", "Week ends", "date"],
  ["round", "Round", "text"],
  ["scheduledStops", "Scheduled stops", "integer"],
  ["projectedStops", "Projected stops", "integer"],
  ["stops", "Total stops", "integer"],
  ["value", "Value", "currency"],
  ["closure", "Closure in the way", "text"]
);

interface Cell {
  name: string;
  scheduled: number;
  projected: number;
  value: number;
}

interface ClosureRow {
  label: string;
  startDate: Date;
  endDate: Date;
  roundIds: string[];
}

export const forecastSchedule: ToolDefinition<Args> = {
  name: "forecast_schedule",
  label: "Schedule forecast",
  readOnly: true,
  description:
    "The next N weeks of work (default 4, max 12; 7-day weeks starting today): stops and value in pounds per week and per round, split into already scheduled visits and projected stops (dates the system has not generated visits for yet, forecast from each round's frequency, at most the next 4 occurrences per round), and a flag on weeks that overlap a business closure. Each week has an 'All rounds' row followed by its rounds, highest value first. Use for 'how busy is next month', 'what revenue is booked for the next 4 weeks', 'does the closure hit any week'. Do not use for past results (round_performance, revenue_summary) or a single day (get_day_overview). Example: {\"weeks\":6}. Glossary: scheduledStops/value come from real visits; projectedStops are estimates and projected value is the sum of the plan prices due; closure names the closure(s) overlapping that week for that round.",
  inputSchema: {
    type: "object",
    properties: {
      weeks: { type: "integer", description: "How many weeks ahead, 1 to 12, default 4" },
      limit: { type: "integer", description: "Max rows, 1 to 200, default 50" },
    },
    additionalProperties: false,
  },
  parse(raw) {
    const obj = parseArgs(raw, ["weeks", "limit"]);
    return { weeks: optInt(obj, "weeks", 1, MAX_WEEKS) ?? DEFAULT_WEEKS, limit: parseLimit(obj) };
  },
  async run(args, ctx) {
    const tp = ctx.tenantPrisma;
    const clock = await tenantClock(ctx);
    const from = clock.today;
    const to = addDays(from, args.weeks * 7 - 1);
    const weekOf = (day: string) => Math.floor(daysBetween(from, day) / 7);

    const [visits, rounds, closures] = await Promise.all([
      tp.visit.findMany({
        where: { date: { gte: dayToDate(from), lt: dayToDate(addDays(to, 1)) }, status: { in: [VisitStatus.SCHEDULED, VisitStatus.IN_PROGRESS] } },
        select: { date: true, price: true, roundId: true, round: { select: { name: true } } },
        take: SCAN_CAP + 1,
      }),
      tp.round.findMany({ where: { status: RoundStatus.ACTIVE }, select: { id: true, name: true }, take: SCAN_CAP }),
      tp.businessClosure.findMany({
        where: { startDate: { lte: dayToDate(to) }, endDate: { gte: dayToDate(from) } },
        select: { label: true, startDate: true, endDate: true, roundIds: true },
        orderBy: { startDate: "asc" },
      }),
    ]);

    const weeks: Array<Map<string, Cell>> = Array.from({ length: args.weeks }, () => new Map());
    const cell = (week: number, roundId: string | null, name: string): Cell => {
      const key = roundId ?? "none";
      const c = weeks[week].get(key) ?? { name, scheduled: 0, projected: 0, value: 0 };
      weeks[week].set(key, c);
      return c;
    };
    for (const v of visits.slice(0, SCAN_CAP)) {
      const c = cell(weekOf(dateToDay(v.date)), v.roundId, v.round?.name ?? "No round");
      c.scheduled += 1;
      c.value += Number(v.price);
    }

    const names = new Map(rounds.map((r) => [r.id, r.name]));
    const projected = await projectOccurrences(tp, rounds.map((r) => r.id), dayToDate(from), dayToDate(from), dayToDate(to));
    for (const [roundId, entries] of projected) {
      for (const e of entries) {
        const c = cell(weekOf(e.date), roundId, names.get(roundId) as string);
        c.projected += e.stopCount;
        c.value += e.totalValue;
      }
    }

    const closureText = (list: ClosureRow[]): string | null => (list.length === 0 ? null : sortedUnique(list.map((c) => clip(c.label, 60))).join("; "));
    const all: ResultRow[] = [];
    let scheduledTotal = 0;
    let projectedTotal = 0;
    let valueTotal = 0;
    weeks.forEach((w, i) => {
      const weekStart = addDays(from, i * 7);
      const weekEnd = addDays(weekStart, 6);
      const overlapping = closures.filter((c) => dateToDay(c.startDate) <= weekEnd && dateToDay(c.endDate) >= weekStart);
      const cells = [...w.entries()].sort((a, b) => b[1].value - a[1].value || a[1].name.localeCompare(b[1].name));
      const sched = cells.reduce((n, [, c]) => n + c.scheduled, 0);
      const proj = cells.reduce((n, [, c]) => n + c.projected, 0);
      const value = cells.reduce((n, [, c]) => n + c.value, 0);
      scheduledTotal += sched;
      projectedTotal += proj;
      valueTotal += value;
      all.push({ weekStart, weekEnd, round: "All rounds", scheduledStops: sched, projectedStops: proj, stops: sched + proj, value: round2(value), closure: closureText(overlapping) });
      for (const [key, c] of cells) {
        const applies = overlapping.filter((cl) => cl.roundIds.length === 0 || (key !== "none" && cl.roundIds.includes(key)));
        all.push({ weekStart, weekEnd, round: c.name, scheduledStops: c.scheduled, projectedStops: c.projected, stops: c.scheduled + c.projected, value: round2(c.value), closure: closureText(applies) });
      }
    });
    const rows = all.slice(0, args.limit);
    return {
      dateRange: toDateRange(from, to),
      rows,
      totals: { weekStart: null, weekEnd: null, round: "Total", scheduledStops: scheduledTotal, projectedStops: projectedTotal, stops: scheduledTotal + projectedTotal, value: round2(valueTotal), closure: null },
      truncated: visits.length > SCAN_CAP || all.length > rows.length,
      columns: COLUMNS,
    };
  },
};
