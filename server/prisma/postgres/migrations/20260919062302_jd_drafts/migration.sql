-- AlterTable
ALTER TABLE "Role" ADD COLUMN     "jdDraftId" TEXT,
ADD COLUMN     "jdOrigin" TEXT NOT NULL DEFAULT '';

-- CreateTable
CREATE TABLE "CatalogJdDraft" (
    "id" TEXT NOT NULL,
    "catalogRoleId" TEXT NOT NULL,
    "experienceBand" TEXT NOT NULL,
    "regionCode" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "text" TEXT NOT NULL DEFAULT '',
    "generator" TEXT NOT NULL DEFAULT '',
    "model" TEXT NOT NULL DEFAULT '',
    "promptVersion" TEXT NOT NULL DEFAULT '',
    "lintJson" TEXT NOT NULL DEFAULT '[]',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CatalogJdDraft_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CatalogJdDraft_status_updatedAt_idx" ON "CatalogJdDraft"("status", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "CatalogJdDraft_catalogRoleId_experienceBand_regionCode_key" ON "CatalogJdDraft"("catalogRoleId", "experienceBand", "regionCode");

-- AddForeignKey
ALTER TABLE "CatalogJdDraft" ADD CONSTRAINT "CatalogJdDraft_catalogRoleId_fkey" FOREIGN KEY ("catalogRoleId") REFERENCES "CatalogRole"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CatalogJdDraft" ADD CONSTRAINT "CatalogJdDraft_regionCode_fkey" FOREIGN KEY ("regionCode") REFERENCES "CatalogRegion"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Role" ADD CONSTRAINT "Role_jdDraftId_fkey" FOREIGN KEY ("jdDraftId") REFERENCES "CatalogJdDraft"("id") ON DELETE SET NULL ON UPDATE CASCADE;

