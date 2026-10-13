-- Per-user UI preferences (free-form JSON owned by the frontend).
ALTER TABLE "Profile"
  ADD COLUMN IF NOT EXISTS "preferences" JSONB;
