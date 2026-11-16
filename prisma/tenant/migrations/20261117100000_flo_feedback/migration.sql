-- Flo AI v2 (2026-11-17): thumbs rating + optional comment on an answer, and the compact data summary an answer was built
-- from (replayed as untrusted history). Additive and idempotent; NOT applied by the agent (the startup migrator applies it).
ALTER TABLE "FloMessage" ADD COLUMN IF NOT EXISTS "rating" TEXT;
ALTER TABLE "FloMessage" ADD COLUMN IF NOT EXISTS "ratingComment" TEXT;
ALTER TABLE "FloMessage" ADD COLUMN IF NOT EXISTS "dataSummary" JSONB;
