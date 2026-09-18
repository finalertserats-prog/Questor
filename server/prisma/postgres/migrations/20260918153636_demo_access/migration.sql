-- AlterTable
ALTER TABLE "Tenant" ADD COLUMN     "demoExpiresAt" TIMESTAMP(3),
ADD COLUMN     "isDemo" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "DemoGrant" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "company" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'sent',
    "linkTokenHash" TEXT,
    "linkExpiresAt" TIMESTAMP(3),
    "tenantId" TEXT,
    "userId" TEXT,
    "consumedAt" TIMESTAMP(3),
    "sessionEndsAt" TIMESTAMP(3),
    "decisionTokenHash" TEXT,
    "decisionExpiresAt" TIMESTAMP(3),
    "requestIpHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DemoGrant_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DemoGrant_linkTokenHash_key" ON "DemoGrant"("linkTokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "DemoGrant_decisionTokenHash_key" ON "DemoGrant"("decisionTokenHash");

-- CreateIndex
CREATE INDEX "DemoGrant_email_idx" ON "DemoGrant"("email");

-- AddForeignKey
ALTER TABLE "DemoGrant" ADD CONSTRAINT "DemoGrant_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DemoGrant" ADD CONSTRAINT "DemoGrant_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

