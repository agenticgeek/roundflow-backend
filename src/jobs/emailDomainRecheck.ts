import { prisma } from "../lib/prisma";
import { getTenantPrismaForSchema } from "../lib/tenant-prisma-manager";
import { isMailerConfigured } from "../lib/mailer/config";
import { createEmailDomainService } from "../services/email-domain.service";

// Nightly: re-poll SES for every tenant that has a sending domain. PENDING moves to VERIFIED once the DNS records
// propagate; VERIFIED/FAILED are re-checked so a removed record or a deleted identity drops the tenant back to the
// shared sender (tier 1) instead of failing sends. Sequential, so it never opens more tenant clients than needed.
export async function runEmailDomainRecheck(): Promise<{ checked: number; failed: number }> {
  if (!isMailerConfigured()) return { checked: 0, failed: 0 };
  const tenants = await prisma.tenant.findMany({ select: { schemaName: true } });
  let checked = 0;
  let failed = 0;
  for (const t of tenants) {
    try {
      const tp = getTenantPrismaForSchema(t.schemaName);
      const bs = await tp.businessSettings.findFirst({ select: { emailDomainStatus: true } });
      if (!bs || bs.emailDomainStatus === "NONE") continue;
      await createEmailDomainService(tp).status();
      checked++;
    } catch (err) {
      failed++;
      console.error(`[emailDomainRecheck] ${t.schemaName} failed:`, (err as Error).message);
    }
  }
  return { checked, failed };
}
