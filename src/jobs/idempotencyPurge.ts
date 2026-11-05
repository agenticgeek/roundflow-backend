import { prisma } from "../lib/prisma";
import { getTenantPrismaForSchema } from "../lib/tenant-prisma-manager";
import { IDEMPOTENCY_TTL_DAYS, purgeIdempotencyRecords } from "../mobile/idempotency";

const DAY_MS = 24 * 60 * 60 * 1000;

// Nightly: drop mobile idempotency records older than IDEMPOTENCY_TTL_DAYS in
// every tenant schema. One tenant failing doesn't stop the others.
export async function runIdempotencyPurge(now: Date = new Date()): Promise<{ deleted: number }> {
  const olderThan = new Date(now.getTime() - IDEMPOTENCY_TTL_DAYS * DAY_MS);
  const tenants = await prisma.tenant.findMany({ select: { schemaName: true } });
  let deleted = 0;
  for (const t of tenants) {
    try {
      deleted += await purgeIdempotencyRecords(getTenantPrismaForSchema(t.schemaName), olderThan);
    } catch (err) {
      console.error(`[idempotencyPurge] tenant ${t.schemaName} failed:`, err);
    }
  }
  return { deleted };
}
