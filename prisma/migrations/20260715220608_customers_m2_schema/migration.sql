-- CreateEnum
CREATE TYPE "NoteType" AS ENUM ('INTERNAL', 'RISK_WARNING', 'CUSTOMER');

-- AlterTable
ALTER TABLE "ServicePlan" ADD COLUMN     "pauseEndDate" TIMESTAMP(3),
ADD COLUMN     "pauseStartDate" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "PropertyNote" (
    "id" TEXT NOT NULL,
    "propertyId" TEXT NOT NULL,
    "type" "NoteType" NOT NULL DEFAULT 'INTERNAL',
    "body" TEXT NOT NULL,
    "authorProfileId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PropertyNote_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PropertyNote_propertyId_idx" ON "PropertyNote"("propertyId");

-- CreateIndex
CREATE INDEX "PropertyNote_authorProfileId_idx" ON "PropertyNote"("authorProfileId");

-- AddForeignKey
ALTER TABLE "PropertyNote" ADD CONSTRAINT "PropertyNote_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "Property"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PropertyNote" ADD CONSTRAINT "PropertyNote_authorProfileId_fkey" FOREIGN KEY ("authorProfileId") REFERENCES "Profile"("id") ON DELETE SET NULL ON UPDATE CASCADE;
