-- CreateTable
CREATE TABLE "AIInterviewer" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "voiceProfileId" TEXT NOT NULL,
    "avatarUrl" TEXT NOT NULL DEFAULT '',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AIInterviewer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VoiceProfile" (
    "id" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerVoiceId" TEXT NOT NULL DEFAULT '',
    "language" TEXT NOT NULL DEFAULT 'English',
    "locale" TEXT NOT NULL DEFAULT 'en-US',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "fallbackHint" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VoiceProfile_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AIInterviewer_voiceProfileId_key" ON "AIInterviewer"("voiceProfileId");

-- AddForeignKey
ALTER TABLE "AIInterviewer" ADD CONSTRAINT "AIInterviewer_voiceProfileId_fkey" FOREIGN KEY ("voiceProfileId") REFERENCES "VoiceProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
