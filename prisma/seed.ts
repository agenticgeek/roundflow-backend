// Seeds default Services/MessageTemplates into ONE tenant schema.
//
// New tenants are seeded automatically on signup (see src/routes/auth.ts),
// so this script exists only to backfill a tenant that was provisioned
// before that was wired up. Usage:
//
//   npx tsx prisma/seed.ts <schemaName>
//
// Idempotent — see seedTenantDefaults: each table is only written if empty.

import { getTenantPrismaForSchema } from "../src/lib/tenant-prisma-manager";
import { seedTenantDefaults } from "../src/lib/tenant-defaults";

async function main() {
  const schemaName = process.argv[2];
  if (!schemaName) {
    console.error("Usage: npx tsx prisma/seed.ts <schemaName>");
    process.exit(1);
  }

  const tenantPrisma = getTenantPrismaForSchema(schemaName);
  await seedTenantDefaults(tenantPrisma);
  console.log(`Seeded default Services/MessageTemplates for schema "${schemaName}" (skipped where already present).`);
  await tenantPrisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
