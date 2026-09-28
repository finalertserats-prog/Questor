-- CreateTable
CREATE TABLE "CatalogRefreshRun" (
    "id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'running',
    "trigger" TEXT NOT NULL,
    "triggeredById" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "cursorJson" TEXT NOT NULL DEFAULT '{}',
    "statsJson" TEXT NOT NULL DEFAULT '{}',
    "llmCalls" INTEGER NOT NULL DEFAULT 0,
    "researchCalls" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT NOT NULL DEFAULT '',

    CONSTRAINT "CatalogRefreshRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CatalogProposal" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "title" TEXT NOT NULL,
    "normalizedTitle" TEXT NOT NULL,
    "domainId" TEXT,
    "familyId" TEXT,
    "summary" TEXT NOT NULL DEFAULT '',
    "targetRoleId" TEXT,
    "sourcesJson" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "reviewerNote" TEXT NOT NULL DEFAULT '',
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "createdCatalogRoleId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CatalogProposal_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CatalogRefreshRun_status_startedAt_idx" ON "CatalogRefreshRun"("status", "startedAt");

-- CreateIndex
CREATE INDEX "CatalogProposal_status_createdAt_idx" ON "CatalogProposal"("status", "createdAt");

-- CreateIndex
CREATE INDEX "CatalogProposal_normalizedTitle_idx" ON "CatalogProposal"("normalizedTitle");

-- CreateIndex
CREATE INDEX "CatalogProposal_runId_status_idx" ON "CatalogProposal"("runId", "status");

-- AddForeignKey
ALTER TABLE "CatalogRefreshRun" ADD CONSTRAINT "CatalogRefreshRun_triggeredById_fkey" FOREIGN KEY ("triggeredById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CatalogProposal" ADD CONSTRAINT "CatalogProposal_runId_fkey" FOREIGN KEY ("runId") REFERENCES "CatalogRefreshRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CatalogProposal" ADD CONSTRAINT "CatalogProposal_domainId_fkey" FOREIGN KEY ("domainId") REFERENCES "CatalogDomain"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CatalogProposal" ADD CONSTRAINT "CatalogProposal_familyId_fkey" FOREIGN KEY ("familyId") REFERENCES "CatalogJobFamily"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CatalogProposal" ADD CONSTRAINT "CatalogProposal_targetRoleId_fkey" FOREIGN KEY ("targetRoleId") REFERENCES "CatalogRole"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CatalogProposal" ADD CONSTRAINT "CatalogProposal_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CatalogProposal" ADD CONSTRAINT "CatalogProposal_createdCatalogRoleId_fkey" FOREIGN KEY ("createdCatalogRoleId") REFERENCES "CatalogRole"("id") ON DELETE SET NULL ON UPDATE CASCADE;

