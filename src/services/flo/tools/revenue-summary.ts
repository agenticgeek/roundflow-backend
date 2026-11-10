import { VisitStatus } from "../../../generated/tenant-client";
import type { TenantPrismaClient } from "../../../lib/tenant-prisma-manager";
import type { ResultRow, ToolDefinition } from "../types";
import { checkRange, columns, dateToDay, optDate, optEnum, parseArgs, resolveRange, round2, SCAN_CAP, tenantClock, toDateRange, ToolInputError, visitDateWhere } from "./shared";

// revenue_summary(from?, to?, groupBy?, compareFrom?, compareTo?): revenue = price of COMPLETED visits in the range
// (the same definition reports.service.getRevenue/getSummary use), grouped by service area, round, technician or
// month, optionally against a second range (change in pounds and percent). Reports.service only groups by day for a
// named period, so grouping and arbitrary ranges are one read-only query here.

const GROUPS = ["SERVICE_AREA", "ROUND", "TECHNICIAN", "MONTH"] as const;
type GroupBy = (typeof GROUPS)[number];

interface Args {
  from?: string;
  to?: string;
  groupBy: GroupBy;
  compareFrom?: string;
  compareTo?: string;
}

const PLAIN = columns(
  ["group", "Group", "text"],
  ["revenue", "Revenue", "currency"],
  ["jobs", "Jobs", "integer"],
  ["share", "Share of revenue", "percent"]
);
const COMPARED = columns(
  ["group", "Group", "text"],
  ["revenue", "Revenue", "currency"],
  ["previousRevenue", "Previous period", "currency"],
  ["change", "Change", "currency"],
  ["changePercent", "Change %", "percent"],
  ["jobs", "Jobs", "integer"]
);

interface Bucket {
  revenue: number;
  jobs: number;
}

async function aggregate(tp: TenantPrismaClient, from: string, to: string, groupBy: GroupBy): Promise<{ groups: Map<string, Bucket>; truncated: boolean }> {
  const visits = await tp.visit.findMany({
    where: { date: visitDateWhere(from, to), status: VisitStatus.COMPLETED },
    select: {
      date: true,
      price: true,
      round: { select: { name: true } },
      technician: { select: { name: true } },
      property: { select: { serviceArea: { select: { name: true } } } },
    },
    take: SCAN_CAP + 1,
  });
  const groups = new Map<string, Bucket>();
  for (const v of visits.slice(0, SCAN_CAP)) {
    const key =
      groupBy === "ROUND" ? v.round?.name ?? "No round"
      : groupBy === "TECHNICIAN" ? v.technician?.name ?? "Unassigned"
      : groupBy === "MONTH" ? dateToDay(v.date).slice(0, 7)
      : v.property.serviceArea?.name ?? "No service area";
    const b = groups.get(key) ?? { revenue: 0, jobs: 0 };
    b.revenue += Number(v.price);
    b.jobs += 1;
    groups.set(key, b);
  }
  return { groups, truncated: visits.length > SCAN_CAP };
}

const pct = (part: number, whole: number): number | null => (whole === 0 ? null : round2((part / whole) * 100));

export const revenueSummary: ToolDefinition<Args> = {
  name: "revenue_summary",
  label: "Revenue",
  readOnly: true,
  description:
    "Revenue (value of completed visits, in pounds) for a date range (YYYY-MM-DD inclusive, max 366 days; default this month so far), grouped by SERVICE_AREA (default), ROUND, TECHNICIAN or MONTH. Give compareFrom and compareTo for a second range to get the change in pounds and percent ('this month vs last').",
  inputSchema: {
    type: "object",
    properties: {
      from: { type: "string", description: "YYYY-MM-DD, default first day of this month" },
      to: { type: "string", description: "YYYY-MM-DD, default today" },
      groupBy: { type: "string", enum: [...GROUPS] },
      compareFrom: { type: "string", description: "YYYY-MM-DD, start of the comparison range" },
      compareTo: { type: "string", description: "YYYY-MM-DD, end of the comparison range" },
    },
    additionalProperties: false,
  },
  parse(raw) {
    const obj = parseArgs(raw, ["from", "to", "groupBy", "compareFrom", "compareTo"]);
    const args: Args = {
      from: optDate(obj, "from"),
      to: optDate(obj, "to"),
      groupBy: optEnum(obj, "groupBy", GROUPS) ?? "SERVICE_AREA",
      compareFrom: optDate(obj, "compareFrom"),
      compareTo: optDate(obj, "compareTo"),
    };
    if ((args.compareFrom === undefined) !== (args.compareTo === undefined)) throw new ToolInputError("compareFrom and compareTo must be given together");
    return args;
  },
  async run(args, ctx) {
    const clock = await tenantClock(ctx);
    const { from, to } = resolveRange(args, clock);
    const current = await aggregate(ctx.tenantPrisma, from, to, args.groupBy);
    let prev: Awaited<ReturnType<typeof aggregate>> | null = null;
    if (args.compareFrom && args.compareTo) {
      const c = checkRange(args.compareFrom, args.compareTo);
      prev = await aggregate(ctx.tenantPrisma, c.from, c.to, args.groupBy);
    }

    const keys = new Set([...current.groups.keys(), ...(prev ? prev.groups.keys() : [])]);
    const totalRevenue = [...current.groups.values()].reduce((n, b) => n + b.revenue, 0);
    const totalPrev = prev ? [...prev.groups.values()].reduce((n, b) => n + b.revenue, 0) : 0;
    const totalJobs = [...current.groups.values()].reduce((n, b) => n + b.jobs, 0);
    const order = (a: [string, number], b: [string, number]) => (args.groupBy === "MONTH" ? a[0].localeCompare(b[0]) : b[1] - a[1] || a[0].localeCompare(b[0]));
    const sorted = [...keys].map((k) => [k, current.groups.get(k)?.revenue ?? 0] as [string, number]).sort(order).map(([k]) => k);

    const rows: ResultRow[] = sorted.map((k): ResultRow => {
      const c = current.groups.get(k) ?? { revenue: 0, jobs: 0 };
      if (!prev) return { group: k, revenue: round2(c.revenue), jobs: c.jobs, share: pct(c.revenue, totalRevenue) };
      const p = prev.groups.get(k)?.revenue ?? 0;
      return { group: k, revenue: round2(c.revenue), previousRevenue: round2(p), change: round2(c.revenue - p), changePercent: pct(c.revenue - p, p), jobs: c.jobs };
    });
    const totals: ResultRow | null =
      rows.length === 0 ? null
      : prev ? { group: "Total", revenue: round2(totalRevenue), previousRevenue: round2(totalPrev), change: round2(totalRevenue - totalPrev), changePercent: pct(totalRevenue - totalPrev, totalPrev), jobs: totalJobs }
      : { group: "Total", revenue: round2(totalRevenue), jobs: totalJobs, share: 100 };
    return {
      dateRange: toDateRange(from, to),
      rows,
      totals,
      truncated: current.truncated || (prev?.truncated ?? false),
      columns: prev ? COMPARED : PLAIN,
    };
  },
};

