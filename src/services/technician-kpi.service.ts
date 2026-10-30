import { ComplaintStatus, IncidentType, VisitStatus } from "../generated/tenant-client";
import type { TenantPrismaClient } from "../lib/tenant-prisma-manager";
import { AppError } from "../lib/app-error";

// Technician KPIs (B6 · GAP-025, GAP-030). One calculation shared by
// GET /dashboard/technician-kpis, GET /technicians/:id/performance and the
// nightly threshold check (src/jobs/kpiThresholds.ts), so they can't drift.

export const KPI_PERIODS = ["thisMonth", "lastMonth", "thisYear", "last30", "last90", "monthly", "yearly"] as const;
export type KpiPeriod = (typeof KPI_PERIODS)[number];

export interface DateRange {
  start: Date; // inclusive
  end: Date; // exclusive
}

const DAY_MS = 86_400_000;

// UTC calendar ranges. "monthly"/"yearly" are the dashboard's names for
// thisMonth/thisYear. last30/last90 end tomorrow (exclusive) so today counts.
export function periodRange(period: KpiPeriod, now: Date): DateRange {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const tomorrow = new Date(Date.UTC(y, m, now.getUTCDate() + 1));
  switch (period) {
    case "lastMonth":
      return { start: new Date(Date.UTC(y, m - 1, 1)), end: new Date(Date.UTC(y, m, 1)) };
    case "thisYear":
    case "yearly":
      return { start: new Date(Date.UTC(y, 0, 1)), end: new Date(Date.UTC(y + 1, 0, 1)) };
    case "last30":
      return { start: new Date(tomorrow.getTime() - 30 * DAY_MS), end: tomorrow };
    case "last90":
      return { start: new Date(tomorrow.getTime() - 90 * DAY_MS), end: tomorrow };
    default: // thisMonth, monthly
      return { start: new Date(Date.UTC(y, m, 1)), end: new Date(Date.UTC(y, m + 1, 1)) };
  }
}

export function parseKpiPeriod(raw: unknown, fallback: KpiPeriod): KpiPeriod {
  if (raw === undefined) return fallback;
  if (typeof raw === "string" && (KPI_PERIODS as readonly string[]).includes(raw)) return raw as KpiPeriod;
  throw new AppError(400, `period must be one of: ${KPI_PERIODS.join(", ")}`);
}

export interface TechnicianKpiValues {
  jobsCompleted: number;
  valueCompleted: number;
  issueCount: number;
  // Σ(completedAt − startedAt) over completed visits with both timestamps;
  // null when no visit in the period has timing data.
  timeOnJobMinutes: number | null;
  // Value of those timed visits ÷ their hours; null when there's no timed data.
  revenuePerHour: number | null;
  // STRIKE incidents + upheld complaints attributed to the technician.
  strikes: number;
  damages: number;
  upsells: number;
  upsellValue: number;
  openComplaints: number; // not resolved, any date
  complaints: number; // logged in the period
}

export function emptyKpis(): TechnicianKpiValues {
  return {
    jobsCompleted: 0,
    valueCompleted: 0,
    issueCount: 0,
    timeOnJobMinutes: null,
    revenuePerHour: null,
    strikes: 0,
    damages: 0,
    upsells: 0,
    upsellValue: 0,
    openComplaints: 0,
    complaints: 0,
  };
}

const round2 = (n: number) => Math.round(n * 100) / 100;

// KPIs per technician for [start, end). `technicianIds` limits the scope;
// omitted = every technician with data. Technicians without data are absent
// from the map — callers fill with emptyKpis().
export async function computeTechnicianKpis(
  tp: TenantPrismaClient,
  range: DateRange,
  technicianIds?: string[]
): Promise<Map<string, TechnicianKpiValues>> {
  const { start, end } = range;
  const techFilter = technicianIds ? { in: technicianIds } : { not: null };

  const [visits, incidents, complaints] = await Promise.all([
    tp.visit.findMany({
      where: { status: VisitStatus.COMPLETED, date: { gte: start, lt: end }, technicianId: techFilter },
      select: { technicianId: true, price: true, startedAt: true, completedAt: true, _count: { select: { issues: true } } },
    }),
    tp.technicianIncident.groupBy({
      by: ["technicianId", "type"],
      where: { createdAt: { gte: start, lt: end }, ...(technicianIds ? { technicianId: { in: technicianIds } } : {}) },
      _count: true,
      _sum: { amount: true },
    }),
    tp.complaint.findMany({
      where: {
        technicianId: techFilter,
        OR: [
          { status: { not: ComplaintStatus.RESOLVED } },
          { createdAt: { gte: start, lt: end } },
          { upheld: true, resolvedAt: { gte: start, lt: end } },
        ],
      },
      select: { technicianId: true, status: true, upheld: true, resolvedAt: true, createdAt: true },
    }),
  ]);

  const map = new Map<string, TechnicianKpiValues>();
  const get = (id: string) => {
    let k = map.get(id);
    if (!k) {
      k = emptyKpis();
      map.set(id, k);
    }
    return k;
  };
  const timing = new Map<string, { ms: number; value: number }>();

  for (const v of visits) {
    const k = get(v.technicianId!);
    const price = Number(v.price);
    k.jobsCompleted += 1;
    k.valueCompleted += price;
    k.issueCount += v._count.issues;
    if (v.startedAt && v.completedAt && v.completedAt > v.startedAt) {
      const t = timing.get(v.technicianId!) ?? { ms: 0, value: 0 };
      t.ms += v.completedAt.getTime() - v.startedAt.getTime();
      t.value += price;
      timing.set(v.technicianId!, t);
    }
  }
  for (const [id, t] of timing) {
    const k = get(id);
    k.timeOnJobMinutes = Math.round(t.ms / 60_000);
    k.revenuePerHour = round2(t.value / (t.ms / 3_600_000));
  }

  for (const g of incidents) {
    const k = get(g.technicianId);
    if (g.type === IncidentType.STRIKE) k.strikes += g._count;
    else if (g.type === IncidentType.DAMAGE) k.damages += g._count;
    else {
      k.upsells += g._count;
      k.upsellValue = round2(k.upsellValue + Number(g._sum.amount ?? 0));
    }
  }

  for (const c of complaints) {
    const k = get(c.technicianId!);
    if (c.status !== ComplaintStatus.RESOLVED) k.openComplaints += 1;
    if (c.createdAt >= start && c.createdAt < end) k.complaints += 1;
    if (c.upheld && c.resolvedAt && c.resolvedAt >= start && c.resolvedAt < end) k.strikes += 1;
  }

  for (const k of map.values()) k.valueCompleted = round2(k.valueCompleted);
  return map;
}
