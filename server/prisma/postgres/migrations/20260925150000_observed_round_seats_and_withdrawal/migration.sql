-- A withdrawal now carries the reason the person gave, and `party` can no
-- longer hold a value the consent rules do not understand.

-- AlterTable
ALTER TABLE "RoundObservation" ADD COLUMN     "withdrawnReason" TEXT NOT NULL DEFAULT '';

-- The one thing in this lane that must not be able to go wrong quietly.
--
-- `party` decides whether somebody is required, optional, or invisible to the
-- consent rules. A value outside these three does not throw anywhere: it casts
-- cleanly to the TypeScript union, matches none of the branches, and the person
-- silently drops out of the required set — which is capture without consent,
-- arriving as a typo rather than as a bug anybody would see. The database
-- refuses it instead.
--
-- A CHECK rather than a Prisma enum: the column already holds data, and an enum
-- would make every future party a migration of the type as well as of the
-- rules. Widening a CHECK is one line.
ALTER TABLE "ObservationParticipant"
  ADD CONSTRAINT "ObservationParticipant_party_check"
  CHECK ("party" IN ('candidate', 'interviewer', 'hr'));
