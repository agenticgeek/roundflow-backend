import { IncidentType } from "../../../generated/tenant-client";
import type { ResultRow, ToolDefinition, ToolName } from "../types";
import { columns, instantRange, MAX_QUERY_CHARS, optDate, optString, parseArgs, parseLimit, resolveRange, round2, SCAN_CAP, tenantClock, toDateRange } from "./shared";

// technician_incidents(from?, to?, technician?, limit?): per technician over a range, the strikes, damage (count and
// pounds) and upsells (count and pounds) logged as TechnicianIncident, plus the KPI alerts raised (metric, value and
// threshold only). The free-text incident note is deliberately never selected.

interface Args {
  from?: string;
  to?: string;
  technician?: string;
  limit: number;
}

const COLUMNS = columns(
  ["technician", "Technician", "text"],
  ["strikes", "Strikes", "integer"],
  ["damageCount", "Damage incidents", "integer"],
  ["damageAmount", "Damage cost", "currency"],
  ["upsellCount", "Upsells", "integer"],
  ["upsellAmount", "Upsell value", "currency"],
  ["kpiAlerts", "KPI alerts raised", "integer"],
  ["kpiAlertDetail", "KPI alerts (metric: value vs threshold)", "text"]
);

const MAX_ALERT_DETAIL = 5;

interface Agg {
  name: string;
  strikes: number;
  damageCount: number;
  damageAmount: number;
  upsellCount: number;
  upsellAmount: number;
  alerts: string[];
}

export const technicianIncidents: ToolDefinition<Args> = {
  name: "technician_incidents",
  label: "Technician incidents",
  readOnly: true,
  description:
    "Per technician over a date range (YYYY-MM-DD inclusive, max 366 days; default this month so far): strikes, damage incidents (count and cost in pounds), upsells (count and value in pounds) and the KPI alerts raised (metric, actual value against the threshold). Optional technician name filter (partial match). Sorted by strikes then damage cost, with a Total row. Use for 'who has had strikes', 'how much damage have we paid for', 'who upsells the most', 'which KPI alerts fired'. Does not include incident notes. Do not use for completion or revenue figures (compare_technicians) or customer complaints (list_complaints). Example: {\"from\":\"2026-10-01\",\"to\":\"2026-10-31\",\"technician\":\"Liam\"}. Glossary: damageAmount is money paid or owed for damage; upsellAmount is extra work sold on site; kpiAlerts counts alerts raised in the range.",
  inputSchema: {
    type: "object",
    properties: {
      from: { type: "string", description: "YYYY-MM-DD, default first day of this month" },
      to: { type: "string", description: "YYYY-MM-DD, default today" },
      technician: { type: "string", description: `Part of a technician name, max ${MAX_QUERY_CHARS} characters` },
      limit: { type: "integer", description: "Max rows, 1 to 200, default 50" },
    },
    additionalProperties: false,
  },
  parse(raw) {
    const obj = parseArgs(raw, ["from", "to", "technician", "limit"]);
    return { from: optDate(obj, "from"), to: optDate(obj, "to"), technician: optString(obj, "technician", MAX_QUERY_CHARS), limit: parseLimit(obj) };
  },
  async run(args, ctx) {
    const tp = ctx.tenantPrisma;
    const clock = await tenantClock(ctx);
    const { from, to } = resolveRange(args, clock);
    const createdAt = instantRange(clock.tz, from, to);
    const technician = args.technician ? { technician: { name: { contains: args.technician, mode: "insensitive" as const } } } : {};

    const [incidents, alerts] = await Promise.all([
      tp.technicianIncident.findMany({
        where: { createdAt, ...technician },
        select: { technicianId: true, type: true, amount: true, technician: { select: { name: true } } },
        take: SCAN_CAP + 1,
      }),
      tp.kpiAlert.findMany({
        where: { createdAt, ...technician },
        select: { technicianId: true, metric: true, value: true, threshold: true, technician: { select: { name: true } } },
        orderBy: { createdAt: "asc" },
        take: SCAN_CAP + 1,
      }),
    ]);

    const byTech = new Map<string, Agg>();
    const get = (id: string, name: string | null): Agg => {
      const a = byTech.get(id) ?? { name: name ?? "Unnamed technician", strikes: 0, damageCount: 0, damageAmount: 0, upsellCount: 0, upsellAmount: 0, alerts: [] };
      byTech.set(id, a);
      return a;
    };
    for (const i of incidents.slice(0, SCAN_CAP)) {
      const a = get(i.technicianId, i.technician.name);
      const amount = i.amount === null ? 0 : Number(i.amount);
      if (i.type === IncidentType.STRIKE) a.strikes += 1;
      else if (i.type === IncidentType.DAMAGE) {
        a.damageCount += 1;
        a.damageAmount += amount;
      } else {
        a.upsellCount += 1;
        a.upsellAmount += amount;
      }
    }
    for (const k of alerts.slice(0, SCAN_CAP)) get(k.technicianId, k.technician.name).alerts.push(`${k.metric}: ${round2(Number(k.value))} vs ${round2(Number(k.threshold))}`);

    const all = [...byTech.values()].sort((a, b) => b.strikes - a.strikes || b.damageAmount - a.damageAmount || a.name.localeCompare(b.name));
    const rows: ResultRow[] = all.slice(0, args.limit).map((a) => ({
      technician: a.name,
      strikes: a.strikes,
      damageCount: a.damageCount,
      damageAmount: round2(a.damageAmount),
      upsellCount: a.upsellCount,
      upsellAmount: round2(a.upsellAmount),
      kpiAlerts: a.alerts.length,
      kpiAlertDetail: a.alerts.length === 0 ? null : a.alerts.slice(0, MAX_ALERT_DETAIL).join("; "),
    }));
    const sum = (f: (a: Agg) => number) => all.reduce((n, a) => n + f(a), 0);
    return {
      dateRange: toDateRange(from, to),
      rows,
      totals: all.length === 0 ? null : {
        technician: "Total",
        strikes: sum((a) => a.strikes),
        damageCount: sum((a) => a.damageCount),
        damageAmount: round2(sum((a) => a.damageAmount)),
        upsellCount: sum((a) => a.upsellCount),
        upsellAmount: round2(sum((a) => a.upsellAmount)),
        kpiAlerts: sum((a) => a.alerts.length),
        kpiAlertDetail: null,
        technicians: all.length,
      },
      truncated: incidents.length > SCAN_CAP || alerts.length > SCAN_CAP || all.length > rows.length,
      columns: COLUMNS,
    };
  },
};
