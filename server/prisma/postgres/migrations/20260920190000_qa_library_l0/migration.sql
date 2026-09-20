-- CreateTable
CREATE TABLE "LibraryEntry" (
    "id" TEXT NOT NULL,
    "scope" TEXT NOT NULL DEFAULT 'global',
    "tenantId" TEXT,
    "roleSlug" TEXT NOT NULL,
    "familySlug" TEXT NOT NULL,
    "competencyKey" TEXT NOT NULL,
    "competencyVersion" TEXT,
    "band" TEXT NOT NULL,
    "form" TEXT NOT NULL,
    "questionText" TEXT NOT NULL,
    "bodyJson" TEXT NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT 'draft',
    "gateOutcome" TEXT NOT NULL DEFAULT '',
    "gateReason" TEXT NOT NULL DEFAULT '',
    "stratumKey" TEXT NOT NULL DEFAULT '',
    "sampledOn" TEXT NOT NULL DEFAULT '',
    "difficultyTag" INTEGER NOT NULL DEFAULT 2,
    "difficultyEmpirical" DOUBLE PRECISION,
    "supersedesId" TEXT,
    "standardId" TEXT,
    "generatorPromptVersion" TEXT NOT NULL,
    "generatorModel" TEXT NOT NULL DEFAULT '',
    "criticModel" TEXT NOT NULL DEFAULT '',
    "criticVerdictJson" TEXT NOT NULL DEFAULT '{}',
    "policyVersion" INTEGER NOT NULL DEFAULT 1,
    "rubricVersion" TEXT NOT NULL DEFAULT '',
    "createdBy" TEXT NOT NULL DEFAULT 'worker',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LibraryEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LibraryStandard" (
    "id" TEXT NOT NULL,
    "familySlug" TEXT NOT NULL,
    "competencyKey" TEXT NOT NULL,
    "band" TEXT NOT NULL,
    "anchorsJson" TEXT NOT NULL DEFAULT '[]',
    "exemplarsJson" TEXT NOT NULL DEFAULT '',
    "version" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'live',
    "generatorPromptVersion" TEXT NOT NULL DEFAULT '',
    "generatorModel" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LibraryStandard_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LibraryUsage" (
    "id" TEXT NOT NULL,
    "entryId" TEXT NOT NULL,
    "interviewSessionId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "roleId" TEXT NOT NULL DEFAULT '',
    "roleSlug" TEXT NOT NULL DEFAULT '',
    "askedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "outcome" TEXT NOT NULL DEFAULT 'answered',
    "evidenceYield" DOUBLE PRECISION,
    "probeCount" INTEGER NOT NULL DEFAULT 0,
    "reviewerDelta" DOUBLE PRECISION,
    "blockSource" TEXT NOT NULL DEFAULT 'library',

    CONSTRAINT "LibraryUsage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LibraryPoolTarget" (
    "id" TEXT NOT NULL,
    "scope" TEXT NOT NULL DEFAULT 'global',
    "tenantId" TEXT NOT NULL DEFAULT '',
    "roleSlug" TEXT NOT NULL,
    "competencyKey" TEXT NOT NULL,
    "band" TEXT NOT NULL,
    "depthTarget" INTEGER NOT NULL,
    "formMixJson" TEXT NOT NULL DEFAULT '{}',
    "computedFrom" TEXT NOT NULL DEFAULT '{}',
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LibraryPoolTarget_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LibraryReview" (
    "id" TEXT NOT NULL,
    "entryId" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "actorId" TEXT NOT NULL DEFAULT '',
    "action" TEXT NOT NULL,
    "fromStatus" TEXT NOT NULL DEFAULT '',
    "toStatus" TEXT NOT NULL DEFAULT '',
    "reason" TEXT NOT NULL DEFAULT '',
    "sampleStratum" TEXT NOT NULL DEFAULT '',
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LibraryReview_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LibraryPolicy" (
    "id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "promotionUses" INTEGER NOT NULL DEFAULT 5,
    "sampleSize" INTEGER NOT NULL DEFAULT 20,
    "stratumCleanApprovals" INTEGER NOT NULL DEFAULT 20,
    "tightenWindow" INTEGER NOT NULL DEFAULT 200,
    "criticPassMin" DOUBLE PRECISION NOT NULL DEFAULT 0.8,
    "criticGreyMin" DOUBLE PRECISION NOT NULL DEFAULT 0.55,
    "nearDuplicate" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "duplicate" DOUBLE PRECISION NOT NULL DEFAULT 0.8,
    "noRepeatWindowDays" INTEGER NOT NULL DEFAULT 30,
    "overridesJson" TEXT NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LibraryPolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LibraryBudget" (
    "day" TEXT NOT NULL,
    "callsUsed" INTEGER NOT NULL DEFAULT 0,
    "callsCap" INTEGER NOT NULL,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LibraryBudget_pkey" PRIMARY KEY ("day")
);

-- CreateTable
CREATE TABLE "LibraryStratum" (
    "key" TEXT NOT NULL,
    "cleanApprovals" INTEGER NOT NULL DEFAULT 0,
    "approvals" INTEGER NOT NULL DEFAULT 0,
    "rejections" INTEGER NOT NULL DEFAULT 0,
    "tightenedRemaining" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LibraryStratum_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "LibraryWorkerState" (
    "id" TEXT NOT NULL DEFAULT 'worker',
    "state" TEXT NOT NULL DEFAULT 'stopped',
    "reason" TEXT NOT NULL DEFAULT '',
    "holder" TEXT NOT NULL DEFAULT '',
    "since" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastBatchAt" TIMESTAMP(3),
    "lastError" TEXT NOT NULL DEFAULT '',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LibraryWorkerState_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LibraryEntry_roleSlug_competencyKey_band_status_idx" ON "LibraryEntry"("roleSlug", "competencyKey", "band", "status");

-- CreateIndex
CREATE INDEX "LibraryEntry_tenantId_status_idx" ON "LibraryEntry"("tenantId", "status");

-- CreateIndex
CREATE INDEX "LibraryEntry_status_gateOutcome_createdAt_idx" ON "LibraryEntry"("status", "gateOutcome", "createdAt");

-- CreateIndex
CREATE INDEX "LibraryEntry_stratumKey_createdAt_idx" ON "LibraryEntry"("stratumKey", "createdAt");

-- CreateIndex
CREATE INDEX "LibraryStandard_familySlug_competencyKey_band_status_idx" ON "LibraryStandard"("familySlug", "competencyKey", "band", "status");

-- CreateIndex
CREATE INDEX "LibraryUsage_entryId_askedAt_idx" ON "LibraryUsage"("entryId", "askedAt");

-- CreateIndex
CREATE INDEX "LibraryUsage_tenantId_roleSlug_askedAt_idx" ON "LibraryUsage"("tenantId", "roleSlug", "askedAt");

-- CreateIndex
CREATE INDEX "LibraryUsage_interviewSessionId_idx" ON "LibraryUsage"("interviewSessionId");

-- CreateIndex
CREATE UNIQUE INDEX "LibraryPoolTarget_scope_tenantId_roleSlug_competencyKey_ban_key" ON "LibraryPoolTarget"("scope", "tenantId", "roleSlug", "competencyKey", "band");

-- CreateIndex
CREATE INDEX "LibraryReview_entryId_at_idx" ON "LibraryReview"("entryId", "at");

-- CreateIndex
CREATE INDEX "LibraryReview_action_at_idx" ON "LibraryReview"("action", "at");

-- CreateIndex
CREATE UNIQUE INDEX "LibraryPolicy_version_key" ON "LibraryPolicy"("version");

-- AddForeignKey
ALTER TABLE "LibraryEntry" ADD CONSTRAINT "LibraryEntry_standardId_fkey" FOREIGN KEY ("standardId") REFERENCES "LibraryStandard"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LibraryUsage" ADD CONSTRAINT "LibraryUsage_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "LibraryEntry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LibraryReview" ADD CONSTRAINT "LibraryReview_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "LibraryEntry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

