// READ-ONLY. Lists, per tenant, message templates that still contain snake_case
// placeholder aliases such as {{customer_name}}. Nothing is modified.
//
//   npx tsx scripts/list-snake-case-templates.ts
import "dotenv/config";
import { prisma } from "../src/lib/prisma";
import { listSnakeCaseTemplates } from "../src/jobs/snakeCaseTemplatesReport";

listSnakeCaseTemplates()
  .then((results) => {
    let total = 0;
    for (const r of results) {
      if (r.error) {
        console.log(`[snake-case-templates] ${r.schemaName}: FAILED - ${r.error}`);
        continue;
      }
      console.log(`[snake-case-templates] ${r.schemaName}: ${r.result!.length} template(s)`);
      for (const t of r.result!) console.log(`  ${t.templateId} "${t.name}" (${t.channel ?? "no channel"}): ${t.tokens.join(", ")}`);
      total += r.result!.length;
    }
    console.log(`[snake-case-templates] total: ${total}`);
    process.exitCode = results.some((r) => r.error) ? 1 : 0;
  })
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
    process.exit(process.exitCode ?? 0);
  });
