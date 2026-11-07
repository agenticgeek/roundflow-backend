import { prisma } from "../lib/prisma";
import { getTenantPrismaForSchema, type TenantPrismaClient } from "../lib/tenant-prisma-manager";
import { geocodeQuotaRemaining, isGoogleGeocodingConfigured } from "../integrations/geocoding/client";
import { geocodeProperty } from "../services/property-geocoding";

// ACT-10 backfill. With the Google key set it (re)geocodes properties whose
// precision is null / POSTCODE_FALLBACK / APPROXIMATE, or that have no address
// hash (any address edit resets the hash, so "hash mismatch" always shows up as
// a null hash). Without the key it keeps the old behaviour: only properties
// with no coordinates. After MAX_ATTEMPTS failed or still-approximate results a
// property is left alone (`geocodeAttempts < MAX_ATTEMPTS`), which also stops
// an APPROXIMATE address being re-billed every tick.
//
// Bounded per run (default 200 properties) and by the in-memory daily quota
// (GEOCODE_DAILY_LIMIT). Not run by anyone against the shared dev database:
// `scripts/backfill-geocode.ts --dry-run` is the manual entry point.
export const MAX_ATTEMPTS = 5;
export const DEFAULT_RUN_LIMIT = 200;
const BATCH = 50;

export interface GeocodeBackfillOptions {
  dryRun?: boolean;
  /** Max properties handled in this run, across all tenants. */
  limit?: number;
}

export interface GeocodeBackfillSummary {
  tenants: number;
  failedTenants: number;
  scanned: number;
  geocoded: number;
  quotaExhausted: boolean;
  dryRun: boolean;
}

function pendingWhere(google: boolean) {
  return google
    ? {
        geocodeAttempts: { lt: MAX_ATTEMPTS },
        OR: [{ geocodePrecision: null }, { geocodePrecision: { in: ["POSTCODE_FALLBACK", "APPROXIMATE"] } }, { geocodeAddressHash: null }],
      }
    : { latitude: null, geocodeAttempts: { lt: MAX_ATTEMPTS } };
}

export async function runGeocodeBackfill(opts: GeocodeBackfillOptions = {}): Promise<GeocodeBackfillSummary> {
  const dryRun = opts.dryRun ?? false;
  const google = isGoogleGeocodingConfigured();
  const summary: GeocodeBackfillSummary = {
    tenants: 0, failedTenants: 0, scanned: 0, geocoded: 0, quotaExhausted: false, dryRun,
  };
  let remaining = opts.limit ?? DEFAULT_RUN_LIMIT;

  const tenants = await prisma.tenant.findMany({ select: { schemaName: true } });
  for (const t of tenants) {
    if (remaining <= 0 || summary.quotaExhausted) break;
    summary.tenants += 1;
    try {
      remaining -= await processTenant(getTenantPrismaForSchema(t.schemaName), { google, dryRun, remaining, summary });
    } catch (err) {
      summary.failedTenants += 1;
      console.error(`[geocodeBackfill] ${t.schemaName} failed:`, err);
    }
  }
  if (summary.scanned > 0 || summary.quotaExhausted) {
    console.log(`[geocodeBackfill] ${JSON.stringify(summary)}`);
  }
  return summary;
}

// Returns how many properties of the run's budget this tenant used.
async function processTenant(
  tp: TenantPrismaClient,
  ctx: { google: boolean; dryRun: boolean; remaining: number; summary: GeocodeBackfillSummary }
): Promise<number> {
  let used = 0;
  let cursor: string | undefined;
  while (used < ctx.remaining && !ctx.summary.quotaExhausted) {
    const rows = await tp.property.findMany({
      where: { ...pendingWhere(ctx.google), ...(cursor ? { id: { gt: cursor } } : {}) },
      select: { id: true, addressLine: true, postcode: true },
      orderBy: { id: "asc" },
      take: Math.min(BATCH, ctx.remaining - used),
    });
    if (rows.length === 0) break;
    cursor = rows[rows.length - 1].id;

    for (const row of rows) {
      if (ctx.google && geocodeQuotaRemaining() <= 0) {
        ctx.summary.quotaExhausted = true;
        break;
      }
      used += 1;
      ctx.summary.scanned += 1;
      if (ctx.dryRun) continue;
      try {
        await geocodeProperty(tp, row.id, { addressLine: row.addressLine, postcode: row.postcode });
        ctx.summary.geocoded += 1;
      } catch (err) {
        console.error(`[geocodeBackfill] property ${row.id} update failed:`, err);
      }
    }
  }
  return used;
}
