ALTER TABLE "Tenant"
  ADD COLUMN IF NOT EXISTS "ghlLocationId" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "Tenant_ghlLocationId_key" ON "Tenant"("ghlLocationId");
