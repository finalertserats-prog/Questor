-- Identity assurance L1: one-time codes sent to the candidate before the
-- interview. Only an HMAC of each code is stored.

-- CreateTable
CREATE TABLE "IdentityCodeChallenge" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "channel" TEXT NOT NULL DEFAULT 'email',
    "codeHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lockedAt" TIMESTAMP(3),
    "supersededAt" TIMESTAMP(3),
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IdentityCodeChallenge_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "IdentityCodeChallenge_sessionId_createdAt_idx" ON "IdentityCodeChallenge"("sessionId", "createdAt");

-- AddForeignKey
ALTER TABLE "IdentityCodeChallenge" ADD CONSTRAINT "IdentityCodeChallenge_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "InterviewSession"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
