import { VisitStatus } from "../../../generated/tenant-client";
import type { TenantPrismaClient } from "../../../lib/tenant-prisma-manager";
import type { ResultRow, ToolDefinition } from "../types";
import {
  checkRange, columns, dateToDay, optDate, optEnum, parseArgs, pct, previousWindow, resolveRange, round2, tenantClock, toDateRange, ToolInputError, visitDateWhere, weekStartOf,
} from "./shared";

// revenue_summary(from?, to?, groupBy?, compare?, compareFrom?, compareTo?): revenue = price of COMPLETED visits in the
// range (the same definition reports.service.getRevenue/getSummary use), grouped by service area, round, technician,
// service, payment method, customer (top 20), day, week or month, optionally against a second range (change in pounds
// and percent). O4: every figure comes from database groupBy / aggregate calls (no visit rows are scanned in memory),
// so the total is exact whatever the grouping.

const GROUPS = ["SERVICE_AREA", "ROUND", "TECHNICIAN", "MONTH", "DAY", "WEEK", "SERVICE", "CUSTOMER", "PAYMENT_METHOD"] as const;
type GroupBy = (typeof GROUPS)[number];
/** Groups listed in time order rather than by revenue. */
const CHRONOLOGICAL: readonly GroupBy[] = ["MONTH", "DAY", "WEEK"];
const TOP_CUSTOMERS = 20;
/** Properties scanned (largest revenue first) when building the customer ranking. */
const MAX_PROPERTIES = 2000;

interface Args {
  from?: string;
  to?: string;
  groupBy: GroupBy;
  compare?: boolean;
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
  label: string;
  revenue: number;
  jobs: number;
}
type Groups = Map<string, Bucket>;

interface Aggregated {
  groups: Groups;
  total: { revenue: number; jobs: number };
  truncated: boolean;
}

const add = (groups: Groups, key: string, label: string, revenue: number, jobs: number): void => {
  const b = groups.get(key) ?? { label, revenue: 0, jobs: 0 };
  b.revenue += revenue;
  b.jobs += jobs;
  groups.set(key, b);
};

const money = (g: { _sum: { price: unknown } }): number => Number((g._sum.price as number | null) ?? 0);
const count = (g: { _count: unknown }): number => g._count as number;

