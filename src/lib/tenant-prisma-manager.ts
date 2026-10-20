import { PrismaClient } from "../generated/tenant-client";
import { LRUCache } from "lru-cache";

export type TenantPrismaClient = PrismaClient;

// Cap at 100 tenant clients. Each PrismaClient holds a connection pool; an
// unbounded Map would exhaust Postgres max_connections as the tenant count grows.
// On eviction, $disconnect() releases the pool immediately.
const CLIENT_CACHE_MAX = 100;

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

  const base = process.env.DIRECT_URL ?? process.env.DATABASE_URL!;
  const url = base.includes("?")
    ? `${base}&schema=${schemaName}`
    : `${base}?schema=${schemaName}`;

  const client = new PrismaClient({ datasources: { db: { url } } });
  clientCache.set(schemaName, client);
  return client;
}
