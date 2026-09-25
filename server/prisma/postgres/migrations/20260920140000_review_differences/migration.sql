-- AlterTable
ALTER TABLE "HumanReview" ADD COLUMN     "supersededAt" TIMESTAMP(3),
ADD COLUMN     "supersededReason" TEXT NOT NULL DEFAULT '';

-- CreateTable
CREATE TABLE "ReviewDifference" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "assessmentId" TEXT NOT NULL,
    "reviewId" TEXT NOT NULL,
    "reviewerId" TEXT NOT NULL,
    "aiRecommendation" TEXT NOT NULL,
    "humanDisposition" TEXT NOT NULL,
    "agreed" BOOLEAN NOT NULL,
    "changedCount" INTEGER NOT NULL,
    "competencyCount" INTEGER NOT NULL,
    "competenciesJson" TEXT NOT NULL DEFAULT '[]',
    "reason" TEXT NOT NULL DEFAULT '',
    "summary" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReviewDifference_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ReviewDifference_reviewId_key" ON "ReviewDifference"("reviewId");

-- CreateIndex
CREATE INDEX "ReviewDifference_tenantId_createdAt_idx" ON "ReviewDifference"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "ReviewDifference_assessmentId_idx" ON "ReviewDifference"("assessmentId");

-- AddForeignKey
ALTER TABLE "ReviewDifference" ADD CONSTRAINT "ReviewDifference_assessmentId_fkey" FOREIGN KEY ("assessmentId") REFERENCES "AssessmentVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReviewDifference" ADD CONSTRAINT "ReviewDifference_reviewId_fkey" FOREIGN KEY ("reviewId") REFERENCES "HumanReview"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

