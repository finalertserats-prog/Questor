-- AlterTable
ALTER TABLE "Candidate" ADD COLUMN     "linkedinUrl" TEXT NOT NULL DEFAULT '';

-- CreateTable
CREATE TABLE "CandidateImportBatch" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CandidateImportBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CandidateImportRow" (
    "id" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "rowKey" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "fullName" TEXT NOT NULL DEFAULT '',
    "email" TEXT NOT NULL DEFAULT '',
    "emailNormalized" TEXT NOT NULL DEFAULT '',
    "phone" TEXT NOT NULL DEFAULT '',
    "linkedinUrl" TEXT NOT NULL DEFAULT '',
    "filename" TEXT NOT NULL DEFAULT '',
    "contentType" TEXT NOT NULL DEFAULT '',
    "resumeText" TEXT,
    "readError" TEXT NOT NULL DEFAULT '',
    "included" BOOLEAN NOT NULL DEFAULT true,
    "outcome" TEXT NOT NULL DEFAULT 'pending',
    "candidateId" TEXT,
    "cvAttached" BOOLEAN NOT NULL DEFAULT false,
    "error" TEXT NOT NULL DEFAULT '',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CandidateImportRow_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CandidateImportBatch_tenantId_createdById_idx" ON "CandidateImportBatch"("tenantId", "createdById");

-- CreateIndex
CREATE INDEX "CandidateImportBatch_expiresAt_idx" ON "CandidateImportBatch"("expiresAt");

-- CreateIndex
CREATE INDEX "CandidateImportRow_tenantId_emailNormalized_idx" ON "CandidateImportRow"("tenantId", "emailNormalized");

-- CreateIndex
CREATE UNIQUE INDEX "CandidateImportRow_batchId_rowKey_key" ON "CandidateImportRow"("batchId", "rowKey");

-- AddForeignKey
ALTER TABLE "CandidateImportRow" ADD CONSTRAINT "CandidateImportRow_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "CandidateImportBatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

