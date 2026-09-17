-- CreateTable
CREATE TABLE "Tenant" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT,
    "region" TEXT NOT NULL DEFAULT 'in',
    "policyJson" TEXT NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Tenant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'recruiter',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "tourCompletedAt" TIMESTAMP(3),

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Role" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "level" TEXT NOT NULL DEFAULT '',
    "location" TEXT NOT NULL DEFAULT '',
    "employmentType" TEXT NOT NULL DEFAULT '',
    "sourceType" TEXT NOT NULL DEFAULT 'paste',
    "sourceText" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'draft',
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "pipelineStagesJson" TEXT NOT NULL DEFAULT '',

    CONSTRAINT "Role_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RoleScorecardVersion" (
    "id" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "profileJson" TEXT NOT NULL DEFAULT '{}',
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RoleScorecardVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Candidate" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "roleId" TEXT,
    "fullName" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Candidate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CandidateProfileVersion" (
    "id" TEXT NOT NULL,
    "candidateId" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "rawText" TEXT NOT NULL DEFAULT '',
    "profileJson" TEXT NOT NULL DEFAULT '{}',
    "fitScoreJson" TEXT NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CandidateProfileVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EvidenceNode" (
    "id" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "dataJson" TEXT NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EvidenceNode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EvidenceEdge" (
    "id" TEXT NOT NULL,
    "fromId" TEXT NOT NULL,
    "toId" TEXT NOT NULL,
    "relation" TEXT NOT NULL,
    "weight" DOUBLE PRECISION NOT NULL DEFAULT 1,

    CONSTRAINT "EvidenceEdge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InterviewPlanVersion" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "planJson" TEXT NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InterviewPlanVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InterviewSession" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "candidateId" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,
    "scorecardId" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'PROVISIONED',
    "provider" TEXT NOT NULL DEFAULT 'hosted',
    "language" TEXT NOT NULL DEFAULT 'en',
    "durationMinutes" INTEGER NOT NULL DEFAULT 45,
    "personaJson" TEXT NOT NULL DEFAULT '{}',
    "consentJson" TEXT NOT NULL DEFAULT '{}',
    "qualityJson" TEXT NOT NULL DEFAULT '{}',
    "contextJson" TEXT NOT NULL DEFAULT '{}',
    "recordingConsent" BOOLEAN NOT NULL DEFAULT false,
    "retainUntil" TIMESTAMP(3),
    "legalHold" BOOLEAN NOT NULL DEFAULT false,
    "scheduledAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "interruptedAt" TIMESTAMP(3),
    "attemptNumber" INTEGER NOT NULL DEFAULT 1,
    "retakeOfSessionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InterviewSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IntegrityEvent" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "detail" TEXT NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IntegrityEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Invitation" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "token" TEXT,
    "tokenHash" TEXT,
    "tokenSealed" TEXT NOT NULL DEFAULT '',
    "channel" TEXT NOT NULL DEFAULT 'email',
    "status" TEXT NOT NULL DEFAULT 'created',
    "sentAt" TIMESTAMP(3),
    "openedAt" TIMESTAMP(3),
    "acceptedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "eventsJson" TEXT NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Invitation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Turn" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "index" INTEGER NOT NULL,
    "speaker" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "startMs" INTEGER NOT NULL DEFAULT 0,
    "endMs" INTEGER NOT NULL DEFAULT 0,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "competencyId" TEXT NOT NULL DEFAULT '',
    "metaJson" TEXT NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Turn_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AssessmentVersion" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "scorecardId" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "recommendation" TEXT NOT NULL DEFAULT 'CONSIDER',
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "evidenceCoverage" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "resultJson" TEXT NOT NULL DEFAULT '{}',
    "modelExecId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AssessmentVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HumanReview" (
    "id" TEXT NOT NULL,
    "assessmentId" TEXT NOT NULL,
    "reviewerId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "disposition" TEXT NOT NULL DEFAULT '',
    "overridesJson" TEXT NOT NULL DEFAULT '[]',
    "comments" TEXT NOT NULL DEFAULT '',
    "reason" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "HumanReview_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CandidateFeedbackDelivery" (
    "id" TEXT NOT NULL,
    "assessmentId" TEXT NOT NULL,
    "draftText" TEXT NOT NULL,
    "approvedText" TEXT,
    "approvedByUserId" TEXT,
    "approvedAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "candidateRequested" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CandidateFeedbackDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CandidateFeedbackOptIn" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "candidateId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "choice" TEXT NOT NULL,
    "decidedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedBy" TEXT NOT NULL DEFAULT 'candidate',
    "draftStatus" TEXT NOT NULL DEFAULT 'PENDING',
    "draftNote" TEXT NOT NULL DEFAULT '',
    "draftPreparedAt" TIMESTAMP(3),

    CONSTRAINT "CandidateFeedbackOptIn_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CandidateHumanRequest" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "candidateId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ISSUED',
    "requestedAt" TIMESTAMP(3),

    CONSTRAINT "CandidateHumanRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Artifact" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "candidateId" TEXT,
    "sessionId" TEXT,
    "kind" TEXT NOT NULL,
    "filename" TEXT NOT NULL DEFAULT '',
    "contentType" TEXT NOT NULL DEFAULT '',
    "storageKey" TEXT NOT NULL DEFAULT '',
    "sizeBytes" INTEGER NOT NULL DEFAULT 0,
    "retentionDays" INTEGER NOT NULL DEFAULT 180,
    "legalHold" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Artifact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SignupRequest" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "organisationName" TEXT,
    "orgSlug" TEXT,
    "passwordHash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "decisionTokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "decidedAt" TIMESTAMP(3),
    "decidedBy" TEXT,
    "createdTenantId" TEXT,
    "createdUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SignupRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditEvent" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "actorId" TEXT NOT NULL DEFAULT 'system',
    "actorType" TEXT NOT NULL DEFAULT 'user',
    "action" TEXT NOT NULL,
    "entityType" TEXT NOT NULL DEFAULT '',
    "entityId" TEXT NOT NULL DEFAULT '',
    "beforeJson" TEXT NOT NULL DEFAULT '',
    "afterJson" TEXT NOT NULL DEFAULT '',
    "requestId" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ModelExecution" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL DEFAULT '',
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "function" TEXT NOT NULL,
    "promptRef" TEXT NOT NULL DEFAULT '',
    "paramsJson" TEXT NOT NULL DEFAULT '{}',
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "latencyMs" INTEGER NOT NULL DEFAULT 0,
    "safetyJson" TEXT NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ModelExecution_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookEndpoint" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "events" TEXT NOT NULL DEFAULT '*',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebhookEndpoint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookDelivery" (
    "id" TEXT NOT NULL,
    "endpointId" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "payloadJson" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT NOT NULL DEFAULT '',
    "nextAttemptAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebhookDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JobLease" (
    "name" TEXT NOT NULL,
    "holder" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "JobLease_pkey" PRIMARY KEY ("name")
);

-- CreateTable
CREATE TABLE "JobRun" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "holder" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "ok" BOOLEAN,
    "note" TEXT NOT NULL DEFAULT '',

    CONSTRAINT "JobRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RoleAssignment" (
    "id" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "relation" TEXT NOT NULL DEFAULT 'collaborator',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RoleAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CandidateAssignment" (
    "id" TEXT NOT NULL,
    "candidateId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "relation" TEXT NOT NULL DEFAULT 'owner',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CandidateAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CandidatePipeline" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "candidateId" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,
    "stagesJson" TEXT NOT NULL,
    "currentStageKey" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "decision" TEXT,
    "decisionReason" TEXT,
    "decidedAtStageKey" TEXT,
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CandidatePipeline_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InterviewRound" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "pipelineId" TEXT NOT NULL,
    "stageKey" TEXT NOT NULL,
    "conductedBy" TEXT NOT NULL,
    "aiObserver" BOOLEAN NOT NULL DEFAULT false,
    "hrMayObserve" BOOLEAN NOT NULL DEFAULT false,
    "sessionId" TEXT,
    "interviewersJson" TEXT NOT NULL DEFAULT '[]',
    "scheduledAt" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'SCHEDULED',
    "notes" TEXT NOT NULL DEFAULT '',
    "completedAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InterviewRound_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Tenant_slug_key" ON "Tenant"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "Role_tenantId_createdAt_idx" ON "Role"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "Candidate_tenantId_createdAt_idx" ON "Candidate"("tenantId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "InterviewPlanVersion_sessionId_key" ON "InterviewPlanVersion"("sessionId");

-- CreateIndex
CREATE INDEX "InterviewSession_tenantId_createdAt_idx" ON "InterviewSession"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "InterviewSession_tenantId_scheduledAt_idx" ON "InterviewSession"("tenantId", "scheduledAt");

-- CreateIndex
CREATE INDEX "InterviewSession_tenantId_completedAt_idx" ON "InterviewSession"("tenantId", "completedAt");

-- CreateIndex
CREATE INDEX "InterviewSession_tenantId_state_idx" ON "InterviewSession"("tenantId", "state");

-- CreateIndex
CREATE INDEX "IntegrityEvent_sessionId_idx" ON "IntegrityEvent"("sessionId");

-- CreateIndex
CREATE INDEX "IntegrityEvent_type_idx" ON "IntegrityEvent"("type");

-- CreateIndex
CREATE UNIQUE INDEX "Invitation_sessionId_key" ON "Invitation"("sessionId");

-- CreateIndex
CREATE UNIQUE INDEX "Invitation_token_key" ON "Invitation"("token");

-- CreateIndex
CREATE UNIQUE INDEX "Invitation_tokenHash_key" ON "Invitation"("tokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "Turn_sessionId_index_key" ON "Turn"("sessionId", "index");

-- CreateIndex
CREATE UNIQUE INDEX "CandidateFeedbackDelivery_assessmentId_key" ON "CandidateFeedbackDelivery"("assessmentId");

-- CreateIndex
CREATE UNIQUE INDEX "CandidateFeedbackOptIn_sessionId_key" ON "CandidateFeedbackOptIn"("sessionId");

-- CreateIndex
CREATE INDEX "CandidateFeedbackOptIn_tenantId_choice_idx" ON "CandidateFeedbackOptIn"("tenantId", "choice");

-- CreateIndex
CREATE INDEX "CandidateFeedbackOptIn_candidateId_idx" ON "CandidateFeedbackOptIn"("candidateId");

-- CreateIndex
CREATE UNIQUE INDEX "CandidateHumanRequest_sessionId_key" ON "CandidateHumanRequest"("sessionId");

-- CreateIndex
CREATE UNIQUE INDEX "CandidateHumanRequest_tokenHash_key" ON "CandidateHumanRequest"("tokenHash");

-- CreateIndex
CREATE INDEX "CandidateHumanRequest_tenantId_status_idx" ON "CandidateHumanRequest"("tenantId", "status");

-- CreateIndex
CREATE INDEX "CandidateHumanRequest_candidateId_idx" ON "CandidateHumanRequest"("candidateId");

-- CreateIndex
CREATE UNIQUE INDEX "SignupRequest_decisionTokenHash_key" ON "SignupRequest"("decisionTokenHash");

-- CreateIndex
CREATE INDEX "SignupRequest_email_idx" ON "SignupRequest"("email");

-- CreateIndex
CREATE INDEX "SignupRequest_status_createdAt_idx" ON "SignupRequest"("status", "createdAt");

-- CreateIndex
CREATE INDEX "AuditEvent_tenantId_createdAt_idx" ON "AuditEvent"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditEvent_tenantId_action_idx" ON "AuditEvent"("tenantId", "action");

-- CreateIndex
CREATE INDEX "WebhookDelivery_status_nextAttemptAt_idx" ON "WebhookDelivery"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "JobRun_name_startedAt_idx" ON "JobRun"("name", "startedAt");

-- CreateIndex
CREATE INDEX "RoleAssignment_userId_idx" ON "RoleAssignment"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "RoleAssignment_roleId_userId_key" ON "RoleAssignment"("roleId", "userId");

-- CreateIndex
CREATE INDEX "CandidateAssignment_userId_idx" ON "CandidateAssignment"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "CandidateAssignment_candidateId_userId_key" ON "CandidateAssignment"("candidateId", "userId");

-- CreateIndex
CREATE INDEX "CandidatePipeline_tenantId_idx" ON "CandidatePipeline"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "CandidatePipeline_candidateId_roleId_key" ON "CandidatePipeline"("candidateId", "roleId");

-- CreateIndex
CREATE INDEX "InterviewRound_pipelineId_idx" ON "InterviewRound"("pipelineId");

-- CreateIndex
CREATE INDEX "InterviewRound_tenantId_idx" ON "InterviewRound"("tenantId");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Role" ADD CONSTRAINT "Role_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoleScorecardVersion" ADD CONSTRAINT "RoleScorecardVersion_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "Role"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Candidate" ADD CONSTRAINT "Candidate_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Candidate" ADD CONSTRAINT "Candidate_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "Role"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CandidateProfileVersion" ADD CONSTRAINT "CandidateProfileVersion_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "Candidate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EvidenceNode" ADD CONSTRAINT "EvidenceNode_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "CandidateProfileVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EvidenceEdge" ADD CONSTRAINT "EvidenceEdge_fromId_fkey" FOREIGN KEY ("fromId") REFERENCES "EvidenceNode"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EvidenceEdge" ADD CONSTRAINT "EvidenceEdge_toId_fkey" FOREIGN KEY ("toId") REFERENCES "EvidenceNode"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InterviewPlanVersion" ADD CONSTRAINT "InterviewPlanVersion_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "InterviewSession"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InterviewSession" ADD CONSTRAINT "InterviewSession_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InterviewSession" ADD CONSTRAINT "InterviewSession_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "Candidate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InterviewSession" ADD CONSTRAINT "InterviewSession_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "Role"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InterviewSession" ADD CONSTRAINT "InterviewSession_scorecardId_fkey" FOREIGN KEY ("scorecardId") REFERENCES "RoleScorecardVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InterviewSession" ADD CONSTRAINT "InterviewSession_retakeOfSessionId_fkey" FOREIGN KEY ("retakeOfSessionId") REFERENCES "InterviewSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IntegrityEvent" ADD CONSTRAINT "IntegrityEvent_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "InterviewSession"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invitation" ADD CONSTRAINT "Invitation_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "InterviewSession"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Turn" ADD CONSTRAINT "Turn_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "InterviewSession"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssessmentVersion" ADD CONSTRAINT "AssessmentVersion_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "InterviewSession"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssessmentVersion" ADD CONSTRAINT "AssessmentVersion_scorecardId_fkey" FOREIGN KEY ("scorecardId") REFERENCES "RoleScorecardVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HumanReview" ADD CONSTRAINT "HumanReview_assessmentId_fkey" FOREIGN KEY ("assessmentId") REFERENCES "AssessmentVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HumanReview" ADD CONSTRAINT "HumanReview_reviewerId_fkey" FOREIGN KEY ("reviewerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CandidateFeedbackDelivery" ADD CONSTRAINT "CandidateFeedbackDelivery_assessmentId_fkey" FOREIGN KEY ("assessmentId") REFERENCES "AssessmentVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CandidateFeedbackDelivery" ADD CONSTRAINT "CandidateFeedbackDelivery_approvedByUserId_fkey" FOREIGN KEY ("approvedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CandidateFeedbackOptIn" ADD CONSTRAINT "CandidateFeedbackOptIn_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "InterviewSession"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CandidateFeedbackOptIn" ADD CONSTRAINT "CandidateFeedbackOptIn_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "Candidate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CandidateHumanRequest" ADD CONSTRAINT "CandidateHumanRequest_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "InterviewSession"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CandidateHumanRequest" ADD CONSTRAINT "CandidateHumanRequest_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "Candidate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Artifact" ADD CONSTRAINT "Artifact_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "Candidate"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Artifact" ADD CONSTRAINT "Artifact_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "InterviewSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebhookEndpoint" ADD CONSTRAINT "WebhookEndpoint_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebhookDelivery" ADD CONSTRAINT "WebhookDelivery_endpointId_fkey" FOREIGN KEY ("endpointId") REFERENCES "WebhookEndpoint"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoleAssignment" ADD CONSTRAINT "RoleAssignment_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "Role"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoleAssignment" ADD CONSTRAINT "RoleAssignment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CandidateAssignment" ADD CONSTRAINT "CandidateAssignment_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "Candidate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CandidateAssignment" ADD CONSTRAINT "CandidateAssignment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CandidatePipeline" ADD CONSTRAINT "CandidatePipeline_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "Candidate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CandidatePipeline" ADD CONSTRAINT "CandidatePipeline_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "Role"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InterviewRound" ADD CONSTRAINT "InterviewRound_pipelineId_fkey" FOREIGN KEY ("pipelineId") REFERENCES "CandidatePipeline"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

