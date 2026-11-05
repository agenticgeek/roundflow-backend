import { KpiOperator } from "../generated/tenant-client";
import type { TenantPrismaClient } from "../lib/tenant-prisma-manager";
import { AppError } from "../lib/app-error";
import { computeTechnicianKpis, emptyKpis, periodRange, type TechnicianKpiValues } from "./technician-kpi.service";

// KPI thresholds (B6 · GAP-025): tenant-wide rules like "revenuePerHour LT
// 30". GET/PUT /settings/kpi-thresholds manage them; the nightly check
// (src/jobs/kpiThresholds.ts) turns crossings into KpiAlert rows, shown on
// /dashboard/alerts.

export const KPI_METRICS = ["strikes", "damages", "upsells", "revenuePerHour", "timeOnJobMinutes"] as const;
export type KpiMetric = (typeof KPI_METRICS)[number];

export interface ThresholdInput {
  metric: KpiMetric;
  operator: KpiOperator;
  value: number;
}

export interface ThresholdRow extends ThresholdInput {
  id: string;
}

// "2026-10" — alerts de-duplicate per technician, metric and month.
export function monthPeriodKey(now: Date): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function isCrossed(operator: KpiOperator, value: number, threshold: number): boolean {
  return operator === KpiOperator.GT ? value > threshold : value < threshold;
}

export function createKpiThresholdService(tp: TenantPrismaClient) {
  const list = async (): Promise<ThresholdRow[]> => {
    const rows = await tp.kpiThreshold.findMany({ orderBy: [{ metric: "asc" }, { operator: "asc" }] });
    return rows.map((r) => ({
      id: r.id,
      metric: r.metric as KpiMetric,
      operator: r.operator,
      value: Number(r.value),
    }));
  };

  return {
    list,

    // Replace-all semantics: the body is the complete new set.
    async replaceAll(items: ThresholdInput[]): Promise<ThresholdRow[]> {
      const seen = new Set<string>();
      for (const item of items) {
        const key = `${item.metric}:${item.operator}`;
        if (seen.has(key)) throw new AppError(400, `Duplicate threshold for ${item.metric} ${item.operator}`);
        seen.add(key);
      }
      await tp.$transaction(async (tx) => {
        await tx.kpiThreshold.deleteMany({});
        if (items.length > 0) await tx.kpiThreshold.createMany({ data: items });
      });
      return list();
    },

    // Evaluate this month's KPIs for every active technician against every
    // threshold. A crossing creates one KpiAlert per technician + metric +
    // month; existing ones are left as they are. Metrics with no data (null)
    // never cross. Returns the alerts created on this run.
    async evaluate(now: Date) {
      const thresholds = await list();
      if (thresholds.length === 0) return [];

      const periodKey = monthPeriodKey(now);
      const [technicians, existing] = await Promise.all([
        tp.technician.findMany({ where: { active: true }, select: { id: true, name: true } }),
        tp.kpiAlert.findMany({ where: { periodKey }, select: { technicianId: true, metric: true } }),
      ]);
      if (technicians.length === 0) return [];

      const kpis = await computeTechnicianKpis(
        tp,
        periodRange("thisMonth", now),
        technicians.map((t) => t.id)
      );
      const alerted = new Set(existing.map((a) => `${a.technicianId}:${a.metric}`));

      const created: Array<{ technicianId: string; technicianName: string | null; metric: KpiMetric; value: number; threshold: number; operator: KpiOperator }> = [];
      for (const tech of technicians) {
        const values: TechnicianKpiValues = kpis.get(tech.id) ?? emptyKpis();
        for (const t of thresholds) {
          const value = values[t.metric];
          if (value === null) continue;
          const key = `${tech.id}:${t.metric}`;
          if (alerted.has(key) || !isCrossed(t.operator, value, t.value)) continue;
          await tp.kpiAlert.create({
            data: { technicianId: tech.id, metric: t.metric, value, threshold: t.value, operator: t.operator, periodKey },
          });
          alerted.add(key);
          created.push({ technicianId: tech.id, technicianName: tech.name, metric: t.metric, value, threshold: t.value, operator: t.operator });
        }
      }
      return created;
    },
  };
}
