ALTER TABLE "BusinessSettings"
  ADD COLUMN IF NOT EXISTS "ghlConnected"                  BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "ghlLocationId"                 TEXT,
  ADD COLUMN IF NOT EXISTS "ghlAccessTokenEncrypted"       TEXT,
  ADD COLUMN IF NOT EXISTS "ghlRefreshTokenEncrypted"      TEXT,
  ADD COLUMN IF NOT EXISTS "ghlTokenExpiresAt"             TIMESTAMPTZ;