async function aggregate(tp: TenantPrismaClient, from: string, to: string, groupBy: GroupBy): Promise<Aggregated> {
  const where = { date: visitDateWhere(from, to), status: VisitStatus.COMPLETED };
  const totalAgg = await tp.visit.aggregate({ where, _sum: { price: true }, _count: true });
  const total = { revenue: Number(totalAgg._sum.price ?? 0), jobs: totalAgg._count as unknown as number };
  const groups: Groups = new Map();
  let truncated = false;

  switch (groupBy) {
    case "ROUND": {
      const gs = await tp.visit.groupBy({ by: ["roundId"], where, _sum: { price: true }, _count: true });
      const ids = gs.map((g) => g.roundId).filter((id): id is string => id !== null);
      const names = new Map((ids.length === 0 ? [] : await tp.round.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })).map((r) => [r.id, r.name]));
      for (const g of gs) {
        const label = g.roundId === null ? "No round" : names.get(g.roundId) ?? "Unknown round";
        add(groups, label, label, money(g), count(g));
      }
      break;
    }
    case "TECHNICIAN": {
      const gs = await tp.visit.groupBy({ by: ["technicianId"], where, _sum: { price: true }, _count: true });
      const ids = gs.map((g) => g.technicianId).filter((id): id is string => id !== null);
      const names = new Map((ids.length === 0 ? [] : await tp.technician.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })).map((t) => [t.id, t.name]));
      for (const g of gs) {
        const label = g.technicianId === null ? "Unassigned" : names.get(g.technicianId) ?? "Unnamed technician";
        add(groups, label, label, money(g), count(g));
      }
      break;
    }
    case "SERVICE": {
      const gs = await tp.visit.groupBy({ by: ["serviceId"], where, _sum: { price: true }, _count: true });
      const ids = gs.map((g) => g.serviceId).filter((id): id is string => id !== null);
      const names = new Map((ids.length === 0 ? [] : await tp.service.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })).map((s) => [s.id, s.name]));
      for (const g of gs) {
        const label = g.serviceId === null ? "No service" : names.get(g.serviceId) ?? "Unknown service";
        add(groups, label, label, money(g), count(g));
      }
      break;
    }
    case "PAYMENT_METHOD": {
      const gs = await tp.visit.groupBy({ by: ["paymentMethod"], where, _sum: { price: true }, _count: true });
      for (const g of gs) {
        const label = g.paymentMethod ?? "No payment method";
        add(groups, label, label, money(g), count(g));
      }
      break;
    }
    case "DAY":
    case "WEEK":
    case "MONTH": {
      const gs = await tp.visit.groupBy({ by: ["date"], where, _sum: { price: true }, _count: true });
      for (const g of gs) {
        const day = dateToDay(g.date);
        if (groupBy === "DAY") add(groups, day, day, money(g), count(g));
        else if (groupBy === "MONTH") add(groups, day.slice(0, 7), day.slice(0, 7), money(g), count(g));
        else {
          const monday = weekStartOf(day);
          add(groups, monday, `Week of ${monday}`, money(g), count(g));
        }
      }
      break;
    }
    case "CUSTOMER": {
      // Revenue per property (largest first, bounded), then folded into customers.
      const gs = await tp.visit.groupBy({
        by: ["propertyId"],
        where,
        _sum: { price: true },
        _count: true,
        orderBy: { _sum: { price: "desc" } },
        take: MAX_PROPERTIES + 1,
      });
      const slice = gs.slice(0, MAX_PROPERTIES);
      truncated = gs.length > MAX_PROPERTIES;
      const props = await tp.property.findMany({
        where: { id: { in: slice.map((g) => g.propertyId) } },
        select: { id: true, customerId: true, customer: { select: { name: true } } },
      });
      const owner = new Map(props.map((p) => [p.id, { id: p.customerId, name: p.customer.name }]));
      for (const g of slice) {
        const o = owner.get(g.propertyId);
        add(groups, o?.id ?? `property:${g.propertyId}`, o?.name ?? "Unknown customer", money(g), count(g));
      }
      break;
    }
    default: {
      // SERVICE_AREA: a service area is reached through the property, which groupBy cannot group by, so one
      // aggregate per area (a handful) plus one for visits whose property has no area.
      const areas = await tp.serviceArea.findMany({ select: { id: true, name: true } });
      const parts = await Promise.all([
        ...areas.map(async (a) => ({ label: a.name, r: await tp.visit.aggregate({ where: { ...where, property: { serviceAreaId: a.id } }, _sum: { price: true }, _count: true }) })),
        tp.visit.aggregate({ where: { ...where, property: { serviceAreaId: null } }, _sum: { price: true }, _count: true }).then((r) => ({ label: "No service area", r })),
      ]);
      for (const { label, r } of parts) {
        const jobs = r._count as unknown as number;
        if (jobs > 0) add(groups, label, label, Number(r._sum.price), jobs);
      }
    }
  }
  return { groups, total, truncated };
}

