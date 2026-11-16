import { VisitStatus } from "../../../generated/tenant-client";
import type { ResultRow, ToolDefinition, ToolName } from "../types";
import { columns, optDate, parseArgs, parseLimit, resolveRange, round2, SCAN_CAP, tenantClock, toDateRange, visitDateWhere } from "./shared";
import { minutesBetween, pct, sortedUnique } from "./e2-helpers";

// round_performance(from?, to?, limit?): one row per round over a range, built from the visits in the range
// (cancelled visits are ignored). Stops = scheduled + in progress + completed + skipped visits. "Value" is the visit price.

interface Args {
  from?: string;
  to?: string;
  limit: number;
}

const COLUMNS = columns(
  ["round", "Round", "text"],
  ["properties", "Properties served", "integer"],
  ["stops", "Stops", "integer"],
  ["completed", "Completed", "integer"],
  ["skipped", "Skipped", "integer"],
  ["scheduledValue", "Scheduled value", "currency"],
  ["completedValue", "Completed value", "currency"],
  ["completionRate", "Completion rate", "percent"],
  ["skipRate", "Skip rate", "percent"],
  ["revenuePerStop", "Revenue per completed stop", "currency"],
  ["avgMinutesOnSite", "Avg minutes on site", "integer"],
  ["technicians", "Technicians", "text"]
);

interface Bucket {
  name: string;
  properties: Set<string>;
  stops: number;
  completed: number;
  skipped: number;
  scheduledValue: number;
  completedValue: number;
  minutes: number;
  timed: number;
  technicians: Set<string>;
}

const empty = (name: string): Bucket => ({ name, properties: new Set(), stops: 0, completed: 0, skipped: 0, scheduledValue: 0, completedValue: 0, minutes: 0, timed: 0, technicians: new Set() });

function toRow(name: string, b: Bucket, technicians: string | null): ResultRow {
  return {
    round: name,
    properties: b.properties.size,
    stops: b.stops,
    completed: b.completed,
    skipped: b.skipped,
    scheduledValue: round2(b.scheduledValue),
    completedValue: round2(b.completedValue),
    completionRate: pct(b.completed, b.stops),
    skipRate: pct(b.skipped, b.stops),
    revenuePerStop: b.completed === 0 ? null : round2(b.completedValue / b.completed),
    avgMinutesOnSite: b.timed === 0 ? null : Math.round(b.minutes / b.timed),
    technicians,
  };
}

export const roundPerformance: ToolDefinition<Args> = {
  name: "round_performance",
  label: "Round performance",
  readOnly: true,
  description:
    "How each round performed over a date range (YYYY-MM-DD inclusive, max 366 days; default this month so far): properties served, stops, completed and skipped visits, scheduled and completed value in pounds, completion rate and skip rate (percent), revenue per completed stop, average minutes on site (arrival to completion) and the technicians who worked it. Sorted by completed value, highest first, with a Total row. Use for 'which round makes the most money', 'which round skips the most', 'how long do we spend on Round 7'. Do not use for revenue by technician or service area (revenue_summary), a list of skipped visits (list_skipped_visits) or future weeks (forecast_schedule). Example: {\"from\":\"2026-10-01\",\"to\":\"2026-10-31\"}. Glossary: stops = scheduled, in progress, completed and skipped visits (cancelled ignored); scheduledValue = price of all those stops; completedValue = price of completed ones; avgMinutesOnSite is only over completed visits that have both an arrival and a completion time.",
  inputSchema: {
    type: "object",
    properties: {
      from: { type: "string", description: "YYYY-MM-DD, default first day of this month" },
      to: { type: "string", description: "YYYY-MM-DD, default today" },
      limit: { type: "integer", description: "Max rounds, 1 to 200, default 50" },
    },
    additionalProperties: false,
  },
  parse(raw) {
    const obj = parseArgs(raw, ["from", "to", "limit"]);
    return { from: optDate(obj, "from"), to: optDate(obj, "to"), limit: parseLimit(obj) };
  },
  async run(args, ctx) {
    const clock = await tenantClock(ctx);
    const { from, to } = resolveRange(args, clock);
    const visits = await ctx.tenantPrisma.visit.findMany({
      where: { date: visitDateWhere(from, to), status: { in: [VisitStatus.SCHEDULED, VisitStatus.IN_PROGRESS, VisitStatus.COMPLETED, VisitStatus.SKIPPED] } },
      select: {
        status: true,
        price: true,
        propertyId: true,
        arrivedAt: true,
        completedAt: true,
        roundId: true,
        round: { select: { name: true } },
        technician: { select: { name: true } },
      },
      take: SCAN_CAP + 1,
    });
    const groups = new Map<string, Bucket>();
    const all = empty("Total");
    for (const v of visits.slice(0, SCAN_CAP)) {
      const key = v.roundId ?? "none";
      const b = groups.get(key) ?? empty(v.round?.name ?? "No round");
      groups.set(key, b);
      for (const t of [b, all]) {
        const price = Number(v.price);
        t.properties.add(v.propertyId);
        t.stops += 1;
        t.scheduledValue += price;
        if (v.technician?.name) t.technicians.add(v.technician.name);
        if (v.status === VisitStatus.SKIPPED) t.skipped += 1;
        if (v.status === VisitStatus.COMPLETED) {
          t.completed += 1;
          t.completedValue += price;
          const m = minutesBetween(v.arrivedAt, v.completedAt);
          if (m !== null) {
            t.minutes += m;
            t.timed += 1;
          }
        }
      }
    }
    const sorted = [...groups.values()].sort((a, b) => b.completedValue - a.completedValue || a.name.localeCompare(b.name));
    const rows = sorted.slice(0, args.limit).map((b) => toRow(b.name, b, sortedUnique(b.technicians).join(", ") || null));
    return {
      dateRange: toDateRange(from, to),
      rows,
      totals: sorted.length === 0 ? null : { ...toRow("Total", all, null), rounds: sorted.length },
      truncated: visits.length > SCAN_CAP || sorted.length > rows.length,
      columns: COLUMNS,
    };
  },
};
