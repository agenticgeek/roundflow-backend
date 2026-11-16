import { VisitStatus } from "../../../generated/tenant-client";
import { computeTechnicianKpis, periodRange, type DateRange } from "../../technician-kpi.service";
import type { ResultRow, ToolDefinition } from "../types";
import {
  addDays, checkRange, columns, dayToDate, optDate, optEnum, parseArgs, pct, previousWindow, round2, safeDiv, SCAN_CAP, tenantClock, toDateRange, ToolInputError,
} from "./shared";

// compare_technicians(period | from,to, compare?): one row per technician with the same KPI maths as the technician KPI
// dashboard (technician-kpi.service.computeTechnicianKpis), plus skipped visits, completion/skip rates, average job
// value and average time on site for the same window. compare:true adds the equivalent previous period.

const PERIODS = ["thisMonth", "lastMonth", "thisYear", "last30", "last90"] as const;
type Period = (typeof PERIODS)[number];

interface Args {
  period?: Period;
  from?: string;
  to?: string;
  compare?: boolean;
}

const BASE = columns(
  ["technician", "Technician", "text"],
  ["jobs", "Jobs completed", "integer"],
  ["skipped", "Skipped", "integer"],
  ["revenue", "Revenue", "currency"],
  ["revenuePerHour", "Revenue per hour", "currency"],
  ["issues", "Issues raised", "integer"],
  ["complaints", "Complaints", "integer"],
  ["strikes", "Strikes", "integer"],
  ["completionRate", "Completion rate", "percent"],
  ["skipRate", "Skip rate", "percent"],
  ["avgJobValue", "Average job value", "currency"],
  ["avgMinutesOnSite", "Avg minutes on site", "integer"]
);
const COMPARE = columns(
  ["previousJobs", "Previous jobs", "integer"],
  ["previousRevenue", "Previous revenue", "currency"],
  ["jobsChange", "Jobs change", "integer"],
  ["revenueChange", "Revenue change", "currency"],
  ["revenueChangePercent", "Revenue change %", "percent"]
);

/** The previous period: whole previous calendar month or year for month/year periods, otherwise the same number of days just before. */
function previousRange(period: Period | undefined, from: string, to: string): { from: string; to: string } {
  const prevTo = addDays(from, -1);
  if (period === "thisMonth" || period === "lastMonth") return { from: `${prevTo.slice(0, 8)}01`, to: prevTo };
  if (period === "thisYear") return { from: `${prevTo.slice(0, 4)}-01-01`, to: prevTo };
  return previousWindow(from, to);
}

