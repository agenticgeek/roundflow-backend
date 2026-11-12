-- Flo AI (2026-11-10): admin-only read-only assistant conversations. Additive and idempotent; NOT applied by the
-- agent (the startup migrator applies it).
DO $$ BEGIN
  CREATE TYPE "FloRole" AS ENUM ('USER', 'ASSISTANT');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE "FloMessageStatus" AS ENUM ('OK', 'ERROR', 'DECLINED', 'ABORTED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "FloConversation" (
  "id" TEXT NOT NULL,
  "profileId" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ NOT NULL,
  CONSTRAINT "FloConversation_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "FloMessage" (
  "id" TEXT NOT NULL,
  "conversationId" TEXT NOT NULL,
  "role" "FloRole" NOT NULL,
  "mode" TEXT,
  "model" TEXT,
  "text" TEXT NOT NULL DEFAULT '',
  "answer" JSONB,
  "toolCalls" JSONB,
  "warnings" TEXT[] DEFAULT ARRAY[]::TEXT[],
  "inputTokens" INTEGER,
  "outputTokens" INTEGER,
  "cachedTokens" INTEGER,
  "durationMs" INTEGER,
  "status" "FloMessageStatus" NOT NULL DEFAULT 'OK',
  "declineReason" TEXT,
  "errorCode" TEXT,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FloMessage_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "FloConversation_profileId_updatedAt_idx" ON "FloConversation"("profileId", "updatedAt");
CREATE INDEX IF NOT EXISTS "FloMessage_conversationId_createdAt_idx" ON "FloMessage"("conversationId", "createdAt");
CREATE INDEX IF NOT EXISTS "FloMessage_status_createdAt_idx" ON "FloMessage"("status", "createdAt");

DO $$ BEGIN
  ALTER TABLE "FloMessage" ADD CONSTRAINT "FloMessage_conversationId_fkey"
    FOREIGN KEY ("conversationId") REFERENCES "FloConversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
