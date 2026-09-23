-- The evidence-backed reading of a CV, stored beside the score it produced.
--
-- The fit panel re-scores on read, against the role as it is now rather than as
-- it was on the day the resume was uploaded. That is only honest if the re-score
-- is built from the same facts as the stored one: re-parsing the CV each time
-- would mean the displayed number could move because the parser changed, with
-- nothing to say so. It also keeps a page load free of a model call — the pass
-- that sharpens a messy CV runs once, here, at upload.
--
-- Rows written before the evidence-backed engine keep "{}", which every reader
-- treats as "no facts stored; this profile was scored by the old engine".

ALTER TABLE "CandidateProfileVersion" ADD COLUMN "cvFactsJson" TEXT NOT NULL DEFAULT '{}';
