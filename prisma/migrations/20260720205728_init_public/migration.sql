-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('ADMIN', 'MANAGER', 'TECHNICIAN');

-- CreateTable
CREATE TABLE "Profile" (
    "id" TEXT NOT NULL,
    "supabaseUserId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "role" "UserRole" NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Profile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Tenant" (
    "id" TEXT NOT NULL,
    "schemaName" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Tenant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TenantInvite" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "role" "UserRole" NOT NULL DEFAULT 'TECHNICIAN',
    "token" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "acceptedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TenantInvite_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Profile_supabaseUserId_key" ON "Profile"("supabaseUserId");

-- CreateIndex
CREATE INDEX "Profile_tenantId_idx" ON "Profile"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "Tenant_schemaName_key" ON "Tenant"("schemaName");

-- CreateIndex
CREATE UNIQUE INDEX "TenantInvite_token_key" ON "TenantInvite"("token");

-- CreateIndex
CREATE INDEX "TenantInvite_tenantId_idx" ON "TenantInvite"("tenantId");

-- CreateIndex
CREATE INDEX "TenantInvite_token_idx" ON "TenantInvite"("token");

-- AddForeignKey
ALTER TABLE "Profile" ADD CONSTRAINT "Profile_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
