import { VisitStatus } from "../../../generated/tenant-client";
import type { ResultRow, ToolDefinition } from "../types";
import { columns, dateToDay, MAX_QUERY_CHARS, optDate, optId, optString, parseArgs, parseLimit, resolveRange, tenantClock, toDateRange, ToolInputError, visitDateWhere } from "./shared";

// list_skipped_visits(from?, to?, roundId?, roundName?, limit?): skipped visits with their reasons. A round given by id
// is resolved through THIS tenant's client first, so another tenant's id is "not found", never data.

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
    "Skipped visits in a date range (YYYY-MM-DD inclusive, max 366 days; default this month so far), newest first, with round, customer, address, technician and skip reason. Optionally restrict to one round by roundId or by part of its name (roundName, e.g. 'Round 7'). Use for 'show the Round 7 skipped properties'.",
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
    const [total, visits] = await Promise.all([
      tp.visit.count({ where }),
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
    return {
      dateRange: toDateRange(from, to),
      rows,
      totals: total === 0 ? null : { date: null, round: "Total", skipped: total },
      truncated: total > rows.length,
      columns: COLUMNS,
    };
  },
};
