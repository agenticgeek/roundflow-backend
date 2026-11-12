import { VisitStatus } from "../../../generated/tenant-client";
import type { ResultRow, ToolDefinition } from "../types";
import { addDays, columns, dayToDate, optDate, parseArgs, round2, SCAN_CAP, tenantClock, toDateRange } from "./shared";

// get_day_overview(date?): what is on a day, who is behind, summarise yesterday. One row per round.
// B0 note: today.service.getTodaysWork is bound to "today" and its row builders are private, so this runs one
// read-only visit query for any date and builds the same per-round figures.

interface Args {
  date?: string;
}

const COLUMNS = columns(
  ["round", "Round", "text"],
  ["technician", "Technician", "text"],
  ["total", "Stops", "integer"],
  ["completed", "Completed", "integer"],
  ["skipped", "Skipped", "integer"],
  ["inProgress", "In progress", "integer"],
  ["remaining", "Still to do", "integer"],
  ["scheduledValue", "Scheduled value", "currency"],
  ["completedValue", "Completed value", "currency"]
);

export const getDayOverview: ToolDefinition<Args> = {
  name: "get_day_overview",
  label: "Today's work",
  readOnly: true,
  description:
    "Visits for one day grouped by round: stops, completed, skipped, in progress, still to do, and their value. Use for 'what is on today', 'who is behind' and 'summarise yesterday'. date is YYYY-MM-DD in the business's local time; omit for today.",
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
    const day = args.date ?? clock.today;
    const start = dayToDate(day);
    const visits = await ctx.tenantPrisma.visit.findMany({
      where: { date: { gte: start, lt: dayToDate(addDays(day, 1)) }, status: { not: VisitStatus.CANCELLED } },
      select: {
        status: true,
        price: true,
        paymentHold: true,
        round: { select: { name: true } },
        technician: { select: { name: true } },
      },
      take: SCAN_CAP + 1,
    });
    const truncated = visits.length > SCAN_CAP;
    const byRound = new Map<string, { technicians: Set<string>; total: number; completed: number; skipped: number; inProgress: number; scheduledValue: number; completedValue: number }>();
    for (const v of visits.slice(0, SCAN_CAP)) {
      const key = v.round?.name ?? "No round";
      const r = byRound.get(key) ?? { technicians: new Set<string>(), total: 0, completed: 0, skipped: 0, inProgress: 0, scheduledValue: 0, completedValue: 0 };
      byRound.set(key, r);
      const price = Number(v.price);
      r.total += 1;
      r.scheduledValue += price;
      if (v.technician?.name) r.technicians.add(v.technician.name);
      if (v.status === VisitStatus.COMPLETED) {
        r.completed += 1;
        r.completedValue += price;
      } else if (v.status === VisitStatus.SKIPPED) r.skipped += 1;
      else if (v.status === VisitStatus.IN_PROGRESS) r.inProgress += 1;
    }
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
      }));
    const sum = (k: string) => rows.reduce((n, r) => n + (r[k] as number), 0);
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
      },
      truncated,
      columns: COLUMNS,
    };
  },
};
