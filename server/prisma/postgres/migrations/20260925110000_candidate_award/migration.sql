-- A tier struck onto a candidate's journey.
--
-- A tier is earned when the candidate is promoted OUT of it, not into it, so
-- one Gold-to-Diamond promotion inserts two rows in one transaction. Bronze is
-- written by the CV being read against an approved scorecard, which no person
-- does, which is why awardedByUserId is nullable.
--
-- verifyToken is independent randomness, not a function of the printed
-- reference: the reference is on paper anyone may be handed, and a derivable
-- token would open every other certificate to whoever reads one.
CREATE TABLE "CandidateAward" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "candidateId" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,
    "tier" TEXT NOT NULL,
    "awardedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "awardedByUserId" TEXT,
    "reference" TEXT NOT NULL,
    "verifyToken" TEXT NOT NULL,
    "evidenceJson" TEXT NOT NULL,
    "sentToCandidateAt" TIMESTAMP(3),
    "sentByUserId" TEXT,

    CONSTRAINT "CandidateAward_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CandidateAward_reference_key" ON "CandidateAward"("reference");

-- CreateIndex
CREATE UNIQUE INDEX "CandidateAward_verifyToken_key" ON "CandidateAward"("verifyToken");

-- A tier is struck once. The second attempt at the same tier loses here rather
-- than at a read both attempts had already passed.
CREATE UNIQUE INDEX "CandidateAward_candidateId_roleId_tier_key" ON "CandidateAward"("candidateId", "roleId", "tier");

-- CreateIndex
CREATE INDEX "CandidateAward_tenantId_candidateId_idx" ON "CandidateAward"("tenantId", "candidateId");
