import { ComplaintStatus, InvoiceStatus, PaymentStatus, Severity, VisitStatus } from "../../../generated/tenant-client";
import type { ToolDefinition } from "../types";
import { countOf, DEFAULT_SKIP_LOOKBACK_DAYS, monthStartOf, num, pct, previousMonthPeriod, skipStreaks } from "./e1-helpers";
import { addDays, columns, dayToDate, instantRange, parseArgs, round2, tenantClock, toDateRange, visitDateWhere } from "./shared";

// get_business_snapshot(): the headline numbers of the business in ONE call (also powers the morning briefing).
// One wide row (rows.0.<key>, also repeated in totals.<key>) so a card can reference any figure directly.
// Every figure is a database aggregate/count; the independent queries run in parallel.

const COLUMNS = columns(
  ["todayStops", "Stops today", "integer"],
  ["todayCompleted", "Completed today", "integer"],
  ["todaySkipped", "Skipped today", "integer"],
  ["todayRemaining", "Remaining today", "integer"],
  ["todayCompletionRate", "Completion rate today", "percent"],
  ["monthRevenue", "Revenue this month so far", "currency"],
  ["previousMonthRevenue", "Same period last month", "currency"],
  ["revenueChange", "Change vs last month", "currency"],
  ["revenueChangePercent", "Change vs last month %", "percent"],
  ["totalOwed", "Total owed", "currency"],
  ["customersOwing", "Customers owing", "integer"],
  ["owedOver30Days", "Owed over 30 days", "currency"],
  ["shareOver30Days", "Share of debt over 30 days", "percent"],
  ["openComplaintsHigh", "Open complaints (high)", "integer"],
  ["openComplaintsMedium", "Open complaints (medium)", "integer"],
  ["openComplaintsLow", "Open complaints (low)", "integer"],
  ["openComplaintsTotal", "Open complaints", "integer"],
  ["failedPaymentsCount", "Failed payments this month", "integer"],
  ["failedPaymentsAmount", "Failed payments value this month", "currency"],
  ["customersSkippedTwice", "Customers skipped 2+ times in a row", "integer"],
  ["visitsCarriedOver", "Visits carried over", "integer"]
);

const OPEN_VISIT = [VisitStatus.SCHEDULED, VisitStatus.IN_PROGRESS];

