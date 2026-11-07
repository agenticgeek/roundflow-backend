import { withTenantClient, type TenantPrismaClient } from "./tenant-prisma-manager";

// BUG-010: background jobs that touch every tenant must never fan out over all tenants at once. Each tenant client
// owns a 3-connection pool; the shared cache holds 15 clients (BE-06). forEachTenant runs a small, fixed number of
// tenants at a time through the shared cache (withTenantClient pins the client while it is in use), so the number of
// open connections is bounded by the cache size no matter how many tenants exist.

function parseConcurrency(raw: string | undefined): number {
  const n = Math.floor(Number(raw));
  return Number.isFinite(n) && n >= 1 ? Math.min(n, 8) : 4;
}

/** Tenants processed at the same time by background jobs (env TENANT_JOB_CONCURRENCY, 1..8, default 4). */
export const TENANT_JOB_CONCURRENCY = parseConcurrency(process.env.TENANT_JOB_CONCURRENCY);

/** Runs `fn` for every tenant with bounded concurrency; one tenant failing never stops the others. */
export async function forEachTenant<T extends { schemaName: string }, R>(
  tenants: T[],
  fn: (tp: TenantPrismaClient, tenant: T) => Promise<R>,
  concurrency: number = TENANT_JOB_CONCURRENCY
): Promise<PromiseSettledResult<R>[]> {
  const limit = Number.isFinite(concurrency) && concurrency >= 1 ? Math.floor(concurrency) : 1;
  const results: PromiseSettledResult<R>[] = new Array(tenants.length);
  let next = 0;
  const worker = async () => {
    while (next < tenants.length) {
      const i = next++;
      try {
        results[i] = { status: "fulfilled", value: await withTenantClient(tenants[i].schemaName, (tp) => fn(tp, tenants[i])) };
      } catch (reason) {
        results[i] = { status: "rejected", reason };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, tenants.length) }, worker));
  return results;
}
