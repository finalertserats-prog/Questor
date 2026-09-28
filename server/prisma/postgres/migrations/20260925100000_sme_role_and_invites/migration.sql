-- The subject-matter expert's recommendation, and the emailed colleague invite.
--
-- SmeReview is deliberately its own table rather than a flavour of HumanReview:
-- a HumanReview's disposition is acted on by the pipeline, and an SME advises
-- rather than decides. Two tables is what makes that a fact about the schema.
--
-- UserInvite stores only an HMAC of each link token, under the server pepper,
-- exactly as PasswordResetToken does, so a copy of this table cannot be turned
-- back into working invitations.

-- CreateTable
CREATE TABLE "SmeReview" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "candidateId" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,
    "sessionId" TEXT,
    "smeUserId" TEXT NOT NULL,
    "recommendation" TEXT NOT NULL,
    "feedback" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SmeReview_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserInvite" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "invitedByUserId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "acceptedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserInvite_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SmeReview_tenantId_candidateId_idx" ON "SmeReview"("tenantId", "candidateId");

-- CreateIndex
-- One review per expert, candidate and role. The review is edited in place, so
-- a second submit must lose at the database rather than at a read both attempts
-- had already passed.
CREATE UNIQUE INDEX "SmeReview_candidateId_roleId_smeUserId_key" ON "SmeReview"("candidateId", "roleId", "smeUserId");

-- CreateIndex
CREATE UNIQUE INDEX "UserInvite_tokenHash_key" ON "UserInvite"("tokenHash");

-- CreateIndex
CREATE INDEX "UserInvite_tenantId_email_idx" ON "UserInvite"("tenantId", "email");
