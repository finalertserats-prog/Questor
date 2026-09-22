-- The candidates one reviewer is holding side by side on one role.
--
-- Per role AND per user. A shortlist is a working set, not a decision: the
-- decision lives on "CandidatePipeline" in the one verdict vocabulary. Keeping
-- it personal stops one reviewer's reading of a candidate reaching another
-- before they have recorded their own (the anchoring the blind-review policy
-- exists to prevent), and keeps the list free of ids the next viewer's object
-- scope would have to silently drop.

-- CreateTable
CREATE TABLE "CandidateShortlist" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,
    "candidateId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CandidateShortlist_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CandidateShortlist_roleId_userId_candidateId_key" ON "CandidateShortlist"("roleId", "userId", "candidateId");

-- CreateIndex
CREATE INDEX "CandidateShortlist_tenantId_roleId_idx" ON "CandidateShortlist"("tenantId", "roleId");

-- CreateIndex
CREATE INDEX "CandidateShortlist_candidateId_idx" ON "CandidateShortlist"("candidateId");

-- AddForeignKey
ALTER TABLE "CandidateShortlist" ADD CONSTRAINT "CandidateShortlist_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "Role"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CandidateShortlist" ADD CONSTRAINT "CandidateShortlist_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "Candidate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CandidateShortlist" ADD CONSTRAINT "CandidateShortlist_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
