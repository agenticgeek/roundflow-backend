import { RoundStatus, VisitStatus } from "../../../generated/tenant-client";
import type { ResultRow, ToolDefinition, ToolName } from "../types";
import { addDays, columns, dateToDay, dayToDate, optInt, parseArgs, parseLimit, rangeLabel, SCAN_CAP, tenantClock, toDateRange } from "./shared";
import { clip } from "./e2-helpers";

// technician_workload(days?, limit?): the next N days (default 7, max 28, starting today, tenant-local). Stops are the
// SCHEDULED, IN_PROGRESS and COMPLETED visits dated in the window. "Days off" come from TechnicianAvailability
// (stored as whole dates), clipped to the window.

interface Args {
  days: number;
  limit: number;
}

const DEFAULT_DAYS = 7;
const MAX_DAYS = 28;

const COLUMNS = columns(
  ["kind", "Row type", "text"],
  ["technician", "Technician / round", "text"],
  ["stops", "Stops", "integer"],
  ["busiestDay", "Busiest day", "date"],
  ["busiestDayStops", "Stops on busiest day", "integer"],
  ["daysOff", "Days off", "integer"],
  ["offDetail", "Time off", "text"],
  ["byDay", "Stops per day", "text"]
);

export const technicianWorkload: ToolDefinition<Args> = {
  name: "technician_workload",
  label: "Technician workload",
  readOnly: true,
  description:
    "Who is working how much over the next N days (default 7, max 28, starting today): stops per technician in total and per day, the busiest day, who is off (holidays or other time off, with the reason), visits with no technician, and active rounds that have no technician assigned. One row per active technician, then an 'Unassigned' row and a 'Round without technician' row per round when relevant, plus a Total row. Use for 'who is off next week', 'who has spare capacity', 'are any visits unassigned'. Do not use for past performance (compare_technicians) or the staff list (list_technicians). Example: {\"days\":14}. Glossary: stops = scheduled, in progress and completed visits in the window; daysOff = days of the window the technician is on time off; byDay = 'YYYY-MM-DD: stops' for days that have work.",
  inputSchema: {
    type: "object",
    properties: {
      days: { type: "integer", description: "How many days ahead including today, 1 to 28, default 7" },
      limit: { type: "integer", description: "Max technician rows, 1 to 200, default 50" },
    },
    additionalProperties: false,
  },
  parse(raw) {
    const obj = parseArgs(raw, ["days", "limit"]);
    return { days: optInt(obj, "days", 1, MAX_DAYS) ?? DEFAULT_DAYS, limit: parseLimit(obj) };
  },
  async run(args, ctx) {
    const tp = ctx.tenantPrisma;
    const clock = await tenantClock(ctx);
    const from = clock.today;
    const to = addDays(from, args.days - 1);
    const windowDays = Array.from({ length: args.days }, (_, i) => addDays(from, i));

    const [technicians, visits, availability, bareRounds] = await Promise.all([
      tp.technician.findMany({ where: { active: true }, select: { id: true, name: true }, take: SCAN_CAP }),
      tp.visit.findMany({
        where: { date: { gte: dayToDate(from), lt: dayToDate(addDays(to, 1)) }, status: { in: [VisitStatus.SCHEDULED, VisitStatus.IN_PROGRESS, VisitStatus.COMPLETED] } },
        select: { date: true, technicianId: true, roundId: true },
        take: SCAN_CAP + 1,
      }),
      tp.technicianAvailability.findMany({
        where: { from: { lte: dayToDate(to) }, to: { gte: dayToDate(from) }, technician: { active: true } },
        select: { technicianId: true, from: true, to: true, reason: true },
        orderBy: { from: "asc" },
        take: SCAN_CAP,
      }),
      tp.round.findMany({ where: { status: RoundStatus.ACTIVE, roundTechnicians: { none: {} } }, select: { id: true, name: true }, orderBy: { name: "asc" }, take: SCAN_CAP }),
    ]);

    const perTech = new Map<string, Map<string, number>>();
    const perBareRound = new Map<string, number>();
    const bareIds = new Set(bareRounds.map((r) => r.id));
    let unassigned = 0;
    for (const v of visits.slice(0, SCAN_CAP)) {
      if (v.roundId && bareIds.has(v.roundId)) perBareRound.set(v.roundId, (perBareRound.get(v.roundId) ?? 0) + 1);
      if (!v.technicianId) {
        unassigned += 1;
        continue;
      }
      const days = perTech.get(v.technicianId) ?? new Map<string, number>();
      const day = dateToDay(v.date);
      days.set(day, (days.get(day) ?? 0) + 1);
      perTech.set(v.technicianId, days);
    }

    const offDays = new Map<string, Set<string>>();
    const offText = new Map<string, string[]>();
    for (const a of availability) {
      const start = dateToDay(a.from) < from ? from : dateToDay(a.from);
      const end = dateToDay(a.to) > to ? to : dateToDay(a.to);
      const set = offDays.get(a.technicianId) ?? new Set<string>();
      for (const d of windowDays) if (d >= start && d <= end) set.add(d);
      offDays.set(a.technicianId, set);
      const reason = a.reason?.trim();
      offText.set(a.technicianId, [...(offText.get(a.technicianId) ?? []), `${rangeLabel(start, end)}${reason ? ` (${clip(reason, 60)})` : ""}`]);
    }

    const techRows = technicians
      .map((t) => {
        const days = perTech.get(t.id) ?? new Map<string, number>();
        const stops = [...days.values()].reduce((n, c) => n + c, 0);
        const busiest = [...days.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
        const row: ResultRow = {
          kind: "Technician",
          technician: t.name ?? "Unnamed technician",
          stops,
          busiestDay: busiest ? busiest[0] : null,
          busiestDayStops: busiest ? busiest[1] : null,
          daysOff: offDays.get(t.id)?.size ?? 0,
          offDetail: offText.get(t.id)?.join("; ") ?? null,
          byDay: days.size === 0 ? null : [...days.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([d, c]) => `${d}: ${c}`).join("; "),
        };
        return row;
      })
      .sort((a, b) => (b.stops as number) - (a.stops as number) || (a.technician as string).localeCompare(b.technician as string));

    const blank = { busiestDay: null, busiestDayStops: null, daysOff: null, offDetail: null, byDay: null };
    const extra: ResultRow[] = [];
    if (unassigned > 0) extra.push({ kind: "Unassigned", technician: "Visits with no technician", stops: unassigned, ...blank });
    for (const r of bareRounds) extra.push({ kind: "Round without technician", technician: r.name, stops: perBareRound.get(r.id) ?? 0, ...blank });

    const shown = techRows.slice(0, args.limit);
    const rows = [...shown, ...extra];
    const totalStops = visits.slice(0, SCAN_CAP).length;
    return {
      dateRange: toDateRange(from, to),
      rows,
      totals: rows.length === 0 ? null : {
        kind: "Total",
        technician: null,
        stops: totalStops,
        busiestDay: null,
        busiestDayStops: null,
        daysOff: techRows.reduce((n, r) => n + (r.daysOff as number), 0),
        offDetail: null,
        byDay: null,
        technicians: technicians.length,
      },
      truncated: visits.length > SCAN_CAP || techRows.length > shown.length,
      columns: COLUMNS,
    };
  },
};
