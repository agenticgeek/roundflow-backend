-- Wave 2B-1 (BE-17): the idempotency row is inserted first (state IN_PROGRESS) so concurrent same-key requests
-- run once; admin writes use the same table (actorId = profile id). Additive and idempotent.
ALTER TABLE "IdempotencyRecord" ALTER COLUMN "technicianId" DROP NOT NULL;
ALTER TABLE "IdempotencyRecord" ALTER COLUMN "responseStatus" DROP NOT NULL;
ALTER TABLE "IdempotencyRecord" ALTER COLUMN "responseBody" DROP NOT NULL;
ALTER TABLE "IdempotencyRecord" ADD COLUMN IF NOT EXISTS "actorId" TEXT;
ALTER TABLE "IdempotencyRecord" ADD COLUMN IF NOT EXISTS "state" TEXT NOT NULL DEFAULT 'DONE';
