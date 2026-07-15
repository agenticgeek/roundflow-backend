-- AlterTable
-- Backfill existing rows with the current timestamp, then drop the default so
-- `updatedAt` is managed by Prisma at the application layer (@updatedAt), matching
-- every other mutable model. Without the temporary default the ADD COLUMN would
-- fail on the non-empty table.
ALTER TABLE "ServiceArea" ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "ServiceArea" ALTER COLUMN "updatedAt" DROP DEFAULT;
