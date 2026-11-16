import { RoundStatus } from "../../../generated/tenant-client";
import { ACTIVITY_WEATHER_HOLD, WEATHER_CONDITIONS } from "../../weather-hold.service";
import type { ResultRow, ToolDefinition, ToolName } from "../types";
import { addDays, checkRange, columns, instantRange, localDayOf, optDate, parseArgs, parseLimit, dayToDate, dateToDay, tenantClock, toDateRange } from "./shared";
import { clip } from "./e2-helpers";

// closures_and_weather(from?, to?, limit?): business closures overlapping a range (default 30 days back to 90 days
// ahead, so upcoming and active ones show) and the weather holds applied in it.
//
// Weather holds are not a table of their own: weather-hold.service writes one ActivityLog row per applied hold with
// type WEATHER_HOLD, entityId = the round id and a structured `details` JSON (date, condition, rescheduling,
// visitIds, ...). Only those structured fields are read; the generated log message text is never selected.

interface Args {
  from?: string;
  to?: string;
  limit: number;
}

const BACK_DAYS = 30;
const AHEAD_DAYS = 90;

const COLUMNS = columns(
  ["kind", "Row type", "text"],
  ["label", "Closure / round", "text"],
  ["status", "Status", "text"],
  ["startDate", "From", "date"],
  ["endDate", "To", "date"],
  ["action", "Action", "text"],
  ["rounds", "Rounds affected", "integer"],
  ["visits", "Visits moved or skipped", "integer"],
  ["condition", "Weather", "text"],
  ["applied", "Applied", "text"]
);

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

export const closuresAndWeather: ToolDefinition<Args> = {
  name: "closures_and_weather",
  label: "Closures and weather holds",
  readOnly: true,
  description:
    "Business closures and weather holds. Closures that overlap the range (YYYY-MM-DD inclusive; default 30 days back to 90 days ahead, max 366 days): label, start and end date, status (Upcoming, Active, Past), action (MOVE = visits move to the next open day, SKIP = visits are dropped), how many rounds it affects (all active rounds when it names none) and whether it has been applied yet. Weather holds applied in the range (when they were put on): round, the day held, weather condition, how the visits were rescheduled and how many visits were held. Use for 'are we closed over Christmas', 'which closures are coming up', 'have we had weather holds this winter'. Do not use to create or change a closure. Example: {\"from\":\"2026-12-01\",\"to\":\"2026-12-31\"}. Glossary: row type 'Closure' or 'Weather hold'; action for weather holds is next-available, next-cycle or manual (manual = visits skipped for the office to rebook); applied = Yes once the closure has actually moved or skipped visits. Totals: closures and weatherHolds count the rows in the range, visits sums visits held by weather holds listed.",
  inputSchema: {
    type: "object",
    properties: {
      from: { type: "string", description: "YYYY-MM-DD, default 30 days ago" },
      to: { type: "string", description: "YYYY-MM-DD, default 90 days ahead" },
      limit: { type: "integer", description: "Max closures and max weather holds listed (each), 1 to 200, default 50" },
    },
    additionalProperties: false,
  },
  parse(raw) {
    const obj = parseArgs(raw, ["from", "to", "limit"]);
    return { from: optDate(obj, "from"), to: optDate(obj, "to"), limit: parseLimit(obj) };
  },
  async run(args, ctx) {
    const tp = ctx.tenantPrisma;
    const clock = await tenantClock(ctx);
    const { from, to } = checkRange(args.from ?? addDays(clock.today, -BACK_DAYS), args.to ?? addDays(clock.today, AHEAD_DAYS));
    const closureWhere = { startDate: { lte: dayToDate(to) }, endDate: { gte: dayToDate(from) } };
    const holdWhere = { type: ACTIVITY_WEATHER_HOLD, createdAt: instantRange(clock.tz, from, to) };

    const [closures, closureCount, holds, holdCount, activeRounds] = await Promise.all([
      tp.businessClosure.findMany({
        where: closureWhere,
        select: { label: true, startDate: true, endDate: true, mode: true, roundIds: true, appliedAt: true },
        orderBy: [{ startDate: "asc" }, { createdAt: "asc" }],
        take: args.limit,
      }),
      tp.businessClosure.count({ where: closureWhere }),
      tp.activityLog.findMany({ where: holdWhere, select: { entityId: true, createdAt: true, details: true }, orderBy: { createdAt: "desc" }, take: args.limit }),
      tp.activityLog.count({ where: holdWhere }),
      tp.round.count({ where: { status: RoundStatus.ACTIVE } }),
    ]);

    const roundIds = [...new Set(holds.map((h) => h.entityId).filter((id): id is string => id !== null))];
    const roundRows = roundIds.length === 0 ? [] : await tp.round.findMany({ where: { id: { in: roundIds } }, select: { id: true, name: true } });
    const roundNames = new Map(roundRows.map((r) => [r.id, r.name]));

    const rows: ResultRow[] = [];
    for (const c of closures) {
      const start = dateToDay(c.startDate);
      const end = dateToDay(c.endDate);
      rows.push({
        kind: "Closure",
        label: clip(c.label, 80),
        status: clock.today < start ? "Upcoming" : clock.today > end ? "Past" : "Active",
        startDate: start,
        endDate: end,
        action: c.mode,
        rounds: c.roundIds.length === 0 ? activeRounds : c.roundIds.length,
        visits: null,
        condition: null,
        applied: c.appliedAt ? "Yes" : "No",
      });
    }
    let visitsHeld = 0;
    for (const h of holds) {
      const det = (h.details && typeof h.details === "object" && !Array.isArray(h.details) ? h.details : {}) as Record<string, unknown>;
      const day = str(det.date) ?? localDayOf(h.createdAt, clock.tz);
      const held = Array.isArray(det.visitIds) ? det.visitIds.length : 0;
      const cond = str(det.condition);
      visitsHeld += held;
      rows.push({
        kind: "Weather hold",
        label: (h.entityId && roundNames.get(h.entityId)) || "Unknown round",
        status: "Applied",
        startDate: day,
        endDate: day,
        action: str(det.rescheduling),
        rounds: 1,
        visits: held,
        condition: cond && cond in WEATHER_CONDITIONS ? WEATHER_CONDITIONS[cond as keyof typeof WEATHER_CONDITIONS].label : null,
        applied: "Yes",
      });
    }
    return {
      dateRange: toDateRange(from, to),
      rows,
      totals: closureCount + holdCount === 0 ? null : {
        kind: "Total",
        label: null,
        status: null,
        startDate: null,
        endDate: null,
        action: null,
        rounds: null,
        visits: visitsHeld,
        condition: null,
        applied: null,
        closures: closureCount,
        weatherHolds: holdCount,
      },
      truncated: closureCount > closures.length || holdCount > holds.length,
      columns: COLUMNS,
    };
  },
};
