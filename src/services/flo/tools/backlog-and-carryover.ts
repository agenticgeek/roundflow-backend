import { VisitStatus } from "../../../generated/tenant-client";
import type { ResultRow, ToolDefinition } from "../types";
import { countOf, num } from "./e1-helpers";
import { columns, dateToDay, dayToDate, daysBetween, optId, parseArgs, parseLimit, round2, tenantClock } from "./shared";

// backlog_and_carryover(roundId?, limit?): the work that should already have happened. Two groupBy aggregates over
// open visits (SCHEDULED / IN_PROGRESS): visits carried over (carryoverCount > 0) and visits whose date is already past.
// Both are exact (no scan cap); results are one row per round.

interface Args {
  roundId?: string;
  limit: number;
}

const OPEN = [VisitStatus.SCHEDULED, VisitStatus.IN_PROGRESS];

const COLUMNS = columns(
  ["round", "Round", "text"],
  ["carriedOver", "Carried over", "integer"],
  ["carriedOverValue", "Carried-over value", "currency"],
  ["maxCarryovers", "Most times carried", "integer"],
  ["oldestCarriedFrom", "Oldest originally due", "date"],
  ["pastDue", "Past their date", "integer"],
  ["pastDueValue", "Past-due value", "currency"],
  ["oldestPastDue", "Oldest past date", "date"],
  ["daysBehind", "Days behind (oldest)", "integer"]
);

interface Agg {
  carried: number;
  carriedValue: number;
  maxCarry: number;
  carriedFrom: string | null;
  past: number;
  pastValue: number;
  pastFrom: string | null;
}

/** Earliest of the non-null YYYY-MM-DD values (null when there are none). */
const earliest = (days: Array<string | null>): string | null => days.filter((d): d is string => d !== null).sort()[0] ?? null;

export const backlogAndCarryover: ToolDefinition<Args> = {
  name: "backlog_and_carryover",
  label: "Backlog and carry-over",
  readOnly: true,
  description:
    "Work that has slipped, per round: visits carried over to a later day (count, value, most times carried, the oldest original due date) and still-scheduled visits whose date is already in the past (count, value, oldest date, days behind). Open visits only (scheduled or in progress). Totals cover all rounds. " +
    "Use for 'what is overdue', 'what has been carried over', 'which round is behind', 'how many jobs did we not get to'. Use list_skipped_visits for visits that were skipped, and get_day_overview for today. Example: {\"roundId\":\"<id from another result>\"} or {}. " +
    "Fields: carriedOver/pastDue are counts, *Value in pounds, oldestCarriedFrom and oldestPastDue tenant-local dates, daysBehind = days from the oldest past date to today. Visits with no round are shown as 'No round'.",
  inputSchema: {
    type: "object",
    properties: {
      roundId: { type: "string", description: "Only this round (id from another tool result)" },
      limit: { type: "integer", description: "Max rows, 1 to 200, default 50" },
    },
    additionalProperties: false,
  },
  parse(raw) {
    const obj = parseArgs(raw, ["roundId", "limit"]);
    return { roundId: optId(obj, "roundId"), limit: parseLimit(obj) };
  },
  async run(args, ctx) {
    const clock = await tenantClock(ctx);
    const tp = ctx.tenantPrisma;
    const scope = args.roundId ? { roundId: args.roundId } : {};
    const [carried, past] = await Promise.all([
      tp.visit.groupBy({
        by: ["roundId"],
        where: { ...scope, status: { in: OPEN }, carryoverCount: { gt: 0 } },
        _count: { _all: true },
        _sum: { price: true },
        _min: { carriedOverFromDate: true },
        _max: { carryoverCount: true },
      }),
      tp.visit.groupBy({
        by: ["roundId"],
        where: { ...scope, status: { in: OPEN }, date: { lt: dayToDate(clock.today) } },
        _count: { _all: true },
        _sum: { price: true },
        _min: { date: true },
      }),
    ]);

    const byRound = new Map<string, Agg>();
    const get = (roundId: string | null): Agg => {
      const key = roundId ?? "";
      let a = byRound.get(key);
      if (!a) {
        a = { carried: 0, carriedValue: 0, maxCarry: 0, carriedFrom: null, past: 0, pastValue: 0, pastFrom: null };
        byRound.set(key, a);
      }
      return a;
    };
    for (const g of carried) {
      const a = get(g.roundId);
      a.carried = countOf(g._count);
      a.carriedValue = num(g._sum?.price);
      a.maxCarry = num(g._max?.carryoverCount);
      a.carriedFrom = g._min?.carriedOverFromDate ? dateToDay(g._min.carriedOverFromDate) : null;
    }
    for (const g of past) {
      const a = get(g.roundId);
      a.past = countOf(g._count);
      a.pastValue = num(g._sum?.price);
      a.pastFrom = g._min?.date ? dateToDay(g._min.date) : null;
    }

    const ids = [...byRound.keys()].filter((k) => k !== "");
    const rounds = ids.length === 0 ? [] : await tp.round.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } });
    const names = new Map(rounds.map((r) => [r.id, r.name]));

    const all = [...byRound.entries()]
      .map(([id, a]) => ({ name: id === "" ? "No round" : names.get(id) ?? "Unknown round", a }))
      .sort((x, y) => y.a.pastValue + y.a.carriedValue - (x.a.pastValue + x.a.carriedValue) || x.name.localeCompare(y.name));
    const rows: ResultRow[] = all.slice(0, args.limit).map(({ name, a }) => ({
      round: name,
      carriedOver: a.carried,
      carriedOverValue: round2(a.carriedValue),
      maxCarryovers: a.maxCarry === 0 ? null : a.maxCarry,
      oldestCarriedFrom: a.carriedFrom,
      pastDue: a.past,
      pastDueValue: round2(a.pastValue),
      oldestPastDue: a.pastFrom,
      daysBehind: a.pastFrom ? Math.max(0, daysBetween(a.pastFrom, clock.today)) : null,
    }));
    const oldestPast = earliest(all.map((x) => x.a.pastFrom));
    const oldestCarried = earliest(all.map((x) => x.a.carriedFrom));
    return {
      dateRange: null,
      rows,
      totals: all.length === 0 ? null : {
        round: "Total",
        rounds: all.length,
        carriedOver: all.reduce((n, x) => n + x.a.carried, 0),
        carriedOverValue: round2(all.reduce((n, x) => n + x.a.carriedValue, 0)),
        maxCarryovers: Math.max(...all.map((x) => x.a.maxCarry)) || null,
        oldestCarriedFrom: oldestCarried,
        pastDue: all.reduce((n, x) => n + x.a.past, 0),
        pastDueValue: round2(all.reduce((n, x) => n + x.a.pastValue, 0)),
        oldestPastDue: oldestPast,
        daysBehind: oldestPast ? Math.max(0, daysBetween(oldestPast, clock.today)) : null,
      },
      truncated: all.length > rows.length,
      columns: COLUMNS,
    };
  },
};
