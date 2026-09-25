-- A timezone on the people, and a snapshot of the candidate's on each booking.
--
-- Every column is nullable or defaulted: existing rows stay valid, and a null
-- means "nobody has said", which the readers are written to report rather than
-- paper over.

-- AlterTable
ALTER TABLE "Candidate" ADD COLUMN     "timeZone" TEXT;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "timeZone" TEXT;

-- AlterTable
ALTER TABLE "InterviewSession" ADD COLUMN     "candidateTimeZone" TEXT,
ADD COLUMN     "calendarSequence" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "InterviewRound" ADD COLUMN     "candidateTimeZone" TEXT,
ADD COLUMN     "calendarSequence" INTEGER NOT NULL DEFAULT 0;
