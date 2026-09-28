-- AlterTable
ALTER TABLE "InterviewRound" ADD COLUMN     "recordedByUserId" TEXT,
ADD COLUMN     "peerNotesSeenBefore" BOOLEAN,
ADD COLUMN     "evidenceJson" TEXT NOT NULL DEFAULT '[]';

-- CreateTable
CREATE TABLE "RoundInterviewer" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "roundId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "seat" TEXT NOT NULL DEFAULT 'lead',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RoundInterviewer_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "InterviewRound_pipelineId_stageKey_idx" ON "InterviewRound"("pipelineId", "stageKey");

-- CreateIndex
CREATE INDEX "RoundInterviewer_tenantId_userId_idx" ON "RoundInterviewer"("tenantId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "RoundInterviewer_roundId_userId_key" ON "RoundInterviewer"("roundId", "userId");

-- AddForeignKey
ALTER TABLE "RoundInterviewer" ADD CONSTRAINT "RoundInterviewer_roundId_fkey" FOREIGN KEY ("roundId") REFERENCES "InterviewRound"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoundInterviewer" ADD CONSTRAINT "RoundInterviewer_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
