-- ACT-02..04: carried-over visits. Additive, idempotent.
ALTER TABLE "Visit" ADD COLUMN IF NOT EXISTS "carriedOverFromDate" DATE;
ALTER TABLE "Visit" ADD COLUMN IF NOT EXISTS "carryoverCount" INTEGER NOT NULL DEFAULT 0;
