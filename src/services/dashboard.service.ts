import type { TenantPrismaClient } from "../lib/tenant-prisma-manager";
import { createTodayService, type TodayRoundRow } from "./today.service";

// ── helpers ──────────────────────────────────────────────────────────────────

function todayRange(): { start: Date; end: Date } {
  const start = new Date();
  start.setUTCHours(0, 0, 0, 0);
  return { start, end: new Date(start.getTime() + 86_400_000) };
}

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
        complaints,
        unpaidVisits,
        monthlyVisits,
      ] = await Promise.all([
        // Jobs scheduled for today (any non-cancelled status)
        prisma.visit.count({
          where: { date: { gte: dayStart, lt: dayEnd } },
        }),

        // All open complaints (not resolved)
        prisma.complaint.findMany({
          where: { status: { not: "RESOLVED" } },
          select: { severity: true },
        }),

        // Visits this month that have no payment or payment is unpaid
        prisma.visit.findMany({
          where: {
            date: { gte: monthStart, lt: monthEnd },
            status: "COMPLETED",
            payment: { is: null },
          },
          select: { price: true, property: { select: { customerId: true } } },
        }),

        // Completed visits this month for revenue
        prisma.visit.findMany({
          where: {
            date: { gte: monthStart, lt: monthEnd },
            status: "COMPLETED",
          },
          select: { price: true },
        }),
      ]);

      const openComplaintsByPriority = { high: 0, medium: 0, low: 0 };
      for (const c of complaints as Array<{ severity: string }>) {
        if (c.severity === "HIGH") openComplaintsByPriority.high++;
        else if (c.severity === "MEDIUM") openComplaintsByPriority.medium++;
        else openComplaintsByPriority.low++;
      }

      const cleanUnpaidAmount = (unpaidVisits as Array<{ price: { toNumber(): number } }>).reduce(
        (sum, v) => sum + v.price.toNumber(),
        0
      );
      const cleanUnpaidCount = new Set(
        (unpaidVisits as Array<{ property: { customerId: string } }>).map(
          (v) => v.property.customerId
        )
      ).size;

      const monthlyRevenue = (monthlyVisits as Array<{ price: { toNumber(): number } }>).reduce(
        (sum, v) => sum + v.price.toNumber(),
        0
      );

      return {
        jobsScheduledToday,
        openComplaints: complaints.length,
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
      const { rounds } = await createTodayService(prisma).getTodaysWork("");
      return rounds;
    },

    getChartData: async (range: "6m" | "12m"): Promise<DashboardChartData> => {
      const monthCount = range === "12m" ? 12 : 6;
      const now = new Date();
      // Start at the beginning of (monthCount) months ago
      const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - monthCount + 1, 1));
      const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));

      const visits = await prisma.visit.findMany({
        where: { date: { gte: start, lt: end }, status: "COMPLETED" },
        select: { date: true, price: true, issues: { select: { id: true } } },
      });

      // Build ordered month keys: ["2025-10", "2025-11", ...]
      const monthKeys: string[] = [];
      for (let i = 0; i < monthCount; i++) {
        const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - monthCount + 1 + i, 1));
        monthKeys.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`);
      }

      type VisitRow = { date: Date; price: { toNumber(): number }; issues: { id: string }[] };
      const valueMap = new Map<string, number>();
      const issueMap = new Map<string, number>();
      for (const v of visits as VisitRow[]) {
        const key = `${v.date.getUTCFullYear()}-${String(v.date.getUTCMonth() + 1).padStart(2, "0")}`;
        valueMap.set(key, (valueMap.get(key) ?? 0) + v.price.toNumber());
        issueMap.set(key, (issueMap.get(key) ?? 0) + v.issues.length);
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

      const [technicians, visits, complaints] = await Promise.all([
        prisma.technician.findMany({
          where: { active: true },
          select: { id: true, name: true },
        }),
        prisma.visit.findMany({
          where: {
            date: { gte: start, lt: end },
            status: "COMPLETED",
            technicianId: { not: null },
          },
          select: {
            technicianId: true,
            price: true,
            issues: { select: { id: true } },
          },
        }),
        prisma.complaint.findMany({
          where: { status: { not: "RESOLVED" }, technicianId: { not: null } },
          select: { technicianId: true },
        }),
      ]);

      type VisitRow = { technicianId: string | null; price: { toNumber(): number }; issues: { id: string }[] };
      const statsMap = new Map<string, { jobsCompleted: number; valueCompleted: number; issueCount: number }>();
      for (const v of visits as VisitRow[]) {
        const tid = v.technicianId!;
        const entry = statsMap.get(tid) ?? { jobsCompleted: 0, valueCompleted: 0, issueCount: 0 };
        entry.jobsCompleted++;
        entry.valueCompleted += v.price.toNumber();
        entry.issueCount += v.issues.length;
        statsMap.set(tid, entry);
      }

      const complaintMap = new Map<string, number>();
      for (const c of complaints as { technicianId: string | null }[]) {
        const tid = c.technicianId!;
        complaintMap.set(tid, (complaintMap.get(tid) ?? 0) + 1);
      }

      return technicians.map((t) => ({
        technicianId: t.id,
        technicianName: t.name,
        jobsCompleted: statsMap.get(t.id)?.jobsCompleted ?? 0,
        valueCompleted: statsMap.get(t.id)?.valueCompleted ?? 0,
        issueCount: statsMap.get(t.id)?.issueCount ?? 0,
        openComplaints: complaintMap.get(t.id) ?? 0,
        timeOnJobMinutes: null,
        strikes: null,
        damages: null,
        upsells: null,
      }));
    },
  };
}
