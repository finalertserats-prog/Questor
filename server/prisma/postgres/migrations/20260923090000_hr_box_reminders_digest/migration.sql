-- AlterTable
ALTER TABLE "User" ADD COLUMN     "digestOptOut" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "InvitationReminder" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "invitationId" TEXT NOT NULL,
    "cycleExpiresAt" TIMESTAMP(3) NOT NULL,
    "kind" TEXT NOT NULL,
    "recipientKey" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'claimed',
    "note" TEXT NOT NULL DEFAULT '',
    "claimedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMP(3),

    CONSTRAINT "InvitationReminder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DigestDelivery" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'claimed',
    "rowCount" INTEGER NOT NULL DEFAULT 0,
    "claimedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMP(3),

    CONSTRAINT "DigestDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "InvitationReminder_tenantId_claimedAt_idx" ON "InvitationReminder"("tenantId", "claimedAt");

-- CreateIndex
CREATE INDEX "InvitationReminder_sessionId_idx" ON "InvitationReminder"("sessionId");

-- CreateIndex
CREATE UNIQUE INDEX "InvitationReminder_invitationId_cycleExpiresAt_kind_recipie_key" ON "InvitationReminder"("invitationId", "cycleExpiresAt", "kind", "recipientKey");

-- CreateIndex
CREATE INDEX "DigestDelivery_tenantId_claimedAt_idx" ON "DigestDelivery"("tenantId", "claimedAt");

-- CreateIndex
CREATE UNIQUE INDEX "DigestDelivery_userId_day_key" ON "DigestDelivery"("userId", "day");

-- AddForeignKey
ALTER TABLE "InvitationReminder" ADD CONSTRAINT "InvitationReminder_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "InterviewSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DigestDelivery" ADD CONSTRAINT "DigestDelivery_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

