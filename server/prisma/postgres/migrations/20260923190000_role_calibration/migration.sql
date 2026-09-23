-- Role calibration: the AI's assessment learns from what human reviewers decided.
--
-- Five tables, and the shape of them is the design:
--
--   CalibrationObservation       one paired judgement per competency per review
--   CalibrationGlobalObservation the whole of what an opt-in organisation shares
--   CalibrationAdjustment        what was learned, and whether it is applied
--   CalibrationAnchorProposal    an anchor revision waiting on the rubric approval path
--   ReviewerPatternAlert         a pattern for a person to look at, never a finding
--
-- Nothing here has a foreign key onto "AssessmentVersion" or "HumanReview".
-- That is deliberate: calibration is forward-only, so it must never be able to
-- hold a past assessment open, and erasing a person must never be blocked by
-- the statistics. Observations are removed by id at erasure time instead
-- (services/dataRights.ts), which is a delete the person's request can always
-- complete.

-- CreateTable
CREATE TABLE "CalibrationObservation" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,
    "roleKey" TEXT NOT NULL,
    "band" TEXT NOT NULL DEFAULT '',
    "competencyId" TEXT NOT NULL,
    "competencyKey" TEXT NOT NULL,
    "scorecardId" TEXT NOT NULL,
    "scorecardVersion" INTEGER NOT NULL DEFAULT 0,
    "assessmentId" TEXT NOT NULL,
    "reviewId" TEXT NOT NULL,
    "reviewerId" TEXT NOT NULL,
    "aiLevel" INTEGER,
    "humanLevel" INTEGER,
    "delta" INTEGER,
    "magnitude" TEXT NOT NULL DEFAULT 'none',
    "verdictAi" TEXT NOT NULL DEFAULT '',
    "verdictHuman" TEXT NOT NULL DEFAULT '',
    "verdictAgreed" BOOLEAN NOT NULL DEFAULT true,
    "reasonText" TEXT NOT NULL DEFAULT '',
    "reasonRedacted" BOOLEAN NOT NULL DEFAULT false,
    "blindReview" BOOLEAN NOT NULL DEFAULT false,
    "aiConfidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "notEnoughEvidence" BOOLEAN NOT NULL DEFAULT false,
    "evidenceCount" INTEGER NOT NULL DEFAULT 0,
    "evidenceTurnIdsJson" TEXT NOT NULL DEFAULT '[]',
    "observedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CalibrationObservation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CalibrationObservation_reviewId_competencyId_key" ON "CalibrationObservation"("reviewId", "competencyId");

-- CreateIndex
CREATE INDEX "CalibrationObservation_tenantId_roleKey_competencyKey_band_o_idx" ON "CalibrationObservation"("tenantId", "roleKey", "competencyKey", "band", "observedAt");

-- CreateIndex
CREATE INDEX "CalibrationObservation_tenantId_reviewerId_observedAt_idx" ON "CalibrationObservation"("tenantId", "reviewerId", "observedAt");

-- CreateIndex
CREATE INDEX "CalibrationObservation_assessmentId_idx" ON "CalibrationObservation"("assessmentId");

