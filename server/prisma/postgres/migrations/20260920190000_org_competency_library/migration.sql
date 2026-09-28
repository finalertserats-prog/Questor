-- CreateTable
CREATE TABLE "OrgCompetency" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "nameKey" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "definition" TEXT NOT NULL DEFAULT '',
    "indicatorsJson" TEXT NOT NULL DEFAULT '[]',
    "createdBy" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrgCompetency_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "OrgCompetency_tenantId_nameKey_key" ON "OrgCompetency"("tenantId", "nameKey");

-- AddForeignKey
ALTER TABLE "OrgCompetency" ADD CONSTRAINT "OrgCompetency_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
