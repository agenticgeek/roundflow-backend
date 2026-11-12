import { VisitStatus } from "../../../generated/tenant-client";
import type { ResultRow, ToolDefinition } from "../types";
import { addDays, checkRange, columns, dateToDay, optDate, optInt, parseArgs, parseLimit, SCAN_CAP, tenantClock, toDateRange, visitDateWhere } from "./shared";

// list_at_risk_customers(minConsecutiveSkips?, since?, limit?): properties whose most recent visits were skipped N
// times in a row (a customer who keeps being skipped may cancel). New query: the consecutive-skip window is not in any
// existing service. Looks at COMPLETED and SKIPPED visits in [since, today]; a COMPLETED visit ends the streak.

interface Args {
  minConsecutiveSkips: number;
  since?: string;
  limit: number;
}

const DEFAULT_LOOKBACK_DAYS = 180;

const COLUMNS = columns(
  ["customer", "Customer", "text"],
  ["address", "Address", "text"],
  ["skips", "Skips in a row", "integer"],
  ["lastSkipped", "Last skipped", "date"],
  ["reason", "Last reason", "text"]
);

export const listAtRiskCustomers: ToolDefinition<Args> = {
  name: "list_at_risk_customers",
  label: "At-risk customers",
  readOnly: true,
  description:
    "Customers whose latest visits were skipped several times in a row (default 2). since is YYYY-MM-DD (default 180 days ago, at most 366 days back). Use for 'which customers have been skipped twice in a row'.",
  inputSchema: {
    type: "object",
    properties: {
      minConsecutiveSkips: { type: "integer", description: "2 to 10, default 2" },
      since: { type: "string", description: "YYYY-MM-DD, default 180 days ago" },
      limit: { type: "integer", description: "Max rows, 1 to 200, default 50" },
    },
    additionalProperties: false,
  },
  parse(raw) {
    const obj = parseArgs(raw, ["minConsecutiveSkips", "since", "limit"]);
    return { minConsecutiveSkips: optInt(obj, "minConsecutiveSkips", 2, 10) ?? 2, since: optDate(obj, "since"), limit: parseLimit(obj) };
  },
  async run(args, ctx) {
    const clock = await tenantClock(ctx);
    const { from } = checkRange(args.since ?? addDays(clock.today, -DEFAULT_LOOKBACK_DAYS), clock.today);
    const visits = await ctx.tenantPrisma.visit.findMany({
      where: { date: visitDateWhere(from, clock.today), status: { in: [VisitStatus.COMPLETED, VisitStatus.SKIPPED] } },
      select: {
        propertyId: true,
        date: true,
        status: true,
        skipReason: true,
        property: { select: { addressLine: true, customer: { select: { name: true } } } },
      },
      orderBy: [{ propertyId: "asc" }, { date: "desc" }],
      take: SCAN_CAP + 1,
    });
    const scanned = visits.slice(0, SCAN_CAP);
    // Rows arrive grouped by property, newest first: count the leading run of SKIPPED per property.
    const streaks = new Map<string, { customer: string; address: string; skips: number; lastSkipped: string; reason: string | null; open: boolean }>();
    for (const v of scanned) {
      let s = streaks.get(v.propertyId);
      if (!s) {
        s = { customer: v.property.customer.name, address: v.property.addressLine, skips: 0, lastSkipped: dateToDay(v.date), reason: v.skipReason, open: true };
        streaks.set(v.propertyId, s);
      }
      if (!s.open) continue;
      if (v.status === VisitStatus.SKIPPED) s.skips += 1;
      else s.open = false;
    }
    const all: ResultRow[] = [...streaks.values()]
      .filter((s) => s.skips >= args.minConsecutiveSkips)
      .map((s) => ({ customer: s.customer, address: s.address, skips: s.skips, lastSkipped: s.lastSkipped, reason: s.reason }))
      .sort((a, b) => (b.skips as number) - (a.skips as number) || (b.lastSkipped as string).localeCompare(a.lastSkipped as string) || (a.customer as string).localeCompare(b.customer as string));
    const rows = all.slice(0, args.limit);
    return {
      dateRange: toDateRange(from, clock.today),
      rows,
      totals: all.length === 0 ? null : { customer: "Total", customers: all.length },
      truncated: visits.length > SCAN_CAP || all.length > rows.length,
      columns: COLUMNS,
    };
  },
};
