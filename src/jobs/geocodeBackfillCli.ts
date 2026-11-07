import { DEFAULT_RUN_LIMIT, type GeocodeBackfillOptions } from "./geocodeBackfill";

// Parses `--dry-run` and `--limit=N` (N must be a positive integer, else the default).
export function parseGeocodeCliArgs(argv: string[]): Required<GeocodeBackfillOptions> {
  const raw = argv.find((a) => a.startsWith("--limit="))?.slice("--limit=".length);
  const n = Number(raw);
  return {
    dryRun: argv.includes("--dry-run"),
    limit: Number.isInteger(n) && n > 0 ? n : DEFAULT_RUN_LIMIT,
  };
}
