import { PrismaClient } from "../generated/tenant-client";
import { LRUCache } from "lru-cache";
import { assertSchemaName } from "./schema-name";

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
  tenantSchemaByClient?: WeakMap<object, string>;
};

// client -> schema name, so code that only holds a tenant client (services,
// notify helper) can find the owning tenant. Kept on globalThis for the same
// hot-reload reason as the cache above.
const schemaByClient = (globalForTenantPrisma.tenantSchemaByClient ??= new WeakMap<object, string>());

/** Schema name a client returned by getTenantPrismaForSchema belongs to, if any. */
export function getSchemaNameForClient(client: object): string | undefined {
  return schemaByClient.get(client);
}

// BUG-010: a client that is evicted while a job is still using it must not be disconnected under it (the next query
// would silently open a second pool). withTenantClient() counts users per schema; an evicted-but-in-use client is
// parked in `deferred` and disconnected when its last user finishes.
const inUse = new Map<string, number>();
const deferred = new Set<PrismaClient>();

const disconnectQuietly = (client: PrismaClient) => {
  client.$disconnect().catch(() => {
    // Swallow — process may be shutting down or the connection already closed.
  });
};

const clientCache =
  globalForTenantPrisma.tenantClientCache ??
  new LRUCache<string, PrismaClient>({
    max: CLIENT_CACHE_MAX,
    dispose(client, key) {
      if ((inUse.get(key) ?? 0) > 0) deferred.add(client);
      else disconnectQuietly(client);
    },
  });

if (process.env.NODE_ENV !== "production") {
  globalForTenantPrisma.tenantClientCache = clientCache;
}

export function getTenantPrismaForSchema(schemaName: string): PrismaClient {
  assertSchemaName(schemaName); // BE-19: the name goes into the connection URL
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
  schemaByClient.set(client, schemaName);
  return client;
}

/** Runs `fn` with the cached client of a tenant and keeps that client connected until `fn` settles. */
export async function withTenantClient<T>(schemaName: string, fn: (client: PrismaClient) => Promise<T>): Promise<T> {
  const client = getTenantPrismaForSchema(schemaName);
  inUse.set(schemaName, (inUse.get(schemaName) ?? 0) + 1);
  try {
    return await fn(client);
  } finally {
    const left = (inUse.get(schemaName) as number) - 1;
    if (left > 0) inUse.set(schemaName, left);
    else {
      inUse.delete(schemaName);
      if (deferred.delete(client)) disconnectQuietly(client);
    }
  }
}

/** Graceful shutdown: close every cached tenant pool. Never throws. */
export async function disconnectAllTenantClients(): Promise<void> {
  const clients = [...clientCache.values()];
  await Promise.allSettled(clients.map((c) => c.$disconnect()));
}
