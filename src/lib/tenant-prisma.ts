import { PrismaClient } from "../generated/tenant-client";

const globalForPrisma = globalThis as unknown as { tenantPrisma: PrismaClient };

const baseUrl =
  process.env.TENANT_MIGRATION_URL ??
  process.env.DIRECT_URL ??
  process.env.DATABASE_URL;

if (!baseUrl) {
  throw new Error(
    "No database URL for tenant client: set TENANT_MIGRATION_URL, DIRECT_URL, or DATABASE_URL"
  );
}

// TENANT_SCHEMA routes the tenant client to the correct Postgres schema
// (e.g. "t_eda5261d84145b62483b"). Without it, Prisma defaults to "public"
// where tenant tables do not live.
const schema = process.env.TENANT_SCHEMA;
const tenantUrl = schema
  ? `${baseUrl}${baseUrl.includes("?") ? "&" : "?"}schema=${schema}`
  : baseUrl;

export const tenantPrisma =
  globalForPrisma.tenantPrisma ??
  new PrismaClient({ datasources: { db: { url: tenantUrl } } });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.tenantPrisma = tenantPrisma;
}
