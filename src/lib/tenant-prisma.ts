import { PrismaClient } from "../generated/tenant-client";

// Temporary singleton tenant PrismaClient. TENANT_MIGRATION_URL is the
// schema-scoped direct URL used for migrations; at runtime we fall back to
// DIRECT_URL (raw Postgres, no PgBouncer) so the app starts even when the
// migration URL env var is absent from the deployment environment.
const globalForPrisma = globalThis as unknown as { tenantPrisma: PrismaClient };

const tenantUrl =
  process.env.TENANT_MIGRATION_URL ??
  process.env.DIRECT_URL ??
  process.env.DATABASE_URL;

if (!tenantUrl) {
  throw new Error(
    "No database URL for tenant client: set TENANT_MIGRATION_URL, DIRECT_URL, or DATABASE_URL"
  );
}

export const tenantPrisma =
  globalForPrisma.tenantPrisma ??
  new PrismaClient({ datasources: { db: { url: tenantUrl } } });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.tenantPrisma = tenantPrisma;
}
