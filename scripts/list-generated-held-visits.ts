// BUG-02 PM review: READ-ONLY. Lists every tenant's open, generated visits that
// are currently on payment hold (paymentHold=true). Nothing is modified.
//
//   npx tsx scripts/list-generated-held-visits.ts
import "dotenv/config";
import { prisma } from "../src/lib/prisma";
import { listGeneratedHeldVisits } from "../src/jobs/heldVisitsReport";

listGeneratedHeldVisits()
  .then((results) => {
    let total = 0;
    for (const r of results) {
      if (r.error) {
        console.log(`[held-visits] ${r.schemaName}: FAILED - ${r.error}`);
        continue;
      }
      console.log(`[held-visits] ${r.schemaName}: ${r.result!.length} held generated visit(s)`);
      for (const v of r.result!) {
        console.log(
          `  ${v.date} visit=${v.visitId} ${v.customerName} (${v.customerId}) ${v.address} customerOnHold=${v.customerOnHold}`
        );
      }
      total += r.result!.length;
    }
    console.log(`[held-visits] total: ${total}`);
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
