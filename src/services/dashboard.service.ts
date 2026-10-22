import type { TenantPrismaClient } from "../lib/tenant-prisma-manager";
import { createTodayService, type TodayRoundRow } from "./today.service";
import { todayRange } from "../lib/dates";

// ── helpers ──────────────────────────────────────────────────────────────────

function monthRange(): { start: Date; end: Date } {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { start, end };
}

// end of current week (Sunday 23:59:59 UTC)
function endOfWeek(): Date {
  const now = new Date();
  now.setUTCHours(0, 0, 0, 0);
  const daysUntilSunday = 7 - now.getUTCDay(); // 0=Sun → 7, Mon→6 … Sat→1
  const end = new Date(now.getTime() + daysUntilSunday * 86_400_000);
  end.setUTCHours(23, 59, 59, 999);
  return end;
}

// ── output types ─────────────────────────────────────────────────────────────

export type { TodayRoundRow as DashboardRoundRow };

export interface DashboardChartData {
  months: string[];
  valueCompleted: number[];
  issueCount: number[];
  revenuePerHour: null;
}

export interface TechnicianKpi {
  technicianId: string;
  technicianName: string | null;
  jobsCompleted: number;
  valueCompleted: number;
  openComplaints: number;
  issueCount: number;
  timeOnJobMinutes: null;
  strikes: null;
  damages: null;
  upsells: null;
}

export interface DashboardAlerts {
  skippedNeedingReview: number;
  failedPayments: number;
  complaintRevisitsDue: number;
}

export interface DashboardKpis {
  jobsScheduledToday: number;
  openComplaints: number;
  openComplaintsByPriority: { high: number; medium: number; low: number };
  cleanUnpaidAmount: number;
  cleanUnpaidCount: number;
  monthlyRevenue: number;
}

// ── service ──────────────────────────────────────────────────────────────────

