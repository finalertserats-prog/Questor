-- A role may now name a finer place inside its region: a US state, or New York
-- City. Illinois, NYC, Maryland and Colorado each have their own rules about
-- telling a candidate an AI is involved in hiring them, and all four were
-- simply "NA" to this software, so none of them could be triggered.
-- Nullable and with no default: an existing role keeps its region as its
-- jurisdiction, exactly as before (server/src/domain/roleJurisdiction.ts).

-- AlterTable
ALTER TABLE "Role" ADD COLUMN     "jurisdictionCode" TEXT;