export const getBusinessSnapshot: ToolDefinition<Record<string, never>> = {
  name: "get_business_snapshot",
  label: "Business snapshot",
  readOnly: true,
  description:
    "One-call health check of the whole business: today's progress (stops, completed, remaining, completion rate), revenue this month so far vs the same period last month, total owed and share over 30 days, open complaints by severity, failed payments this month, customers skipped 2+ times in a row, visits carried over. " +
    "Use for 'how are we doing?', 'give me a summary', the morning briefing, or any headline question; use the specific tools (list_debtors, list_complaints, revenue_summary) when the user wants the detail behind a figure. Takes no arguments. " +
    "Returns ONE wide row (also in totals), reference figures as rows.0.<field>. Fields: todayStops/todayCompleted/todaySkipped/todayRemaining/todayCompletionRate (today, tenant-local; stops exclude cancelled), monthRevenue/previousMonthRevenue/revenueChange/revenueChangePercent (completed visits, month to date vs same days last month), totalOwed/customersOwing/owedOver30Days/shareOver30Days (sent unpaid invoices; over 30 days = due date more than 30 days ago), openComplaints* (not resolved), failedPaymentsCount/failedPaymentsAmount (this month), customersSkippedTwice (customers with a property whose last 2+ visits in 180 days were skipped), visitsCarriedOver (scheduled visits moved to a later day).",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  parse(raw) {
    parseArgs(raw, []);
    return {};
  },
  async run(_args, ctx) {
    const clock = await tenantClock(ctx);
    const tp = ctx.tenantPrisma;
    const today = clock.today;
    const monthStart = monthStartOf(today);
    const prev = previousMonthPeriod(today);
    const unpaid = { status: InvoiceStatus.SENT };

    const [todayStatus, revenue, prevRevenue, owed, owedBy, owedOld, complaints, failed, streaks, carried] = await Promise.all([
      tp.visit.groupBy({ by: ["status"], where: { date: visitDateWhere(today, today) }, _count: { _all: true } }),
      tp.visit.aggregate({ where: { date: visitDateWhere(monthStart, today), status: VisitStatus.COMPLETED }, _sum: { price: true } }),
      tp.visit.aggregate({ where: { date: visitDateWhere(prev.from, prev.to), status: VisitStatus.COMPLETED }, _sum: { price: true } }),
      tp.invoice.aggregate({ where: unpaid, _sum: { amount: true } }),
      tp.invoice.groupBy({ by: ["customerId"], where: unpaid, _sum: { amount: true } }),
      tp.invoice.aggregate({ where: { ...unpaid, dueDate: { lt: dayToDate(addDays(today, -30)) } }, _sum: { amount: true } }),
      tp.complaint.groupBy({ by: ["severity"], where: { status: { not: ComplaintStatus.RESOLVED } }, _count: { _all: true } }),
      tp.payment.aggregate({ where: { status: PaymentStatus.FAILED, createdAt: instantRange(clock.tz, monthStart, today) }, _sum: { amount: true }, _count: { _all: true } }),
      skipStreaks(tp, addDays(today, -DEFAULT_SKIP_LOOKBACK_DAYS), today),
      tp.visit.count({ where: { status: { in: OPEN_VISIT }, carryoverCount: { gt: 0 } } }),
    ]);

    const byStatus = new Map<string, number>(todayStatus.map((g) => [g.status as string, countOf(g._count)]));
    const stat = (s: string) => byStatus.get(s) ?? 0;
    const completed = stat(VisitStatus.COMPLETED);
    const skipped = stat(VisitStatus.SKIPPED);
    const remaining = stat(VisitStatus.SCHEDULED) + stat(VisitStatus.IN_PROGRESS);
    const stops = completed + skipped + remaining;

    const monthRevenue = num(revenue._sum.price);
    const previousMonthRevenue = num(prevRevenue._sum.price);
    const totalOwed = num(owed._sum.amount);
    const owedOver30 = num(owedOld._sum.amount);
    const sev = new Map<string, number>(complaints.map((g) => [g.severity as string, countOf(g._count)]));
    const atRiskCustomers = new Set(streaks.streaks.filter((s) => s.skips >= 2).map((s) => s.customerId));

    const row = {
      todayStops: stops,
      todayCompleted: completed,
      todaySkipped: skipped,
      todayRemaining: remaining,
      todayCompletionRate: pct(completed, stops),
      monthRevenue: round2(monthRevenue),
      previousMonthRevenue: round2(previousMonthRevenue),
      revenueChange: round2(monthRevenue - previousMonthRevenue),
      revenueChangePercent: pct(monthRevenue - previousMonthRevenue, previousMonthRevenue),
      totalOwed: round2(totalOwed),
      customersOwing: owedBy.length,
      owedOver30Days: round2(owedOver30),
      shareOver30Days: pct(owedOver30, totalOwed),
      openComplaintsHigh: sev.get(Severity.HIGH) ?? 0,
      openComplaintsMedium: sev.get(Severity.MEDIUM) ?? 0,
      openComplaintsLow: sev.get(Severity.LOW) ?? 0,
      openComplaintsTotal: [...sev.values()].reduce((n, c) => n + c, 0),
      failedPaymentsCount: countOf(failed._count),
      failedPaymentsAmount: round2(num(failed._sum.amount)),
      customersSkippedTwice: atRiskCustomers.size,
      visitsCarriedOver: carried,
    };
    return {
      dateRange: toDateRange(monthStart, today),
      rows: [row],
      totals: { ...row },
      truncated: streaks.truncated,
      columns: COLUMNS,
    };
  },
};
