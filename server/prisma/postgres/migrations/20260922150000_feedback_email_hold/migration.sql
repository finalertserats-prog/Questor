-- AlterTable
ALTER TABLE "CandidateFeedbackEmail" ADD COLUMN     "heldAt" TIMESTAMP(3),
ADD COLUMN     "holdJson" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "holdKeptAt" TIMESTAMP(3),
ADD COLUMN     "holdKeptByUserId" TEXT;
