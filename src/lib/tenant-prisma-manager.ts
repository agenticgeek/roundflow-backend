import { PrismaClient } from "../generated/tenant-client";
import { LRUCache } from "lru-cache";

export type TenantPrismaClient = PrismaClient;

// Cap at 100 tenant clients. Each PrismaClient holds a connection pool; an
// unbounded Map would exhaust Postgres max_connections as the tenant count grows.
// On eviction, $disconnect() releases the pool immediately.
const CLIENT_CACHE_MAX = 100;

const clientCache = new LRUCache<string, PrismaClient>({
  max: CLIENT_CACHE_MAX,
  dispose(client) {
    client.$disconnect().catch(() => {
      // Swallow — process may be shutting down or the connection already closed.
    });
  },
});

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
