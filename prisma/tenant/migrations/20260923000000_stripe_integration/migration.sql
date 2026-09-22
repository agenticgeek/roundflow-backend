-- Extend enums
ALTER TYPE "PaymentStatus" ADD VALUE IF NOT EXISTS 'CANCELLED';
ALTER TYPE "InvoiceStatus" ADD VALUE IF NOT EXISTS 'VOID';

-- CreateEnum
CREATE TYPE "StripeSessionType" AS ENUM ('ONE_TIME', 'SETUP');
CREATE TYPE "StripeSessionStatus" AS ENUM ('PENDING', 'COMPLETE', 'EXPIRED', 'CANCELLED');

-- AlterTable: BusinessSettings — Stripe credentials (encrypted at rest)
ALTER TABLE "BusinessSettings"
  ADD COLUMN "stripePublishableKey"         TEXT,
  ADD COLUMN "stripeSecretKeyEncrypted"     TEXT,
  ADD COLUMN "stripeWebhookSecretEncrypted" TEXT;

-- AlterTable: Customer — Stripe customer + saved payment method
ALTER TABLE "Customer"
  ADD COLUMN "stripeCustomerId"             TEXT,
  ADD COLUMN "stripeDefaultPaymentMethodId" TEXT;

-- AlterTable: Payment — Stripe receipt URL
ALTER TABLE "Payment"
  ADD COLUMN "stripeReceiptUrl" TEXT;

-- CreateTable: StripeSession
CREATE TABLE "StripeSession" (
  "id"              TEXT           NOT NULL,
  "stripeSessionId" TEXT           NOT NULL,
  "type"            "StripeSessionType" NOT NULL,
  "status"          "StripeSessionStatus" NOT NULL DEFAULT 'PENDING',
  "customerId"      TEXT           NOT NULL,
  "invoiceId"       TEXT,
  "amountTotal"     DECIMAL(10, 2),
  "currency"        TEXT           NOT NULL DEFAULT 'gbp',
  "url"             TEXT           NOT NULL,
  "expiresAt"       TIMESTAMPTZ,
  "completedAt"     TIMESTAMPTZ,
  "createdAt"       TIMESTAMPTZ    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "StripeSession_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "StripeSession_stripeSessionId_key" ON "StripeSession"("stripeSessionId");
CREATE INDEX "StripeSession_customerId_idx"  ON "StripeSession"("customerId");
CREATE INDEX "StripeSession_invoiceId_idx"   ON "StripeSession"("invoiceId");
CREATE INDEX "StripeSession_status_idx"      ON "StripeSession"("status");

-- CreateTable: WebhookEvent — idempotency for inbound webhooks
CREATE TABLE "WebhookEvent" (
  "id"         TEXT        NOT NULL,
  "source"     TEXT        NOT NULL,
  "externalId" TEXT        NOT NULL,
  "receivedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "WebhookEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "WebhookEvent_source_externalId_key" ON "WebhookEvent"("source", "externalId");
