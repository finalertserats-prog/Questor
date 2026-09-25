-- AlterTable
ALTER TABLE "InterviewRound" ADD COLUMN     "durationMinutes" INTEGER NOT NULL DEFAULT 60,
ADD COLUMN     "meetingError" TEXT,
ADD COLUMN     "meetingExternalId" TEXT,
ADD COLUMN     "meetingProvider" TEXT,
ADD COLUMN     "meetingStatus" TEXT,
ADD COLUMN     "meetingUpdatedAt" TIMESTAMP(3),
ADD COLUMN     "meetingUrl" TEXT;

-- AlterTable
ALTER TABLE "WebhookEndpoint" ADD COLUMN     "sendLegacySignature" BOOLEAN NOT NULL DEFAULT false;

-- Webhooks that existed before this release keep receiving the v1 signature
-- until an admin switches it off; only webhooks created from now on are v2-only.
UPDATE "WebhookEndpoint" SET "sendLegacySignature" = true;

-- CreateTable
CREATE TABLE "CandidateFeedbackOptInRequest" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "candidateId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "requestedByUserId" TEXT NOT NULL,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CandidateFeedbackOptInRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RateLimitBucket" (
    "key" TEXT NOT NULL,
    "windowStart" TIMESTAMP(3) NOT NULL,
    "count" INTEGER NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RateLimitBucket_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "AtsConnection" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'generic',
    "baseUrl" TEXT NOT NULL,
    "accountId" TEXT NOT NULL DEFAULT '',
    "atsKey" TEXT NOT NULL,
    "apiKeySealed" TEXT NOT NULL DEFAULT '',
    "source" TEXT NOT NULL DEFAULT 'tenant',
    "status" TEXT NOT NULL DEFAULT 'untested',
    "lastTestedAt" TIMESTAMP(3),
    "disconnectedAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AtsConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AtsRequisitionImport" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "atsKey" TEXT NOT NULL,
    "externalRequisitionId" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AtsRequisitionImport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CandidateAtsLink" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "candidateId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "externalCandidateId" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'manual',
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CandidateAtsLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RoundObservation" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "roundId" TEXT NOT NULL,
    "candidateId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'AWAITING_CANDIDATE',
    "noticeVersion" TEXT NOT NULL,
    "interviewerId" TEXT NOT NULL,
    "interviewerConsentAt" TIMESTAMP(3),
    "candidateTokenHash" TEXT,
    "candidateTokenSealed" TEXT NOT NULL DEFAULT '',
    "candidateConsentAt" TIMESTAMP(3),
    "declinedBy" TEXT,
    "declinedAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "stoppedBy" TEXT,
    "stoppedAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "captureStatus" TEXT NOT NULL DEFAULT 'OK',
    "quotesStatus" TEXT NOT NULL DEFAULT 'PENDING',
    "quotesNote" TEXT NOT NULL DEFAULT '',
    "quotesJson" TEXT NOT NULL DEFAULT '[]',
    "quotesDroppedJson" TEXT NOT NULL DEFAULT '{}',
    "legalHold" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RoundObservation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ObservationSegment" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "observationId" TEXT NOT NULL,
    "index" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "offsetMs" INTEGER NOT NULL,
    "durationMs" INTEGER NOT NULL DEFAULT 0,
    "text" TEXT NOT NULL DEFAULT '',
    "source" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ObservationSegment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CandidateFeedbackOptInRequest_sessionId_key" ON "CandidateFeedbackOptInRequest"("sessionId");

-- CreateIndex
CREATE UNIQUE INDEX "CandidateFeedbackOptInRequest_tokenHash_key" ON "CandidateFeedbackOptInRequest"("tokenHash");

-- CreateIndex
CREATE INDEX "CandidateFeedbackOptInRequest_tenantId_idx" ON "CandidateFeedbackOptInRequest"("tenantId");

-- CreateIndex
CREATE INDEX "CandidateFeedbackOptInRequest_candidateId_idx" ON "CandidateFeedbackOptInRequest"("candidateId");

-- CreateIndex
CREATE INDEX "RateLimitBucket_expiresAt_idx" ON "RateLimitBucket"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "AtsConnection_tenantId_key" ON "AtsConnection"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "AtsConnection_atsKey_key" ON "AtsConnection"("atsKey");

-- CreateIndex
CREATE UNIQUE INDEX "AtsRequisitionImport_roleId_key" ON "AtsRequisitionImport"("roleId");

-- CreateIndex
CREATE INDEX "AtsRequisitionImport_tenantId_idx" ON "AtsRequisitionImport"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "AtsRequisitionImport_atsKey_externalRequisitionId_key" ON "AtsRequisitionImport"("atsKey", "externalRequisitionId");

-- CreateIndex
CREATE INDEX "CandidateAtsLink_candidateId_idx" ON "CandidateAtsLink"("candidateId");

-- CreateIndex
CREATE UNIQUE INDEX "CandidateAtsLink_tenantId_candidateId_connectionId_key" ON "CandidateAtsLink"("tenantId", "candidateId", "connectionId");

-- CreateIndex
CREATE UNIQUE INDEX "CandidateAtsLink_tenantId_connectionId_externalCandidateId_key" ON "CandidateAtsLink"("tenantId", "connectionId", "externalCandidateId");

-- CreateIndex
CREATE UNIQUE INDEX "RoundObservation_roundId_key" ON "RoundObservation"("roundId");

-- CreateIndex
CREATE UNIQUE INDEX "RoundObservation_candidateTokenHash_key" ON "RoundObservation"("candidateTokenHash");

-- CreateIndex
CREATE INDEX "RoundObservation_tenantId_idx" ON "RoundObservation"("tenantId");

-- CreateIndex
CREATE INDEX "RoundObservation_candidateId_idx" ON "RoundObservation"("candidateId");

-- CreateIndex
CREATE INDEX "ObservationSegment_tenantId_idx" ON "ObservationSegment"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "ObservationSegment_observationId_index_key" ON "ObservationSegment"("observationId", "index");

-- AddForeignKey
ALTER TABLE "CandidateFeedbackOptInRequest" ADD CONSTRAINT "CandidateFeedbackOptInRequest_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "InterviewSession"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CandidateFeedbackOptInRequest" ADD CONSTRAINT "CandidateFeedbackOptInRequest_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "Candidate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AtsConnection" ADD CONSTRAINT "AtsConnection_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AtsRequisitionImport" ADD CONSTRAINT "AtsRequisitionImport_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AtsRequisitionImport" ADD CONSTRAINT "AtsRequisitionImport_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "AtsConnection"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AtsRequisitionImport" ADD CONSTRAINT "AtsRequisitionImport_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "Role"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CandidateAtsLink" ADD CONSTRAINT "CandidateAtsLink_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CandidateAtsLink" ADD CONSTRAINT "CandidateAtsLink_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "Candidate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CandidateAtsLink" ADD CONSTRAINT "CandidateAtsLink_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "AtsConnection"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoundObservation" ADD CONSTRAINT "RoundObservation_roundId_fkey" FOREIGN KEY ("roundId") REFERENCES "InterviewRound"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ObservationSegment" ADD CONSTRAINT "ObservationSegment_observationId_fkey" FOREIGN KEY ("observationId") REFERENCES "RoundObservation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

