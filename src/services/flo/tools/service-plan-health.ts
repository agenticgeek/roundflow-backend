import { LifecycleStatus, VisitStatus } from "../../../generated/tenant-client";
import type { ResultRow, ToolDefinition } from "../types";
import { num } from "./e1-helpers";
import { checkRange, columns, dateToDay, instantRange, optDate, optEnum, parseArgs, parseLimit, round2, SCAN_CAP, tenantClock, toDateRange } from "./shared";

// service_plan_health(groupBy?, from?, to?, limit?): the recurring-revenue view of ServicePlan.

/**
 * Visits per year for each CleaningFrequency, used to annualise a plan's price (price x visits per year).
 * 52 weeks / 4 = 13, / 6 = 8.67, / 8 = 6.5, / 12 = 4.33 (rounded as the business quotes them).
 * A plan with no frequency set is counted but contributes 0 to the annualised value.
 */
export const VISITS_PER_YEAR: Record<string, number> = { FOUR_WEEKLY: 13, SIX_WEEKLY: 8.67, EIGHT_WEEKLY: 6.5, TWELVE_WEEKLY: 4.33 };
const FREQUENCY_LABEL: Record<string, string> = { FOUR_WEEKLY: "4-weekly", SIX_WEEKLY: "6-weekly", EIGHT_WEEKLY: "8-weekly", TWELVE_WEEKLY: "12-weekly" };
const GROUPS = ["FREQUENCY", "STATUS", "SERVICE"] as const;
type GroupBy = (typeof GROUPS)[number];

interface Args {
  groupBy: GroupBy;
  from?: string;
  to?: string;
  limit: number;
}

const COLUMNS = columns(
  ["group", "Group", "text"],
  ["plans", "Plans", "integer"],
  ["active", "Active", "integer"],
  ["paused", "Paused", "integer"],
  ["cancelled", "Cancelled", "integer"],
  ["annualisedValue", "Annualised value (active)", "currency"],
  ["averagePrice", "Average price per visit", "currency"],
  ["nextResumeDate", "Next resume date", "date"],
  ["overduePlans", "Overdue with no visit scheduled", "integer"]
);

interface Bucket {
  plans: number;
  active: number;
  paused: number;
  cancelled: number;
  annual: number;
  activePriceSum: number;
  nextResume: string | null;
  overdue: number;
}
const newBucket = (): Bucket => ({ plans: 0, active: 0, paused: 0, cancelled: 0, annual: 0, activePriceSum: 0, nextResume: null, overdue: 0 });

