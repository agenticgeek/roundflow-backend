import { VisitStatus } from "../../../generated/tenant-client";
import type { ResultRow, ToolDefinition } from "../types";
import { addDays, columns, dateToDay, optDate, parseArgs, parseLimit, resolveRange, round2, tenantClock, toDateRange, visitDateWhere } from "./shared";

// list_rounds_due(from?, to?, limit?): rounds with visits still to do in a date range, and what they are worth.
// Value = the price stamped on each scheduled visit (copied from the service plan when the visit is generated).

interface Args {
  from?: string;
  to?: string;
  limit: number;
}

const COLUMNS = columns(
  ["round", "Round", "text"],
  ["stops", "Stops", "integer"],
  ["value", "Value", "currency"],
  ["firstDate", "First visit", "date"],
  ["lastDate", "Last visit", "date"]
);

export const listRoundsDue: ToolDefinition<Args> = {
  name: "list_rounds_due",
  label: "Rounds due",
  readOnly: true,
  description:
    "Rounds with scheduled visits in a date range (YYYY-MM-DD, inclusive, max 366 days) with stop count and total value in pounds. Defaults: today to 6 days ahead. Use for 'which rounds are due next week and what are they worth'.",
  inputSchema: {
    type: "object",
    properties: {
      from: { type: "string", description: "YYYY-MM-DD, default today" },
      to: { type: "string", description: "YYYY-MM-DD, default 6 days after from" },
      limit: { type: "integer", description: "Max rows, 1 to 200, default 50" },
    },
    additionalProperties: false,
  },
  parse(raw) {
    const obj = parseArgs(raw, ["from", "to", "limit"]);
    return { from: optDate(obj, "from"), to: optDate(obj, "to"), limit: parseLimit(obj) };
  },
  async run(args, ctx) {
    const clock = await tenantClock(ctx);
    const from = args.from ?? clock.today;
    const { to } = resolveRange({ from, to: args.to ?? addDays(from, 6) }, clock);
    const groups = await ctx.tenantPrisma.visit.groupBy({
      by: ["roundId"],
      where: { date: visitDateWhere(from, to), status: { in: [VisitStatus.SCHEDULED, VisitStatus.IN_PROGRESS] }, roundId: { not: null } },
      _count: true,
      _sum: { price: true },
      _min: { date: true },
      _max: { date: true },
    });
    const ids = groups.map((g) => g.roundId).filter((id): id is string => id !== null);
    const names = ids.length === 0 ? [] : await ctx.tenantPrisma.round.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } });
    const nameOf = new Map(names.map((r) => [r.id, r.name]));
    const all: ResultRow[] = groups
      .map((g) => ({
        round: nameOf.get(g.roundId as string) ?? "Unknown round",
        stops: g._count as unknown as number,
        value: round2(Number(g._sum.price ?? 0)),
        firstDate: g._min.date ? dateToDay(g._min.date) : null,
        lastDate: g._max.date ? dateToDay(g._max.date) : null,
      }))
      .sort((a, b) => (b.value as number) - (a.value as number) || (a.round as string).localeCompare(b.round as string));
    const rows = all.slice(0, args.limit);
    return {
      dateRange: toDateRange(from, to),
      rows,
      totals: all.length === 0 ? null : {
        round: "Total",
        rounds: all.length,
        stops: all.reduce((n, r) => n + (r.stops as number), 0),
        value: round2(all.reduce((n, r) => n + (r.value as number), 0)),
        firstDate: null,
        lastDate: null,
      },
      truncated: all.length > rows.length,
      columns: COLUMNS,
    };
  },
};
