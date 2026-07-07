-- CreateEnum
CREATE TYPE "PaymentTiming" AS ENUM ('COLLECT_AFTER_VISIT', 'COLLECT_BEFORE_VISIT', 'COLLECT_ON_DATE');

-- AlterTable
ALTER TABLE "BusinessSettings" ADD COLUMN     "debtHoldEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "gocardlessConnected" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "paymentRule" "PaymentTiming",
ADD COLUMN     "stripeConnected" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Technician" ADD COLUMN     "name" TEXT;