export const servicePlanHealth: ToolDefinition<Args> = {
  name: "service_plan_health",
  label: "Service plans",
  readOnly: true,
  description:
    "Recurring-revenue health of the service plans: annualised value of ACTIVE plans (price x visits per year: 4-weekly 13, 6-weekly 8.67, 8-weekly 6.5, 12-weekly 4.33), counts of active, paused and cancelled plans, when paused plans resume, plans overdue (next due date in the past and no scheduled visit) and cancellations in a period. " +
    "groupBy FREQUENCY (default), STATUS or SERVICE (type of service). from/to (YYYY-MM-DD, default this month so far, max 366 days) only define the cancellation window. " +
    "Use for 'what is my recurring revenue', 'how many plans are paused', 'which plans are overdue', 'how many customers cancelled this month'. Use revenue_summary for revenue actually earned. Example: {\"groupBy\":\"SERVICE\"}. " +
    "Fields: annualisedValue (pounds, active plans only), averagePrice (per visit, active plans), nextResumeDate (earliest pause end among paused plans), overduePlans. Totals add cancellationsInPeriod (plans now cancelled and last changed in the window; the plan has no cancel date, so this is approximate), pausedWithoutResumeDate and monthlyRecurringValue (annualised / 12).",
  inputSchema: {
    type: "object",
    properties: {
      groupBy: { type: "string", enum: [...GROUPS], description: "FREQUENCY (default), STATUS or SERVICE" },
      from: { type: "string", description: "YYYY-MM-DD, start of the cancellation window, default first of this month" },
      to: { type: "string", description: "YYYY-MM-DD, end of the cancellation window, default today" },
      limit: { type: "integer", description: "Max groups, 1 to 200, default 50" },
    },
    additionalProperties: false,
  },
  parse(raw) {
    const obj = parseArgs(raw, ["groupBy", "from", "to", "limit"]);
    return { groupBy: optEnum(obj, "groupBy", GROUPS) ?? "FREQUENCY", from: optDate(obj, "from"), to: optDate(obj, "to"), limit: parseLimit(obj) };
  },
  async run(args, ctx) {
    const clock = await tenantClock(ctx);
    const win = checkRange(args.from ?? `${clock.today.slice(0, 8)}01`, args.to ?? clock.today);
    const tp = ctx.tenantPrisma;
    const plans = await tp.servicePlan.findMany({
      select: { id: true, price: true, cleaningFrequency: true, status: true, pauseEndDate: true, nextDueDate: true, updatedAt: true, service: { select: { name: true } } },
      take: SCAN_CAP + 1,
    });
    const scanned = plans.slice(0, SCAN_CAP);

    // Active plans whose next due date has passed, minus those that still have a scheduled visit.
    const late = new Set(scanned.filter((p) => p.status === LifecycleStatus.ACTIVE && p.nextDueDate && dateToDay(p.nextDueDate) < clock.today).map((p) => p.id));
    if (late.size > 0) {
      const visits = await tp.visit.findMany({
        where: { servicePlanId: { in: [...late] }, status: { in: [VisitStatus.SCHEDULED, VisitStatus.IN_PROGRESS] } },
        select: { servicePlanId: true },
        take: SCAN_CAP,
      });
      for (const v of visits) if (v.servicePlanId) late.delete(v.servicePlanId);
    }

    const window = instantRange(clock.tz, win.from, win.to);
    const groups = new Map<string, Bucket>();
    const total = newBucket();
    let cancellations = 0;
    let pausedNoResume = 0;
    for (const p of scanned) {
      const key =
        args.groupBy === "STATUS" ? p.status
        : args.groupBy === "SERVICE" ? p.service?.name ?? "No service"
        : p.cleaningFrequency ? FREQUENCY_LABEL[p.cleaningFrequency] ?? "Other" : "Not set";
      let group = groups.get(key);
      if (!group) {
        group = newBucket();
        groups.set(key, group);
      }
      const price = num(p.price);
      const resume = p.pauseEndDate ? dateToDay(p.pauseEndDate) : null;
      for (const b of [group, total]) {
        b.plans += 1;
        if (p.status === LifecycleStatus.ACTIVE) {
          b.active += 1;
          b.annual += price * (VISITS_PER_YEAR[p.cleaningFrequency ?? ""] ?? 0);
          b.activePriceSum += price;
          if (late.has(p.id)) b.overdue += 1;
        } else if (p.status === LifecycleStatus.PAUSED) {
          b.paused += 1;
          if (resume && (b.nextResume === null || resume < b.nextResume)) b.nextResume = resume;
        } else b.cancelled += 1;
      }
      if (p.status === LifecycleStatus.PAUSED && !resume) pausedNoResume += 1;
      if (p.status === LifecycleStatus.CANCELLED && p.updatedAt >= window.gte && p.updatedAt < window.lt) cancellations += 1;
    }

    const toRow = (label: string, b: Bucket): ResultRow => ({
      group: label,
      plans: b.plans,
      active: b.active,
      paused: b.paused,
      cancelled: b.cancelled,
      annualisedValue: round2(b.annual),
      averagePrice: b.active === 0 ? null : round2(b.activePriceSum / b.active),
      nextResumeDate: b.nextResume,
      overduePlans: b.overdue,
    });
    const all = [...groups.entries()].sort((a, b) => b[1].annual - a[1].annual || b[1].plans - a[1].plans || a[0].localeCompare(b[0]));
    const rows = all.slice(0, args.limit).map(([k, b]) => toRow(k, b));
    return {
      dateRange: toDateRange(win.from, win.to),
      rows,
      totals: all.length === 0 ? null : { ...toRow("Total", total), cancellationsInPeriod: cancellations, pausedWithoutResumeDate: pausedNoResume, monthlyRecurringValue: round2(total.annual / 12) },
      truncated: plans.length > SCAN_CAP || all.length > rows.length,
      columns: COLUMNS,
    };
  },
};
