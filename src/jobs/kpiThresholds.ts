import { UserRole } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { getTenantPrismaForSchema } from "../lib/tenant-prisma-manager";
import { createKpiThresholdService } from "../services/kpi-threshold.service";
import { createNotificationService } from "../mobile/services/notification.service";

// Nightly KPI threshold check (B6 · GAP-025). Per tenant: evaluate this
// month's technician KPIs against /settings/kpi-thresholds, record new
// crossings as KpiAlert rows (de-duplicated per technician + metric + month,
// so re-running is safe) and notify the tenant's ADMINs about each new one.
// One tenant failing doesn't stop the others.
export async function runKpiThresholdCheck(now: Date = new Date()): Promise<{ alertsCreated: number }> {
  const tenants = await prisma.tenant.findMany({ select: { id: true, schemaName: true } });
  let alertsCreated = 0;

  for (const tenant of tenants) {
    try {
      const tp = getTenantPrismaForSchema(tenant.schemaName);
      const created = await createKpiThresholdService(tp).evaluate(now);
      alertsCreated += created.length;
      if (created.length === 0) continue;

      const admins = await prisma.profile.findMany({
        where: { tenantId: tenant.id, role: UserRole.ADMIN },
        select: { id: true },
      });
      const notifications = createNotificationService(tp);
      for (const alert of created) {
        const title = "KPI threshold crossed";
        const body = `${alert.technicianName ?? "A technician"}: ${alert.metric} is ${alert.value} (${alert.operator === "GT" ? "above" : "below"} ${alert.threshold}).`;
        for (const admin of admins) {
          await notifications.create(admin.id, "KPI_ALERT", title, body).catch((err) =>
            console.error(`[kpiThresholds] notify ${tenant.schemaName}:`, err)
          );
        }
      }
    } catch (err) {
      console.error(`[kpiThresholds] ${tenant.schemaName}:`, err);
    }
  }
  return { alertsCreated };
}
