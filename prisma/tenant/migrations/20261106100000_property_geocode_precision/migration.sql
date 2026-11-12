-- ACT-10: Google geocoding metadata. Additive, idempotent, nullable.
ALTER TABLE "Property" ADD COLUMN IF NOT EXISTS "geocodePrecision" TEXT;
ALTER TABLE "Property" ADD COLUMN IF NOT EXISTS "geocodePlaceId" TEXT;
ALTER TABLE "Property" ADD COLUMN IF NOT EXISTS "geocodeAddressHash" TEXT;
