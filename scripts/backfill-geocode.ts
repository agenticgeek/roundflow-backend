// ACT-10: re-geocode properties with the Google Geocoding API (full address).
// Picks properties whose precision is null / POSTCODE_FALLBACK / APPROXIMATE or
// with no address hash, in batches, within --limit (default 200) and the
// GEOCODE_DAILY_LIMIT quota. Needs GOOGLE_MAPS_GEOCODING_API_KEY.
//
//   npx tsx scripts/backfill-geocode.ts --dry-run
//   npx tsx scripts/backfill-geocode.ts --limit=200
import "dotenv/config";
import { prisma } from "../src/lib/prisma";
import { runGeocodeBackfill } from "../src/jobs/geocodeBackfill";
import { parseGeocodeCliArgs } from "../src/jobs/geocodeBackfillCli";

const opts = parseGeocodeCliArgs(process.argv.slice(2));
console.log(`[backfill-geocode] starting${opts.dryRun ? " (dry run - nothing is saved or sent to Google)" : ""}, limit ${opts.limit}`);
runGeocodeBackfill(opts)
  .then((summary) => {
    console.log(JSON.stringify(summary));
    process.exitCode = summary.failedTenants > 0 ? 1 : 0;
  })
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
    process.exit(process.exitCode ?? 0);
  });
