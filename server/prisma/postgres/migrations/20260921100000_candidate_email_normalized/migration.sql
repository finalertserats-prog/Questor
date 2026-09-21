-- AlterTable
ALTER TABLE "Candidate" ADD COLUMN     "emailNormalized" TEXT NOT NULL DEFAULT '';

-- Backfill: the same trim + lowercase the application writes (normalizeEmail
-- in server/src/services/userEmail.ts), so rows added before this column
-- existed are found by search and by the same-person-same-role check.
UPDATE "Candidate" SET "emailNormalized" = lower(trim("email"));

-- CreateIndex
CREATE INDEX "Candidate_tenantId_emailNormalized_idx" ON "Candidate"("tenantId", "emailNormalized");
