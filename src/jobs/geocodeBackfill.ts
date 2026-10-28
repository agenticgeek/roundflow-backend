import { prisma } from "../lib/prisma";
import { getTenantPrismaForSchema, type TenantPrismaClient } from "../lib/tenant-prisma-manager";
import { geocodePostcodesBulk } from "../integrations/geocoding/client";

// After this many failed attempts a property is left alone — the
// `geocodeAttempts < MAX_ATTEMPTS` filter below means it simply stops being
// picked up by future ticks, the same dead-letter effect outboxWorker.ts
// gets from its explicit "dead" status, without needing one here.
const MAX_ATTEMPTS = 5;
const BATCH = 500;

type PendingProperty = { id: string; postcode: string; geocodeAttempts: number };

export async function runGeocodeBackfill(): Promise<void> {
  const tenants = await prisma.tenant.findMany({ select: { schemaName: true } });

  await Promise.allSettled(tenants.map((t) => processTenant(getTenantPrismaForSchema(t.schemaName))));
}

async function processTenant(tp: TenantPrismaClient): Promise<void> {
  const properties: PendingProperty[] = await tp.property.findMany({
    where: { latitude: null, geocodeAttempts: { lt: MAX_ATTEMPTS } },
    select: { id: true, postcode: true, geocodeAttempts: true },
    take: BATCH,
  });
  if (properties.length === 0) return;

  let coords: Map<string, { latitude: number; longitude: number } | null>;
  try {
    coords = await geocodePostcodesBulk(properties.map((p) => p.postcode));
  } catch (err) {
    // Whole-batch failure (network/5xx) — bump every property's attempt
    // count rather than leaving them stuck, so one bad tick doesn't block
    // the next one, and a permanently-unreachable provider still eventually
    // stops being retried.
    await Promise.all(properties.map((p) => markFailed(tp, p, String(err))));
    return;
  }

  await Promise.all(
    properties.map((property) => {
      const match = coords.get(property.postcode);
      return match
        ? tp.property.update({
            where: { id: property.id },
            data: { latitude: match.latitude, longitude: match.longitude, geocodedAt: new Date(), geocodeError: null },
          })
        : markFailed(tp, property, "postcode not found");
    })
  );
}

function markFailed(tp: TenantPrismaClient, property: PendingProperty, error: string) {
  const attempts = property.geocodeAttempts + 1;
  if (attempts >= MAX_ATTEMPTS) {
    console.error(`[geocodeBackfill] property ${property.id} dead after ${MAX_ATTEMPTS} attempts: ${error}`);
  }
  return tp.property.update({
    where: { id: property.id },
    data: { geocodeAttempts: attempts, geocodeError: error },
  });
}
