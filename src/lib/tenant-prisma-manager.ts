import { PrismaClient } from "../generated/tenant-client";

// One PrismaClient per schema name — reused across requests to avoid
// exhausting the Postgres connection pool.
const clientCache = new Map<string, PrismaClient>();

export type TenantPrismaClient = PrismaClient;

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
