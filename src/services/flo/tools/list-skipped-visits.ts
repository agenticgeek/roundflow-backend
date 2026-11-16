import { VisitStatus } from "../../../generated/tenant-client";
import type { ResultRow, ToolDefinition } from "../types";
import { breakdownText, columns, dateToDay, MAX_QUERY_CHARS, optDate, optId, optString, parseArgs, parseLimit, resolveRange, tenantClock, toDateRange, ToolInputError, topEntry, visitDateWhere } from "./shared";

// list_skipped_visits(from?, to?, roundId?, roundName?, limit?): skipped visits with their reasons. A round given by id
// is resolved through THIS tenant's client first, so another tenant's id is "not found", never data. The totals by
// reason and by round come from groupBy over every match, so the model never has to count rows itself.

interface Args {
  from?: string;
  to?: string;
  roundId?: string;
  roundName?: string;
  limit: number;
}

const COLUMNS = columns(
  ["date", "Date", "date"],
  ["round", "Round", "text"],
  ["customer", "Customer", "text"],
  ["address", "Address", "text"],
  ["technician", "Technician", "text"],
  ["reason", "Reason", "text"]
);

export const listSkippedVisits: ToolDefinition<Args> = {
  name: "list_skipped_visits",
  label: "Skipped visits",
  readOnly: true,
  description:
    "Skipped visits in a date range (YYYY-MM-DD inclusive, max 366 days; default this month so far), newest first, with round, customer, address, technician and skip reason. Optionally restrict to one round by roundId or by part of its name (roundName, e.g. 'Round 7'). Use for 'show the Round 7 skipped properties' and 'why are visits being skipped'. " +
    "Do NOT use for visits still to do or carried over (use backlog_and_carryover), for one day's progress (use get_day_overview) or for revenue lost to price changes (use revenue_leakage). " +
    "Example: {\"roundName\":\"Round 7\",\"from\":\"2026-10-01\",\"to\":\"2026-10-31\",\"limit\":25}. " +
    "Totals (exact over every skipped visit matched, not just the rows shown): skipped = count, byReason and byRound = 'name: count' lists largest first, topReason / topReasonCount, topRound / topRoundCount. Visits skipped with no reason recorded are counted as 'No reason given'.",
  inputSchema: {
    type: "object",
    properties: {
      from: { type: "string", description: "YYYY-MM-DD, default first day of this month" },
      to: { type: "string", description: "YYYY-MM-DD, default today" },
      roundId: { type: "string" },
      roundName: { type: "string", description: "Part of the round name, up to 80 characters" },
      limit: { type: "integer", description: "Max rows, 1 to 200, default 50" },
    },
    additionalProperties: false,
  },
  parse(raw) {
    const obj = parseArgs(raw, ["from", "to", "roundId", "roundName", "limit"]);
    return {
      from: optDate(obj, "from"),
      to: optDate(obj, "to"),
      roundId: optId(obj, "roundId"),
      roundName: optString(obj, "roundName", MAX_QUERY_CHARS),
      limit: parseLimit(obj),
    };
  },
  async run(args, ctx) {
    const clock = await tenantClock(ctx);
    const { from, to } = resolveRange(args, clock);
    const tp = ctx.tenantPrisma;
    if (args.roundId) {
      const round = await tp.round.findUnique({ where: { id: args.roundId }, select: { id: true } });
      if (!round) throw new ToolInputError("Round not found");
    }
    const where = {
      status: VisitStatus.SKIPPED,
      date: visitDateWhere(from, to),
      ...(args.roundId ? { roundId: args.roundId } : {}),
      ...(args.roundName ? { round: { name: { contains: args.roundName, mode: "insensitive" as const } } } : {}),
    };
    const [total, reasonGroups, roundGroups, visits] = await Promise.all([
      tp.visit.count({ where }),
      tp.visit.groupBy({ by: ["skipReason"], where, _count: true }),
      tp.visit.groupBy({ by: ["roundId"], where, _count: true }),
      tp.visit.findMany({
        where,
        select: {
          date: true,
          skipReason: true,
          round: { select: { name: true } },
          technician: { select: { name: true } },
          property: { select: { addressLine: true, customer: { select: { name: true } } } },
        },
        orderBy: [{ date: "desc" }, { id: "asc" }],
        take: args.limit,
      }),
    ]);
    const rows: ResultRow[] = visits.map((v) => ({
      date: dateToDay(v.date),
      round: v.round?.name ?? null,
      customer: v.property.customer.name,
      address: v.property.addressLine,
      technician: v.technician?.name ?? null,
      reason: v.skipReason,
    }));
    const roundIds = roundGroups.map((g) => g.roundId).filter((id): id is string => id !== null);
    const names = roundIds.length === 0 ? [] : await tp.round.findMany({ where: { id: { in: roundIds } }, select: { id: true, name: true } });
    const nameOf = new Map(names.map((r) => [r.id, r.name]));
    const byReason = new Map<string, number>();
    for (const g of reasonGroups) {
      const key = g.skipReason?.trim() || "No reason given";
      byReason.set(key, (byReason.get(key) ?? 0) + (g._count as unknown as number));
    }
    const byRound = new Map<string, number>();
    for (const g of roundGroups) {
      const key = g.roundId === null ? "No round" : nameOf.get(g.roundId) ?? "Unknown round";
      byRound.set(key, (byRound.get(key) ?? 0) + (g._count as unknown as number));
    }
    const topReason = topEntry(byReason);
    const topRound = topEntry(byRound);
    return {
      dateRange: toDateRange(from, to),
      rows,
      totals: total === 0 ? null : {
        date: null,
        round: "Total",
        skipped: total,
        byReason: breakdownText(byReason),
        topReason: topReason?.name ?? null,
        topReasonCount: topReason?.count ?? null,
        byRound: breakdownText(byRound),
        topRound: topRound?.name ?? null,
        topRoundCount: topRound?.count ?? null,
      },
      truncated: total > rows.length,
      columns: COLUMNS,
    };
  },
};
