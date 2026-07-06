-- DropForeignKey
ALTER TABLE "Round" DROP CONSTRAINT "Round_technicianId_fkey";

-- AlterTable
ALTER TABLE "Round" DROP COLUMN "technicianId";

