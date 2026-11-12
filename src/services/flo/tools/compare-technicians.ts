import { VisitStatus } from "../../../generated/tenant-client";
import { computeTechnicianKpis, periodRange, type DateRange } from "../../technician-kpi.service";
import type { ResultRow, ToolDefinition } from "../types";
import {
  addDays, checkRange, columns, dayToDate, optDate, optEnum, parseArgs, round2, tenantClock, toDateRange, ToolInputError,
} from "./shared";

// compare_technicians(period | from,to): one row per technician with the same KPI maths as the technician KPI
// dashboard (technician-kpi.service.computeTechnicianKpis), plus skipped visits for the same window.

const PERIODS = ["thisMonth", "lastMonth", "thisYear", "last30", "last90"] as const;

interface Args {
  period?: (typeof PERIODS)[number];
  from?: string;
  to?: string;
}

const COLUMNS = columns(
  ["technician", "Technician", "text"],
  ["jobs", "Jobs completed", "integer"],
  ["skipped", "Skipped", "integer"],
  ["revenue", "Revenue", "currency"],
  ["revenuePerHour", "Revenue per hour", "currency"],
  ["issues", "Issues raised", "integer"],
  ["complaints", "Complaints", "integer"],
  ["strikes", "Strikes", "integer"]
);

export const compareTechnicians: ToolDefinition<Args> = {
  name: "compare_technicians",
  label: "Technicians",
  readOnly: true,
  description:
    "Compare technicians over a period: jobs completed, skipped visits, revenue in pounds, revenue per hour, issues, complaints and strikes. Give either period (thisMonth, lastMonth, thisYear, last30, last90) or from and to (YYYY-MM-DD, inclusive, max 366 days). Default thisMonth. Use for 'compare my technicians for October'.",
  inputSchema: {
    type: "object",
    properties: {
      period: { type: "string", enum: [...PERIODS] },
      from: { type: "string", description: "YYYY-MM-DD" },
      to: { type: "string", description: "YYYY-MM-DD" },
    },
    additionalProperties: false,
  },
  parse(raw) {
    const obj = parseArgs(raw, ["period", "from", "to"]);
    const args: Args = { period: optEnum(obj, "period", PERIODS), from: optDate(obj, "from"), to: optDate(obj, "to") };
    if (args.period && (args.from || args.to)) throw new ToolInputError("Give either period or from/to, not both");
    if (!args.period && (args.from === undefined) !== (args.to === undefined)) throw new ToolInputError("from and to must be given together");
    return args;
  },
  async run(args, ctx) {
    const clock = await tenantClock(ctx);
    let range: DateRange;
    let from: string;
    let to: string;
    if (args.from && args.to) {
      ({ from, to } = checkRange(args.from, args.to));
      range = { start: dayToDate(from), end: dayToDate(addDays(to, 1)) };
    } else {
      // The KPI service computes UTC calendar ranges; feed it the tenant-local date so a month boundary is local.
      range = periodRange(args.period ?? "thisMonth", new Date(`${clock.today}T12:00:00.000Z`));
      from = range.start.toISOString().slice(0, 10);
      to = addDays(range.end.toISOString().slice(0, 10), -1);
    }
    const tp = ctx.tenantPrisma;
    const kpis = await computeTechnicianKpis(tp, range);
    const [technicians, skips] = await Promise.all([
      tp.technician.findMany({
        where: { OR: [{ active: true }, { id: { in: [...kpis.keys()] } }] },
        select: { id: true, name: true },
        orderBy: { name: "asc" },
      }),
      tp.visit.groupBy({
        by: ["technicianId"],
        where: { status: VisitStatus.SKIPPED, date: { gte: range.start, lt: range.end }, technicianId: { not: null } },
        _count: true,
      }),
    ]);
    const skipped = new Map(skips.map((s) => [s.technicianId as string, s._count as unknown as number]));
    const rows: ResultRow[] = technicians
      .map((t) => {
        const k = kpis.get(t.id);
        const rph = k?.revenuePerHour;
        return {
          technician: t.name ?? "Unnamed technician",
          jobs: k?.jobsCompleted ?? 0,
          skipped: skipped.get(t.id) ?? 0,
          revenue: round2(k?.valueCompleted ?? 0),
          revenuePerHour: rph == null ? null : round2(rph),
          issues: k?.issueCount ?? 0,
          complaints: k?.complaints ?? 0,
          strikes: k?.strikes ?? 0,
        };
      })
      .sort((a, b) => (b.revenue as number) - (a.revenue as number) || (a.technician as string).localeCompare(b.technician as string));
    const sum = (key: string) => rows.reduce((n, r) => n + (r[key] as number), 0);
    return {
      dateRange: toDateRange(from, to),
      rows,
      totals: rows.length === 0 ? null : {
        technician: "Total",
        jobs: sum("jobs"),
        skipped: sum("skipped"),
        revenue: round2(sum("revenue")),
        revenuePerHour: null,
        issues: sum("issues"),
        complaints: sum("complaints"),
        strikes: sum("strikes"),
      },
      truncated: false,
      columns: COLUMNS,
    };
  },
};
