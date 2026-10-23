import { PrismaClient } from "../generated/tenant-client";
import { LRUCache } from "lru-cache";

export type TenantPrismaClient = PrismaClient;

// Each PrismaClient holds its own connection pool, capped at
// TENANT_POOL_CONNECTION_LIMIT connections. Cap the cache at 15 tenant
// clients so the worst case (15 * 3 = 45) stays under Supabase's Free/Micro
// tier max_connections (60), leaving headroom for Studio/PostgREST/Realtime.
// On eviction, $disconnect() releases the pool immediately.
const CLIENT_CACHE_MAX = 15;
const TENANT_POOL_CONNECTION_LIMIT = 3;

// Stash on globalThis so dev hot-reload (tsx watch) reuses the same cache
// instead of re-creating it on every reload, which would orphan the
// PrismaClients already in it (dispose() never fires, pools never close).
const globalForTenantPrisma = globalThis as unknown as {
  tenantClientCache?: LRUCache<string, PrismaClient>;
};

const clientCache =
  globalForTenantPrisma.tenantClientCache ??
  new LRUCache<string, PrismaClient>({
    max: CLIENT_CACHE_MAX,
    dispose(client) {
      client.$disconnect().catch(() => {
        // Swallow — process may be shutting down or the connection already closed.
      });
    },
  });

if (process.env.NODE_ENV !== "production") {
  globalForTenantPrisma.tenantClientCache = clientCache;
}

export function getTenantPrismaForSchema(schemaName: string): PrismaClient {
  const cached = clientCache.get(schemaName);
  if (cached) return cached;

  // Prefer the pooled (pgbouncer) URL so tenant pools multiplex through
  // Supabase's pooler instead of opening raw connections straight to
  // Postgres. DIRECT_URL is only a fallback for local setups with no pooler.
  const base = process.env.DATABASE_URL ?? process.env.DIRECT_URL!;
  const params = `connection_limit=${TENANT_POOL_CONNECTION_LIMIT}&pool_timeout=10&schema=${schemaName}`;
  const url = base.includes("?") ? `${base}&${params}` : `${base}?${params}`;

  const client = new PrismaClient({ datasources: { db: { url } } });
  clientCache.set(schemaName, client);
  return client;
}
