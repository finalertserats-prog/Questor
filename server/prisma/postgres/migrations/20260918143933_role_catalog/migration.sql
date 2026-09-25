-- AlterTable
ALTER TABLE "Role" ADD COLUMN     "catalogRoleId" TEXT,
ADD COLUMN     "experienceBand" TEXT,
ADD COLUMN     "regionCode" TEXT,
ADD COLUMN     "techStackJson" TEXT NOT NULL DEFAULT '[]';

-- CreateTable
CREATE TABLE "CatalogDomain" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "summary" TEXT NOT NULL DEFAULT '',
    "sortOrder" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CatalogDomain_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CatalogJobFamily" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CatalogJobFamily_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CatalogRegion" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CatalogRegion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CatalogRole" (
    "id" TEXT NOT NULL,
    "domainId" TEXT NOT NULL,
    "familyId" TEXT,
    "title" TEXT NOT NULL,
    "normalizedTitle" TEXT NOT NULL,
    "summary" TEXT NOT NULL DEFAULT '',
    "marketSignal" TEXT NOT NULL DEFAULT '',
    "techStackJson" TEXT NOT NULL DEFAULT '[]',
    "source" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdByTenantId" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CatalogRole_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CatalogRoleAlias" (
    "id" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,
    "alias" TEXT NOT NULL,
    "normalizedAlias" TEXT NOT NULL,
    "locale" TEXT NOT NULL DEFAULT 'en',
    "source" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CatalogRoleAlias_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CatalogDomain_slug_key" ON "CatalogDomain"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "CatalogJobFamily_name_key" ON "CatalogJobFamily"("name");

-- CreateIndex
CREATE UNIQUE INDEX "CatalogRegion_code_key" ON "CatalogRegion"("code");

-- CreateIndex
CREATE INDEX "CatalogRole_normalizedTitle_idx" ON "CatalogRole"("normalizedTitle");

-- CreateIndex
CREATE UNIQUE INDEX "CatalogRole_domainId_normalizedTitle_key" ON "CatalogRole"("domainId", "normalizedTitle");

-- CreateIndex
CREATE INDEX "CatalogRoleAlias_normalizedAlias_idx" ON "CatalogRoleAlias"("normalizedAlias");

-- CreateIndex
CREATE UNIQUE INDEX "CatalogRoleAlias_roleId_normalizedAlias_key" ON "CatalogRoleAlias"("roleId", "normalizedAlias");

-- CreateIndex
CREATE INDEX "Role_catalogRoleId_idx" ON "Role"("catalogRoleId");

-- CreateIndex
CREATE INDEX "InterviewSession_tenantId_roleId_candidateId_idx" ON "InterviewSession"("tenantId", "roleId", "candidateId");

-- AddForeignKey
ALTER TABLE "CatalogRole" ADD CONSTRAINT "CatalogRole_domainId_fkey" FOREIGN KEY ("domainId") REFERENCES "CatalogDomain"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CatalogRole" ADD CONSTRAINT "CatalogRole_familyId_fkey" FOREIGN KEY ("familyId") REFERENCES "CatalogJobFamily"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CatalogRoleAlias" ADD CONSTRAINT "CatalogRoleAlias_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "CatalogRole"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Role" ADD CONSTRAINT "Role_catalogRoleId_fkey" FOREIGN KEY ("catalogRoleId") REFERENCES "CatalogRole"("id") ON DELETE SET NULL ON UPDATE CASCADE;

