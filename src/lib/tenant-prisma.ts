import { PrismaClient } from "../generated/tenant-client";

// Temporary singleton tenant PrismaClient used by all service files until the
// service layer is refactored to accept per-request tenant clients (step 9 of
// the schema-per-tenant migration). At that point this singleton is removed
// and every service method receives a getTenantClient(schemaName) instance.
const globalForPrisma = globalThis as unknown as { tenantPrisma: PrismaClient };

export const tenantPrisma =
  globalForPrisma.tenantPrisma ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.tenantPrisma = tenantPrisma;
}
