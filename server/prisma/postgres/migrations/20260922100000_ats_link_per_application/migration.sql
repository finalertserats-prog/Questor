-- An ATS record is one person, and a person has one application (Candidate
-- row) per role, so the record now links to at most one application per role
-- instead of one application in all.

-- AlterTable
ALTER TABLE "CandidateAtsLink" ADD COLUMN     "roleKey" TEXT NOT NULL DEFAULT '';

-- Backfill: each existing link takes its application's role. Existing rows
-- were unique on (tenantId, connectionId, externalCandidateId), so they stay
-- unique once roleKey joins the key.
UPDATE "CandidateAtsLink" AS l
SET "roleKey" = COALESCE(c."roleId", '')
FROM "Candidate" AS c
WHERE c."id" = l."candidateId";

-- DropIndex
DROP INDEX "CandidateAtsLink_tenantId_connectionId_externalCandidateId_key";

-- CreateIndex
CREATE UNIQUE INDEX "CandidateAtsLink_external_role_key" ON "CandidateAtsLink"("tenantId", "connectionId", "externalCandidateId", "roleKey");
