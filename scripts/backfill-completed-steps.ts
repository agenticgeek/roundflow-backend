// GAP-002 backfill: for every tenant still in the setup wizard, add the steps
// the old row-count rules considered complete to BusinessSettings.completedSteps,
// so wizard progress made before the change isn't lost. Idempotent; tenants
// that already completed setup are skipped.
//
//   npx tsx scripts/backfill-completed-steps.ts --dry-run
//   npx tsx scripts/backfill-completed-steps.ts
import "dotenv/config";
import { prisma } from "../src/lib/prisma";
import { runBackfillCli, runCompletedStepsBackfill } from "../src/jobs/backfills";

runBackfillCli("backfill-completed-steps", process.argv.slice(2), runCompletedStepsBackfill)
  .then((code) => (process.exitCode = code))
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  // Tenant clients stay pooled in the LRU cache; exit explicitly so open
  // pools can't keep the process alive.
  .finally(async () => {
    await prisma.$disconnect();
    process.exit(process.exitCode ?? 0);
  });
