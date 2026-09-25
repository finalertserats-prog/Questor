-- One reviewer, one assessment, and the record that they read the interview
-- before they judged it.
--
-- The review page has always tracked how far the reviewer had got and said so
-- in a note beside the form. The note was guidance, and said so, because a gate
-- that lives in the browser is not a gate. This table is what makes it one:
-- POST /assessments/:id/review refuses without a row here, so the sentence on
-- the candidate's consent screen about a person reading their interview is a
-- rule the server keeps rather than a habit the page encouraged.
--
-- It holds no transcript text. `turnsSeen`/`turnsTotal` count the conversation
-- the reviewer was shown — turns, not scroll distance, so the requirement is
-- reachable with a keyboard and with a screen reader. `attestation` is set only
-- on the "I read it elsewhere" path and is the reviewer's own sentence saying
-- where; an erasure removes the row with the rest of the candidate's record,
-- while the audit event that the reading happened survives, as consent and
-- decision events do.

-- CreateTable
CREATE TABLE "TranscriptRead" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "assessmentId" TEXT NOT NULL,
    "reviewerId" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "turnsSeen" INTEGER NOT NULL DEFAULT 0,
    "turnsTotal" INTEGER NOT NULL DEFAULT 0,
    "attestation" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TranscriptRead_pkey" PRIMARY KEY ("id")
);

-- One record per reviewer per assessment: a reviewer who reads it twice has
-- read it, and the unique key is what lets a double-clicked "I have read this"
-- land once rather than racing itself.
-- CreateIndex
CREATE UNIQUE INDEX "TranscriptRead_assessmentId_reviewerId_key" ON "TranscriptRead"("assessmentId", "reviewerId");

-- CreateIndex
CREATE INDEX "TranscriptRead_tenantId_idx" ON "TranscriptRead"("tenantId");

-- AddForeignKey
ALTER TABLE "TranscriptRead" ADD CONSTRAINT "TranscriptRead_assessmentId_fkey" FOREIGN KEY ("assessmentId") REFERENCES "AssessmentVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TranscriptRead" ADD CONSTRAINT "TranscriptRead_reviewerId_fkey" FOREIGN KEY ("reviewerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
