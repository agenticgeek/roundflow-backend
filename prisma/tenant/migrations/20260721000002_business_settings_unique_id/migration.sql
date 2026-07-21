-- Add a unique singleton key to BusinessSettings so concurrent first-write
-- requests cannot produce two rows. Existing rows get the default value.
ALTER TABLE "BusinessSettings" ADD COLUMN "uniqueId" TEXT NOT NULL DEFAULT 'singleton';
ALTER TABLE "BusinessSettings" ADD CONSTRAINT "BusinessSettings_uniqueId_key" UNIQUE ("uniqueId");
