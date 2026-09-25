-- One recipient's copy of one interview's calendar entry, and whether it is
-- up to date. The sequence number lives inside the .ics, so it is spent before
-- the send; a failed send therefore leaves a calendar describing an older time
-- and, until this table, nothing recorded that.

-- CreateTable
CREATE TABLE "CalendarDelivery" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "recipientEmail" TEXT NOT NULL,
    "recipientName" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3),
    "claimedAt" TIMESTAMP(3),
    "lastError" TEXT NOT NULL DEFAULT '',
    "sequenceSent" INTEGER,
    "scheduledAtSent" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CalendarDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CalendarDelivery_targetType_targetId_recipientEmail_key" ON "CalendarDelivery"("targetType", "targetId", "recipientEmail");

-- CreateIndex
CREATE INDEX "CalendarDelivery_status_nextAttemptAt_idx" ON "CalendarDelivery"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "CalendarDelivery_tenantId_status_idx" ON "CalendarDelivery"("tenantId", "status");
