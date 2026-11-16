-- Business closures (2026-11-16): tenant-wide closure windows (any dates, free label) that generation, the planner
-- projection and "apply to existing visits" respect. Additive and idempotent; NOT applied by the agent (the startup
-- migrator applies it). New table only, so no rollback is needed. Rules: docs/handoff/backend/2026-11-16-closure-rules.md.
DO $$ BEGIN
  CREATE TYPE "ClosureMode" AS ENUM ('MOVE', 'SKIP');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "BusinessClosure" (
  "id" TEXT NOT NULL,
  "label" TEXT NOT NULL,
  "startDate" TIMESTAMP(3) NOT NULL,
  "endDate" TIMESTAMP(3) NOT NULL,
  "mode" "ClosureMode" NOT NULL,
  "notifyCustomers" BOOLEAN NOT NULL DEFAULT false,
  "roundIds" TEXT[] NOT NULL DEFAULT '{}',
  "appliedAt" TIMESTAMPTZ,
  "createdById" TEXT,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ NOT NULL,
  CONSTRAINT "BusinessClosure_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "BusinessClosure_startDate_endDate_idx" ON "BusinessClosure"("startDate", "endDate");
