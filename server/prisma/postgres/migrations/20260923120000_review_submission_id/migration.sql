-- One review per submit, however many times the submit arrives.
--
-- A reviewer double-clicking, or a client retrying a request whose response was
-- lost, used to record the judgement twice: both attempts read "not reviewed
-- yet" and both inserted. The page now sends an id per submit, and this unique
-- index is what makes the second attempt fail at the database rather than at a
-- check both attempts had already passed.
--
-- Nullable, so every review recorded before the page sent one — and every blind
-- verdict, which has no submit of its own — stays exactly as it is.

-- AlterTable
ALTER TABLE "HumanReview" ADD COLUMN     "submissionId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "HumanReview_submissionId_key" ON "HumanReview"("submissionId");

-- One completed review per assessment, enforced where it can actually hold.
--
-- "This assessment has already been reviewed" was a SELECT followed by an
-- INSERT. Two submits arriving together both read "not reviewed yet" and both
-- wrote, so one assessment carried two final verdicts and the candidate's
-- letter was written from whichever row sorted first. The column records which
-- review is currently THE completed one, and the unique index is what decides
-- a race — at the database, not at a check both attempts had passed.

-- AlterTable
ALTER TABLE "HumanReview" ADD COLUMN     "activeForAssessmentId" TEXT;

-- Backfill, non-destructively: only assessments whose active completed review
-- is unambiguous today. Anything already doubled up is left exactly as it is
-- for a person to look at — the index must not decide history retroactively.
UPDATE "HumanReview" h
SET "activeForAssessmentId" = h."assessmentId"
WHERE h."status" = 'COMPLETED'
  AND h."supersededAt" IS NULL
  AND (
    SELECT COUNT(*) FROM "HumanReview" o
    WHERE o."assessmentId" = h."assessmentId" AND o."status" = 'COMPLETED' AND o."supersededAt" IS NULL
  ) = 1;

-- CreateIndex
CREATE UNIQUE INDEX "HumanReview_activeForAssessmentId_key" ON "HumanReview"("activeForAssessmentId");