export const compareTechnicians: ToolDefinition<Args> = {
  name: "compare_technicians",
  label: "Technicians",
  readOnly: true,
  description:
    "Compare technicians over a period: jobs completed, skipped visits, revenue in pounds, revenue per hour, issues, complaints, strikes, completion rate, skip rate, average job value and average minutes on site. " +
    "Give either period (thisMonth, lastMonth, thisYear, last30, last90) or from and to (YYYY-MM-DD, inclusive, max 366 days). Default thisMonth. Set compare true to also get the previous period (previous calendar month or year, or the same number of days just before) with change in jobs and revenue. " +
    "Use for 'compare my technicians for October' and 'is Liam doing better than last month'. " +
    "Do NOT use for the roster or who is on which round (use list_technicians), for one day's progress (use get_day_overview), or for a list of complaints (use list_complaints). " +
    "Complaints, issues and strikes here come from the technician KPI service (complaints logged in the period, upheld complaints count as strikes): they can differ from list_complaints, which counts by current status, so do not mix the two. " +
    "Example: {\"period\":\"lastMonth\",\"compare\":true}. " +
    "Fields: completionRate = completed / (visits due up to today) as a percentage; skipRate = skipped / the same visits; avgJobValue = revenue / jobs; avgMinutesOnSite = mean of completedAt minus arrivedAt over completed visits that have both; " +
    "revenuePerHour = pounds per hour between startedAt and completedAt; null means not enough data, never zero.",
  inputSchema: {
    type: "object",
    properties: {
      period: { type: "string", enum: [...PERIODS] },
      from: { type: "string", description: "YYYY-MM-DD" },
      to: { type: "string", description: "YYYY-MM-DD" },
      compare: { type: "boolean", description: "Also return the equivalent previous period and the change" },
    },
    additionalProperties: false,
  },
  parse(raw) {
    const obj = parseArgs(raw, ["period", "from", "to", "compare"]);
    const compare = obj.compare;
    if (compare !== undefined && compare !== null && typeof compare !== "boolean") throw new ToolInputError('"compare" must be true or false');
    const args: Args = { period: optEnum(obj, "period", PERIODS), from: optDate(obj, "from"), to: optDate(obj, "to") };
    if (compare === true) args.compare = true;
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
    const prevDays = args.compare ? previousRange(args.period, from, to) : null;
    const prevRange: DateRange | null = prevDays ? { start: dayToDate(prevDays.from), end: dayToDate(addDays(prevDays.to, 1)) } : null;
    // Visits "due" count only up to today: a visit later this month is not a miss yet.
    const dueEnd = new Date(Math.min(range.end.getTime(), dayToDate(addDays(clock.today, 1)).getTime()));
    const [kpis, prevKpis] = await Promise.all([computeTechnicianKpis(tp, range), prevRange ? computeTechnicianKpis(tp, prevRange) : null]);
    const known = [...kpis.keys(), ...(prevKpis ? prevKpis.keys() : [])];
    const [technicians, statusGroups, timed] = await Promise.all([
      tp.technician.findMany({
        where: { OR: [{ active: true }, { id: { in: known } }] },
        select: { id: true, name: true },
        orderBy: { name: "asc" },
      }),
      tp.visit.groupBy({
        by: ["technicianId", "status"],
        where: { status: { not: VisitStatus.CANCELLED }, date: { gte: range.start, lt: dueEnd }, technicianId: { not: null } },
        _count: true,
      }),
      tp.visit.findMany({
        where: { status: VisitStatus.COMPLETED, date: { gte: range.start, lt: range.end }, technicianId: { not: null }, arrivedAt: { not: null }, completedAt: { not: null } },
        select: { technicianId: true, arrivedAt: true, completedAt: true },
        take: SCAN_CAP + 1,
      }),
    ]);

    const counts = new Map<string, { due: number; completed: number; skipped: number }>();
    for (const g of statusGroups) {
      const c = counts.get(g.technicianId as string) ?? { due: 0, completed: 0, skipped: 0 };
      const n = g._count as unknown as number;
      c.due += n;
      if (g.status === VisitStatus.COMPLETED) c.completed += n;
      else if (g.status === VisitStatus.SKIPPED) c.skipped += n;
      counts.set(g.technicianId as string, c);
    }
    const onSite = new Map<string, { minutes: number; n: number }>();
    let allMinutes = 0;
    let allTimed = 0;
    for (const v of timed.slice(0, SCAN_CAP)) {
      if (!v.arrivedAt || !v.completedAt) continue;
      const ms = v.completedAt.getTime() - v.arrivedAt.getTime();
      if (ms <= 0) continue;
      const t = onSite.get(v.technicianId as string) ?? { minutes: 0, n: 0 };
      t.minutes += ms / 60_000;
      t.n += 1;
      onSite.set(v.technicianId as string, t);
      allMinutes += ms / 60_000;
      allTimed += 1;
    }

    const compare = args.compare === true;
    const built = technicians.map((t) => {
      const k = kpis.get(t.id);
      const c = counts.get(t.id) ?? { due: 0, completed: 0, skipped: 0 };
      const s = onSite.get(t.id);
      const rph = k?.revenuePerHour;
      const jobs = k?.jobsCompleted ?? 0;
      const revenue = round2(k?.valueCompleted ?? 0);
      const row: ResultRow = {
        technician: t.name ?? "Unnamed technician",
        jobs,
        skipped: c.skipped,
        revenue,
        revenuePerHour: rph == null ? null : round2(rph),
        issues: k?.issueCount ?? 0,
        complaints: k?.complaints ?? 0,
        strikes: k?.strikes ?? 0,
        completionRate: pct(c.completed, c.due),
        skipRate: pct(c.skipped, c.due),
        avgJobValue: safeDiv(revenue, jobs),
        avgMinutesOnSite: s ? Math.round(s.minutes / s.n) : null,
      };
      if (prevKpis) {
        const p = prevKpis.get(t.id);
        const prevJobs = p?.jobsCompleted ?? 0;
        const prevRevenue = round2(p?.valueCompleted ?? 0);
        Object.assign(row, {
          previousJobs: prevJobs,
          previousRevenue: prevRevenue,
          jobsChange: jobs - prevJobs,
          revenueChange: round2(revenue - prevRevenue),
          revenueChangePercent: pct(revenue - prevRevenue, prevRevenue),
        });
      }
      return { row, c };
    });
    built.sort((a, b) => (b.row.revenue as number) - (a.row.revenue as number) || (a.row.technician as string).localeCompare(b.row.technician as string));
    const rows = built.map((b) => b.row);
    const sum = (key: string) => rows.reduce((n, r) => n + (r[key] as number), 0);
    const due = built.reduce((n, b) => n + b.c.due, 0);
    const totalRevenue = round2(sum("revenue"));
    const totalJobs = sum("jobs");
    const totals: ResultRow | null = rows.length === 0 ? null : {
      technician: "Total",
      jobs: totalJobs,
      skipped: sum("skipped"),
      revenue: totalRevenue,
      revenuePerHour: null,
      issues: sum("issues"),
      complaints: sum("complaints"),
      strikes: sum("strikes"),
      completionRate: pct(built.reduce((n, b) => n + b.c.completed, 0), due),
      skipRate: pct(built.reduce((n, b) => n + b.c.skipped, 0), due),
      avgJobValue: safeDiv(totalRevenue, totalJobs),
      avgMinutesOnSite: allTimed === 0 ? null : Math.round(allMinutes / allTimed),
    };
    if (totals && prevKpis) {
      const prevJobs = sum("previousJobs");
      const prevRevenue = round2(sum("previousRevenue"));
      Object.assign(totals, {
        previousJobs: prevJobs,
        previousRevenue: prevRevenue,
        jobsChange: totalJobs - prevJobs,
        revenueChange: round2(totalRevenue - prevRevenue),
        revenueChangePercent: pct(totalRevenue - prevRevenue, prevRevenue),
      });
    }
    return {
      dateRange: toDateRange(from, to),
      rows,
      totals,
      truncated: timed.length > SCAN_CAP,
      columns: compare ? [...BASE, ...COMPARE] : BASE,
    };
  },
};
