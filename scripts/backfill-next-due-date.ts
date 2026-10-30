// X-2 backfill: set nextDueDate on every tenant's ACTIVE service plans that
// have none, so the nightly generator continues their series. Idempotent;
// only null nextDueDate rows are touched.
//
//   npx tsx scripts/backfill-next-due-date.ts --dry-run
//   npx tsx scripts/backfill-next-due-date.ts
import "dotenv/config";
import { prisma } from "../src/lib/prisma";
import { runBackfillCli, runNextDueDateBackfill } from "../src/jobs/backfills";

runBackfillCli("backfill-next-due-date", process.argv.slice(2), runNextDueDateBackfill)
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
