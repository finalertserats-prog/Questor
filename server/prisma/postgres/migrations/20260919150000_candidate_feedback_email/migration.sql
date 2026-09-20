-- CreateTable
CREATE TABLE "CandidateFeedbackEmail" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "assessmentId" TEXT NOT NULL,
    "candidateId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "trigger" TEXT NOT NULL DEFAULT 'auto',
    "requestedByUserId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "skipReason" TEXT NOT NULL DEFAULT '',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3),
    "claimedAt" TIMESTAMP(3),
    "lastError" TEXT NOT NULL DEFAULT '',
    "subject" TEXT NOT NULL DEFAULT '',
    "bodyText" TEXT NOT NULL DEFAULT '',
    "contentJson" TEXT NOT NULL DEFAULT '',
    "contentSource" TEXT NOT NULL DEFAULT '',
    "delivered" BOOLEAN NOT NULL DEFAULT false,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CandidateFeedbackEmail_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CandidateFeedbackEmail_sessionId_key" ON "CandidateFeedbackEmail"("sessionId");

-- CreateIndex
CREATE INDEX "CandidateFeedbackEmail_status_nextAttemptAt_idx" ON "CandidateFeedbackEmail"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "CandidateFeedbackEmail_tenantId_status_idx" ON "CandidateFeedbackEmail"("tenantId", "status");

-- CreateIndex
CREATE INDEX "CandidateFeedbackEmail_candidateId_idx" ON "CandidateFeedbackEmail"("candidateId");

-- CreateIndex
CREATE INDEX "CandidateFeedbackEmail_assessmentId_idx" ON "CandidateFeedbackEmail"("assessmentId");

-- AddForeignKey
ALTER TABLE "CandidateFeedbackEmail" ADD CONSTRAINT "CandidateFeedbackEmail_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "InterviewSession"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CandidateFeedbackEmail" ADD CONSTRAINT "CandidateFeedbackEmail_assessmentId_fkey" FOREIGN KEY ("assessmentId") REFERENCES "AssessmentVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CandidateFeedbackEmail" ADD CONSTRAINT "CandidateFeedbackEmail_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "Candidate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

