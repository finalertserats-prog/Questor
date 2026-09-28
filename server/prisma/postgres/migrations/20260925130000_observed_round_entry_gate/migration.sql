-- Consent becomes a gate on entering an observed round rather than a control
-- inside it, and the room may hold more than one member of staff.

-- AlterTable
ALTER TABLE "RoundObservation" ALTER COLUMN "status" SET DEFAULT 'AWAITING_CONSENT';
ALTER TABLE "RoundObservation" ALTER COLUMN "interviewerId" SET DEFAULT '';

-- The state is the same state; only its name was too narrow, because it now
-- waits on everyone who would be in the room rather than on the candidate
-- alone. Renamed rather than left alongside a new value: two spellings of one
-- state is how a gate ends up checking for one of them.
UPDATE "RoundObservation" SET "status" = 'AWAITING_CONSENT' WHERE "status" = 'AWAITING_CANDIDATE';

-- Proof that capture is actually running, as opposed to permitted. Null on
-- every existing row: nothing has proved anything yet, and a back-filled
-- timestamp would be a claim that a round was being heard when nobody knows.
ALTER TABLE "RoundObservation" ADD COLUMN     "lastHeardAt" TIMESTAMP(3);

-- Whether only one voice was heard. False on existing rows rather than
-- recomputed over their segments: the measure is a judgement about a round in
-- progress, and applying today's threshold to last month's transcripts would
-- relabel rounds nobody can go back and check.
ALTER TABLE "RoundObservation" ADD COLUMN     "oneSided" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "ObservationSegment" ADD COLUMN     "participantId" TEXT;

-- CreateTable
CREATE TABLE "ObservationParticipant" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "observationId" TEXT NOT NULL,
    "party" TEXT NOT NULL,
    "personId" TEXT NOT NULL,
    "noticeVersion" TEXT NOT NULL,
    "consentAt" TIMESTAMP(3),
    "declinedAt" TIMESTAMP(3),
    "admittedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ObservationParticipant_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ObservationParticipant_tenantId_idx" ON "ObservationParticipant"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "ObservationParticipant_observationId_personId_key" ON "ObservationParticipant"("observationId", "personId");

-- CreateIndex
CREATE INDEX "ObservationSegment_participantId_idx" ON "ObservationSegment"("participantId");

-- AddForeignKey
ALTER TABLE "ObservationParticipant" ADD CONSTRAINT "ObservationParticipant_observationId_fkey" FOREIGN KEY ("observationId") REFERENCES "RoundObservation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ObservationSegment" ADD CONSTRAINT "ObservationSegment_participantId_fkey" FOREIGN KEY ("participantId") REFERENCES "ObservationParticipant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Back-fill a participant row for everyone an existing observation already
-- recorded a consent for.
--
-- Existing ObservationSegment rows are left alone, and that is safe rather than
-- an oversight: the old code only reached LISTENING with BOTH consent columns
-- set, so any observation that holds captured speech back-fills to two
-- consented rows. A row that back-fills with a null consentAt therefore has no
-- segments under it. Without this an observation mid-flight when the
-- deploy landed would read as "nobody has agreed" and its round would be
-- blocked, which is the wrong answer about a round whose people did agree.
INSERT INTO "ObservationParticipant" ("id", "tenantId", "observationId", "party", "personId", "noticeVersion", "consentAt", "declinedAt", "createdAt", "updatedAt")
SELECT
    "id" || '-interviewer', "tenantId", "id", 'interviewer', "interviewerId", "noticeVersion",
    "interviewerConsentAt",
    CASE WHEN "declinedBy" = 'interviewer' THEN "declinedAt" END,
    "createdAt", CURRENT_TIMESTAMP
FROM "RoundObservation"
WHERE "interviewerId" <> '';

INSERT INTO "ObservationParticipant" ("id", "tenantId", "observationId", "party", "personId", "noticeVersion", "consentAt", "declinedAt", "createdAt", "updatedAt")
SELECT
    "id" || '-candidate', "tenantId", "id", 'candidate', "candidateId", "noticeVersion",
    "candidateConsentAt",
    CASE WHEN "declinedBy" = 'candidate' THEN "declinedAt" END,
    "createdAt", CURRENT_TIMESTAMP
FROM "RoundObservation";

-- The two consent columns go with them. Consent is now a fact about a PERSON,
-- and a person-shaped fact kept in a pair of columns is what made the room
-- unable to hold three people in the first place. Leaving them behind, written
-- by nothing and read by nothing, would be a second place to look for an
-- answer that only one place has.
ALTER TABLE "RoundObservation" DROP COLUMN "interviewerConsentAt";
ALTER TABLE "RoundObservation" DROP COLUMN "candidateConsentAt";
