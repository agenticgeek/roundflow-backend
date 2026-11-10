import { prisma } from "../lib/prisma";
import type { TenantPrismaClient } from "../lib/tenant-prisma-manager";
import { forEachTenant } from "../lib/tenant-jobs";
import { retentionDays } from "../services/flo/limits";

// Nightly (D8): purge Flo conversations that have not been touched for FLO_RETENTION_DAYS (default 90) in every
// tenant. Messages go with their conversation (ON DELETE CASCADE). One tenant failing never stops the others.

const DAY_MS = 86_400_000;

/** Deletes the tenant's conversations last updated before `olderThan`; returns how many were removed. */
export async function purgeFloConversations(tp: TenantPrismaClient, olderThan: Date): Promise<number> {
  const { count } = await tp.floConversation.deleteMany({ where: { updatedAt: { lt: olderThan } } });
  return count;
}

export async function runFloPurge(now: Date = new Date(), env: NodeJS.ProcessEnv = process.env): Promise<{ deleted: number; failedTenants: number }> {
  const olderThan = new Date(now.getTime() - retentionDays(env) * DAY_MS);
  const tenants = await prisma.tenant.findMany({ select: { schemaName: true } });
  const results = await forEachTenant(tenants, (tp) => purgeFloConversations(tp, olderThan));
  let deleted = 0;
  let failedTenants = 0;
  for (const r of results) {
    if (r.status === "fulfilled") deleted += r.value;
    else {
      failedTenants++;
      console.error("[floPurge] tenant failed:", r.reason instanceof Error ? r.reason.name : "unknown");
    }
  }
  return { deleted, failedTenants };
}