export function createDashboardService(prisma: TenantPrismaClient) {
  return {
    getKpis: async (): Promise<DashboardKpis> => {
      const { start: dayStart, end: dayEnd } = todayRange();
      const { start: monthStart, end: monthEnd } = monthRange();

      const [
        jobsScheduledToday,
        severityGroups,
        unpaidAgg,
        unpaidVisits,
        monthlyAgg,
      ] = await Promise.all([
        // Jobs scheduled for today (any non-cancelled status)
        prisma.visit.count({
          where: { date: { gte: dayStart, lt: dayEnd } },
        }),

        // All open complaints (not resolved), bucketed by severity in SQL
        prisma.complaint.groupBy({
          by: ["severity"],
          where: { status: { not: "RESOLVED" } },
          _count: true,
        }),

        // Visits this month that have no payment or payment is unpaid — summed in SQL
        prisma.visit.aggregate({
          _sum: { price: true },
          where: {
            date: { gte: monthStart, lt: monthEnd },
            status: "COMPLETED",
            payment: { is: null },
          },
        }),

        // Same unpaid-visit set, but only the customerId needed for distinct-customer dedup
        prisma.visit.findMany({
          where: {
            date: { gte: monthStart, lt: monthEnd },
            status: "COMPLETED",
            payment: { is: null },
          },
          select: { property: { select: { customerId: true } } },
        }),

        // Completed visits this month for revenue — summed in SQL
        prisma.visit.aggregate({
          _sum: { price: true },
          where: {
            date: { gte: monthStart, lt: monthEnd },
            status: "COMPLETED",
          },
        }),
      ]);

      const openComplaintsByPriority = { high: 0, medium: 0, low: 0 };
      let openComplaints = 0;
      for (const row of severityGroups as Array<{ severity: string; _count: number }>) {
        openComplaints += row._count;
        if (row.severity === "HIGH") openComplaintsByPriority.high += row._count;
        else if (row.severity === "MEDIUM") openComplaintsByPriority.medium += row._count;
        else openComplaintsByPriority.low += row._count;
      }

      const cleanUnpaidAmount = unpaidAgg._sum.price?.toNumber() ?? 0;
      const cleanUnpaidCount = new Set(
        (unpaidVisits as Array<{ property: { customerId: string } }>).map(
          (v) => v.property.customerId
        )
      ).size;

      const monthlyRevenue = monthlyAgg._sum.price?.toNumber() ?? 0;

      return {
        jobsScheduledToday,
        openComplaints,
        openComplaintsByPriority,
        cleanUnpaidAmount,
        cleanUnpaidCount,
        monthlyRevenue,
      };
    },

    getAlerts: async (): Promise<DashboardAlerts> => {
      const { start: dayStart, end: dayEnd } = todayRange();
      const weekEnd = endOfWeek();

      const [skippedNeedingReview, failedPayments, complaintRevisitsDue] =
        await Promise.all([
          prisma.visit.count({
            where: { date: { gte: dayStart, lt: dayEnd }, status: "SKIPPED" },
          }),

          prisma.payment.count({
            where: { status: { in: ["FAILED", "OVERDUE"] } },
          }),

          prisma.complaint.count({
            where: {
              status: { not: "RESOLVED" },
              revisitDate: { not: null, lte: weekEnd },
            },
          }),
        ]);

      return { skippedNeedingReview, failedPayments, complaintRevisitsDue };
    },

    getTodaysRounds: async (): Promise<TodayRoundRow[]> => {
      const { rounds } = await createTodayService(prisma).getTodaysWork();
      return rounds;
    },

    getChartData: async (
      range: "6m" | "12m",
      technicianIds?: string[]
    ): Promise<DashboardChartData> => {
      const monthCount = range === "12m" ? 12 : 6;
      const now = new Date();
      // Start at the beginning of (monthCount) months ago
      const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - monthCount + 1, 1));
      const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
      const technicianFilter =
        technicianIds && technicianIds.length > 0
          ? { technicianId: { in: technicianIds } }
          : {};

      // Two independent queries instead of one LEFT JOIN Visit→Issue: summing
      // v.price through a one-to-many join duplicates a visit's price once
      // per linked issue (a £100 visit with 2 issues summed as £200). Neither
      // query here can fan out — groupBy(["date"]) never duplicates a Visit
      // row, and querying Issue directly (not joining *into* it from Visit)
      // naturally gives one row per issue.
      const [visitGroups, issueRows] = await Promise.all([
        prisma.visit.groupBy({
          by: ["date"],
          where: { date: { gte: start, lt: end }, status: "COMPLETED", ...technicianFilter },
          _sum: { price: true },
        }),
        prisma.issue.findMany({
          where: {
            visit: { date: { gte: start, lt: end }, status: "COMPLETED", ...technicianFilter },
          },
          select: { visit: { select: { date: true } } },
        }),
      ]);

      // Build ordered month keys: ["2025-10", "2025-11", ...]
      const monthKeys: string[] = [];
      for (let i = 0; i < monthCount; i++) {
        const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - monthCount + 1 + i, 1));
        monthKeys.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`);
      }
      const monthKeyOf = (d: Date) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;

      const valueMap = new Map<string, number>();
      for (const g of visitGroups) {
        const key = monthKeyOf(g.date);
        valueMap.set(key, (valueMap.get(key) ?? 0) + (g._sum.price?.toNumber() ?? 0));
      }
      const issueMap = new Map<string, number>();
      for (const issue of issueRows) {
        const key = monthKeyOf(issue.visit.date);
        issueMap.set(key, (issueMap.get(key) ?? 0) + 1);
      }

      const MONTH_LABELS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
      return {
        months: monthKeys.map((k) => MONTH_LABELS[parseInt(k.split("-")[1], 10) - 1]),
        valueCompleted: monthKeys.map((k) => valueMap.get(k) ?? 0),
        issueCount: monthKeys.map((k) => issueMap.get(k) ?? 0),
        revenuePerHour: null,
      };
    },

    getTechnicianKpis: async (period: "monthly" | "yearly"): Promise<TechnicianKpi[]> => {
      const now = new Date();
      const start =
        period === "yearly"
          ? new Date(Date.UTC(now.getUTCFullYear(), 0, 1))
          : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
      const end =
        period === "yearly"
          ? new Date(Date.UTC(now.getUTCFullYear() + 1, 0, 1))
          : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));

      const [technicians, visitGroups, issueRows, complaintGroups] = await Promise.all([
        prisma.technician.findMany({
          where: { active: true },
          select: { id: true, name: true },
        }),
        // jobsCompleted / valueCompleted per technician, summed in SQL
        prisma.visit.groupBy({
          by: ["technicianId"],
          where: {
            date: { gte: start, lt: end },
            status: "COMPLETED",
            technicianId: { not: null },
          },
          _count: true,
          _sum: { price: true },
        }),
        // issueCount per technician — kept as a scoped findMany (already bounded to
        // one period's completed visits per technician, a small row count), but
        // trimmed to drop `price` now that it's covered by the groupBy above.
        prisma.visit.findMany({
          where: {
            date: { gte: start, lt: end },
            status: "COMPLETED",
            technicianId: { not: null },
          },
          select: {
            technicianId: true,
            issues: { select: { id: true } },
          },
        }),
        prisma.complaint.groupBy({
          by: ["technicianId"],
          where: { status: { not: "RESOLVED" }, technicianId: { not: null } },
          _count: true,
        }),
      ]);

      const statsMap = new Map<string, { jobsCompleted: number; valueCompleted: number }>();
      for (const g of visitGroups as Array<{
        technicianId: string | null;
        _count: number;
        _sum: { price: { toNumber(): number } | null };
      }>) {
        const tid = g.technicianId!;
        statsMap.set(tid, {
          jobsCompleted: g._count,
          valueCompleted: g._sum.price?.toNumber() ?? 0,
        });
      }

      type IssueRow = { technicianId: string | null; issues: { id: string }[] };
      const issueMap = new Map<string, number>();
      for (const v of issueRows as IssueRow[]) {
        const tid = v.technicianId!;
        issueMap.set(tid, (issueMap.get(tid) ?? 0) + v.issues.length);
      }

      const complaintMap = new Map<string, number>();
      for (const c of complaintGroups as Array<{ technicianId: string | null; _count: number }>) {
        const tid = c.technicianId!;
        complaintMap.set(tid, (complaintMap.get(tid) ?? 0) + c._count);
      }

      return technicians.map((t) => ({
        technicianId: t.id,
        technicianName: t.name,
        jobsCompleted: statsMap.get(t.id)?.jobsCompleted ?? 0,
        valueCompleted: statsMap.get(t.id)?.valueCompleted ?? 0,
        issueCount: issueMap.get(t.id) ?? 0,
        openComplaints: complaintMap.get(t.id) ?? 0,
        timeOnJobMinutes: null,
        strikes: null,
        damages: null,
        upsells: null,
      }));
    },
  };
}
