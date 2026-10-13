-- Chat image attachments (type = PHOTOS).
ALTER TABLE "ChatMessage" ADD COLUMN IF NOT EXISTS "photoUrls" TEXT[] NOT NULL DEFAULT '{}';

-- Push device registrations.
CREATE TABLE IF NOT EXISTS "Device" (
  "id" TEXT NOT NULL,
  "profileId" TEXT NOT NULL,
  "pushToken" TEXT NOT NULL,
  "platform" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "Device_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "Device_pushToken_key" ON "Device" ("pushToken");
CREATE INDEX IF NOT EXISTS "Device_profileId_idx" ON "Device" ("profileId");

-- In-app notifications.
CREATE TABLE IF NOT EXISTS "Notification" (
  "id" TEXT NOT NULL,
  "profileId" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "body" TEXT,
  "read" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "Notification_profileId_read_idx" ON "Notification" ("profileId", "read");
CREATE INDEX IF NOT EXISTS "Notification_profileId_createdAt_idx" ON "Notification" ("profileId", "createdAt");
