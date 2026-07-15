/*
  Money -> Decimal(10,2). Postgres has no implicit assignment cast from `money`
  to `numeric`, so each ALTER needs an explicit `USING "col"::numeric`. The money
  value converts cleanly (e.g. £35.00 -> 35.00); tables hold only seed data.
*/
-- AlterTable
ALTER TABLE "Invoice" ALTER COLUMN "amount" SET DATA TYPE DECIMAL(10,2) USING "amount"::numeric;

-- AlterTable
ALTER TABLE "Payment" ALTER COLUMN "amount" SET DATA TYPE DECIMAL(10,2) USING "amount"::numeric;

-- AlterTable
ALTER TABLE "Service" ALTER COLUMN "defaultPrice" SET DATA TYPE DECIMAL(10,2) USING "defaultPrice"::numeric;

-- AlterTable
ALTER TABLE "ServicePlan" ALTER COLUMN "price" SET DATA TYPE DECIMAL(10,2) USING "price"::numeric;

-- AlterTable
ALTER TABLE "Visit" ALTER COLUMN "price" SET DATA TYPE DECIMAL(10,2) USING "price"::numeric;
