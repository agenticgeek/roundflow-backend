import type { TenantPrismaClient } from "../lib/tenant-prisma-manager";
import { createTodayService, type TodayRoundRow } from "./today.service";
import { todayRange } from "../lib/dates";
import type { KpiOperator } from "../generated/tenant-client";
import { computeTechnicianKpis, emptyKpis, periodRange } from "./technician-kpi.service";
import { monthPeriodKey } from "./kpi-threshold.service";

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
  // B6: computed; null only when the period has no timed visits.
  timeOnJobMinutes: number | null;
  revenuePerHour: number | null;
  strikes: number;
  damages: number;
  upsells: number;
  upsellValue: number;
}

// One crossed KPI threshold this month (src/jobs/kpiThresholds.ts).
export interface KpiThresholdAlert {
  type: "KPI_THRESHOLD";
  id: string;
  technicianId: string;
  technicianName: string | null;
  metric: string;
  value: number;
  threshold: number;
  operator: KpiOperator;
  periodKey: string;
  createdAt: Date;
}

export interface DashboardAlerts {
  skippedNeedingReview: number;
  failedPayments: number;
  complaintRevisitsDue: number;
  kpiAlerts: KpiThresholdAlert[];
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
          where: { date: { gte: dayStart, lt: dayEnd }, status: { not: "CANCELLED" } },
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

      const [skippedNeedingReview, failedPayments, complaintRevisitsDue, kpiAlertRows] =
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

          prisma.kpiAlert.findMany({
            where: { periodKey: monthPeriodKey(new Date()) },
            orderBy: { createdAt: "desc" },
            include: { technician: { select: { name: true } } },
          }),
        ]);

      const kpiAlerts: KpiThresholdAlert[] = kpiAlertRows.map((a) => ({
        type: "KPI_THRESHOLD",
        id: a.id,
        technicianId: a.technicianId,
        technicianName: a.technician.name,
        metric: a.metric,
        value: Number(a.value),
        threshold: Number(a.threshold),
        operator: a.operator,
        periodKey: a.periodKey,
        createdAt: a.createdAt,
      }));

      return { skippedNeedingReview, failedPayments, complaintRevisitsDue, kpiAlerts };
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
      const [technicians, kpis] = await Promise.all([
        prisma.technician.findMany({
          where: { active: true },
          select: { id: true, name: true },
        }),
        computeTechnicianKpis(prisma, periodRange(period, new Date())),
      ]);

      return technicians.map((t) => {
        const k = kpis.get(t.id) ?? emptyKpis();
        return {
          technicianId: t.id,
          technicianName: t.name,
          jobsCompleted: k.jobsCompleted,
          valueCompleted: k.valueCompleted,
          issueCount: k.issueCount,
          openComplaints: k.openComplaints,
          timeOnJobMinutes: k.timeOnJobMinutes,
          revenuePerHour: k.revenuePerHour,
          strikes: k.strikes,
          damages: k.damages,
          upsells: k.upsells,
          upsellValue: k.upsellValue,
        };
      });
    },
  };
}