-- CreateTable
CREATE TABLE "CalibrationGlobalObservation" (
    "id" TEXT NOT NULL,
    "roleKey" TEXT NOT NULL,
    "competencyKey" TEXT NOT NULL,
    "band" TEXT NOT NULL DEFAULT '',
    "aiLevel" INTEGER,
    "humanLevel" INTEGER,
    "delta" INTEGER,
    "magnitude" TEXT NOT NULL DEFAULT 'none',
    "verdictAgreed" BOOLEAN NOT NULL DEFAULT true,
    "blindReview" BOOLEAN NOT NULL DEFAULT false,
    "reviewerPseudonym" TEXT NOT NULL,
    "observedMonth" TEXT NOT NULL,
    "sourceHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CalibrationGlobalObservation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CalibrationGlobalObservation_sourceHash_key" ON "CalibrationGlobalObservation"("sourceHash");

-- CreateIndex
CREATE INDEX "CalibrationGlobalObservation_roleKey_competencyKey_band_obse_idx" ON "CalibrationGlobalObservation"("roleKey", "competencyKey", "band", "observedMonth");

-- CreateTable
CREATE TABLE "CalibrationAdjustment" (
    "id" TEXT NOT NULL,
    "scope" TEXT NOT NULL DEFAULT 'org',
    "tenantId" TEXT NOT NULL DEFAULT '',
    "roleKey" TEXT NOT NULL,
    "roleId" TEXT NOT NULL DEFAULT '',
    "competencyKey" TEXT NOT NULL,
    "competencyId" TEXT NOT NULL DEFAULT '',
    "band" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'held',
    "delta" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "measuredMedian" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "ciLow" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "ciHigh" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "ciKnown" BOOLEAN NOT NULL DEFAULT false,
    "observations" INTEGER NOT NULL DEFAULT 0,
    "reviewers" INTEGER NOT NULL DEFAULT 0,
    "majorDisagreements" INTEGER NOT NULL DEFAULT 0,
    "sinceAt" TIMESTAMP(3),
    "holdReason" TEXT NOT NULL DEFAULT '',
    "statement" TEXT NOT NULL DEFAULT '',
    "themesJson" TEXT NOT NULL DEFAULT '[]',
    "fairnessJson" TEXT NOT NULL DEFAULT '{}',
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "activatedAt" TIMESTAMP(3),
    "revertedAt" TIMESTAMP(3),
    "revertedById" TEXT NOT NULL DEFAULT '',
    "revertReason" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CalibrationAdjustment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CalibrationAdjustment_scope_tenantId_roleKey_competencyKey_b_key" ON "CalibrationAdjustment"("scope", "tenantId", "roleKey", "competencyKey", "band");

-- CreateIndex
CREATE INDEX "CalibrationAdjustment_tenantId_status_computedAt_idx" ON "CalibrationAdjustment"("tenantId", "status", "computedAt");

-- CreateIndex
CREATE INDEX "CalibrationAdjustment_scope_roleKey_competencyKey_band_statu_idx" ON "CalibrationAdjustment"("scope", "roleKey", "competencyKey", "band", "status");

-- CreateTable
CREATE TABLE "CalibrationAnchorProposal" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,
    "roleKey" TEXT NOT NULL,
    "competencyId" TEXT NOT NULL,
    "competencyKey" TEXT NOT NULL,
    "band" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'proposed',
    "themesJson" TEXT NOT NULL DEFAULT '[]',
    "anchorsJson" TEXT NOT NULL DEFAULT '[]',
    "observations" INTEGER NOT NULL DEFAULT 0,
    "reviewers" INTEGER NOT NULL DEFAULT 0,
    "scorecardId" TEXT NOT NULL DEFAULT '',
    "decidedById" TEXT NOT NULL DEFAULT '',
    "decidedAt" TIMESTAMP(3),
    "decidedReason" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CalibrationAnchorProposal_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CalibrationAnchorProposal_tenantId_roleId_competencyId_band_key" ON "CalibrationAnchorProposal"("tenantId", "roleId", "competencyId", "band");

-- CreateIndex
CREATE INDEX "CalibrationAnchorProposal_tenantId_status_createdAt_idx" ON "CalibrationAnchorProposal"("tenantId", "status", "createdAt");

-- CreateTable
CREATE TABLE "ReviewerPatternAlert" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "reviewerId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "sample" INTEGER NOT NULL DEFAULT 0,
    "observed" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "baseline" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "statement" TEXT NOT NULL DEFAULT '',
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedById" TEXT NOT NULL DEFAULT '',
    "decidedAt" TIMESTAMP(3),
    "decidedNote" TEXT NOT NULL DEFAULT '',

    CONSTRAINT "ReviewerPatternAlert_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ReviewerPatternAlert_tenantId_reviewerId_kind_key" ON "ReviewerPatternAlert"("tenantId", "reviewerId", "kind");

-- CreateIndex
CREATE INDEX "ReviewerPatternAlert_tenantId_status_lastSeenAt_idx" ON "ReviewerPatternAlert"("tenantId", "status", "lastSeenAt");
