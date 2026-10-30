// X-1 backfill: stamp technicianId on every tenant's future SCHEDULED visits
// (restampFutureVisits per ACTIVE round). Idempotent; safe to re-run.
//
//   npx tsx scripts/backfill-visit-technicians.ts --dry-run
//   npx tsx scripts/backfill-visit-technicians.ts
import "dotenv/config";
import { prisma } from "../src/lib/prisma";
import { runBackfillCli, runVisitTechnicianBackfill } from "../src/jobs/backfills";

runBackfillCli("backfill-visit-technicians", process.argv.slice(2), runVisitTechnicianBackfill)
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