export const revenueSummary: ToolDefinition<Args> = {
  name: "revenue_summary",
  label: "Revenue",
  readOnly: true,
  description:
    "Revenue (value of completed visits, in pounds) for a date range (YYYY-MM-DD inclusive, max 366 days; default this month so far), grouped by SERVICE_AREA (default), ROUND, TECHNICIAN, SERVICE (type of service), CUSTOMER (top 20), PAYMENT_METHOD, or over time by DAY, WEEK (Monday start) or MONTH. " +
    "Give compare true for the same-length period immediately before, or compareFrom and compareTo for a specific second range, to get the change in pounds and percent ('this month vs last'). " +
    "Do NOT use for money collected or failed payments (use list_payments), money owed (use list_debtors), invoices (use list_invoices) or revenue lost to skips and price cuts (use revenue_leakage). " +
    "Example: {\"from\":\"2026-10-01\",\"to\":\"2026-10-31\",\"groupBy\":\"WEEK\",\"compare\":true}. " +
    "Fields: group = the group name (date for DAY, 'Week of <Monday>' for WEEK, YYYY-MM for MONTH); revenue and jobs = completed visits; share = percent of total revenue; previousRevenue, change, changePercent appear only when comparing (changePercent is null when the previous figure is 0). " +
    "The total is exact; for CUSTOMER only the top 20 customers are listed so the rows add up to less than the total and truncated is true when more customers exist.",
  inputSchema: {
    type: "object",
    properties: {
      from: { type: "string", description: "YYYY-MM-DD, default first day of this month" },
      to: { type: "string", description: "YYYY-MM-DD, default today" },
      groupBy: { type: "string", enum: [...GROUPS] },
      compare: { type: "boolean", description: "Compare with the same-length period immediately before" },
      compareFrom: { type: "string", description: "YYYY-MM-DD, start of the comparison range" },
      compareTo: { type: "string", description: "YYYY-MM-DD, end of the comparison range" },
    },
    additionalProperties: false,
  },
  parse(raw) {
    const obj = parseArgs(raw, ["from", "to", "groupBy", "compare", "compareFrom", "compareTo"]);
    const compare = obj.compare;
    if (compare !== undefined && compare !== null && typeof compare !== "boolean") throw new ToolInputError('"compare" must be true or false');
    const args: Args = {
      from: optDate(obj, "from"),
      to: optDate(obj, "to"),
      groupBy: optEnum(obj, "groupBy", GROUPS) ?? "SERVICE_AREA",
      compareFrom: optDate(obj, "compareFrom"),
      compareTo: optDate(obj, "compareTo"),
    };
    if (compare === true) args.compare = true;
    if ((args.compareFrom === undefined) !== (args.compareTo === undefined)) throw new ToolInputError("compareFrom and compareTo must be given together");
    return args;
  },
  async run(args, ctx) {
    const clock = await tenantClock(ctx);
    const { from, to } = resolveRange(args, clock);
    const current = await aggregate(ctx.tenantPrisma, from, to, args.groupBy);
    let prev: Aggregated | null = null;
    if (args.compareFrom && args.compareTo) {
      const c = checkRange(args.compareFrom, args.compareTo);
      prev = await aggregate(ctx.tenantPrisma, c.from, c.to, args.groupBy);
    } else if (args.compare) {
      const c = checkRange(previousWindow(from, to).from, previousWindow(from, to).to);
      prev = await aggregate(ctx.tenantPrisma, c.from, c.to, args.groupBy);
    }

    const chronological = CHRONOLOGICAL.includes(args.groupBy);
    const labelOf = (k: string): string => (current.groups.get(k) ?? prev?.groups.get(k))!.label;
    let keys: string[];
    if (args.groupBy === "CUSTOMER") {
      // Only the current top customers are listed; the comparison fills in their previous revenue.
      keys = [...current.groups.entries()].sort((a, b) => b[1].revenue - a[1].revenue || a[1].label.localeCompare(b[1].label)).slice(0, TOP_CUSTOMERS).map(([k]) => k);
    } else {
      const all = new Set([...current.groups.keys(), ...(prev ? prev.groups.keys() : [])]);
      const revenueOf = (k: string) => current.groups.get(k)?.revenue ?? 0;
      keys = [...all].sort((a, b) => (chronological ? a.localeCompare(b) : revenueOf(b) - revenueOf(a) || labelOf(a).localeCompare(labelOf(b))));
    }
    const totalRevenue = current.total.revenue;
    const totalPrev = prev ? prev.total.revenue : 0;

    const rows: ResultRow[] = keys.map((k): ResultRow => {
      const c = current.groups.get(k) ?? { label: labelOf(k), revenue: 0, jobs: 0 };
      if (!prev) return { group: c.label, revenue: round2(c.revenue), jobs: c.jobs, share: pct(c.revenue, totalRevenue) };
      const p = prev.groups.get(k)?.revenue ?? 0;
      return { group: c.label, revenue: round2(c.revenue), previousRevenue: round2(p), change: round2(c.revenue - p), changePercent: pct(c.revenue - p, p), jobs: c.jobs };
    });
    const totals: ResultRow | null =
      rows.length === 0 ? null
      : prev ? { group: "Total", revenue: round2(totalRevenue), previousRevenue: round2(totalPrev), change: round2(totalRevenue - totalPrev), changePercent: pct(totalRevenue - totalPrev, totalPrev), jobs: current.total.jobs }
      : { group: "Total", revenue: round2(totalRevenue), jobs: current.total.jobs, share: 100 };
    const moreCustomers = args.groupBy === "CUSTOMER" && current.groups.size > TOP_CUSTOMERS;
    return {
      dateRange: toDateRange(from, to),
      rows,
      totals,
      truncated: current.truncated || (prev?.truncated ?? false) || moreCustomers,
      columns: prev ? COMPARED : PLAIN,
    };
  },
};
