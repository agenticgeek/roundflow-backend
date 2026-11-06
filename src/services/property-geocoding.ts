import type { TenantPrismaClient } from "../lib/tenant-prisma-manager";
import { geocodeAddress, hashAddress, type AddressParts } from "../integrations/geocoding/client";

// ACT-10: shared by property create/update and the backfill. Coordinates are
// computed from the full address and only again when the address inputs change
// (hash compare) - never on read.

// Written when the address inputs change: clears the old coordinates so a stale
// pin is never shown for a new address, and re-arms the geocoder.
export const GEOCODE_RESET = {
  latitude: null,
  longitude: null,
  geocodedAt: null,
  geocodeAttempts: 0,
  geocodeError: null,
  geocodePrecision: null,
  geocodePlaceId: null,
  geocodeAddressHash: null,
} as const;

export function addressChanged(before: AddressParts, after: AddressParts): boolean {
  return hashAddress(before) !== hashAddress(after);
}

// Fire-and-forget safe: geocodeAddress never throws; the update is the only
// thing that can reject, and callers chain `.catch(console.error)`. Called with
// the non-transactional client after the triggering transaction committed.
export async function geocodeProperty(tp: TenantPrismaClient, propertyId: string, address: AddressParts): Promise<void> {
  const { result, error } = await geocodeAddress(address);
  await tp.property.update({
    where: { id: propertyId },
    data: result
      ? {
          latitude: result.latitude,
          longitude: result.longitude,
          geocodedAt: new Date(),
          geocodeError: null,
          geocodePrecision: result.precision,
          geocodePlaceId: result.placeId,
          geocodeAddressHash: hashAddress(address),
          // A fallback/approximate result keeps counting so the backfill retries a bounded number of times.
          ...(result.precision === "POSTCODE_FALLBACK" || result.precision === "APPROXIMATE"
            ? { geocodeAttempts: { increment: 1 } }
            : { geocodeAttempts: 0 }),
        }
      : { geocodeAttempts: { increment: 1 }, geocodeError: error },
  });
}
