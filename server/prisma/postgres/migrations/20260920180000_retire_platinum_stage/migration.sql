-- Hand-written data migration; the schema is unchanged.
-- Platinum is retired from the medallion pipeline: Participation, Bronze,
-- Silver, Gold and Diamond remain. A candidate at Platinum was not finalised
-- (Diamond), so they hold at Gold, and rounds held at Platinum are Gold rounds.
--
-- Every statement applies to the same rows: plans that hold the default
-- Platinum entry exactly as JSON.stringify wrote it AND have a Gold stage to
-- move to. A custom plan that renamed Platinum, or has no Gold, is left whole
-- — its keys, rounds and snapshot stay consistent with each other — rather
-- than being pointed at a stage it does not contain.
-- Plain REPLACE/LIKE only, so server/tests/pipelineAutonomy.test.ts can run
-- these same statements against SQLite.

UPDATE "InterviewRound" SET "stageKey" = 'gold'
WHERE "stageKey" = 'platinum'
  AND "pipelineId" IN (
    SELECT "id" FROM "CandidatePipeline"
    WHERE "stagesJson" LIKE '%{"key":"platinum","label":"Platinum","kind":"human_interview"}%'
      AND "stagesJson" LIKE '%"key":"gold"%'
  );

UPDATE "CandidatePipeline" SET "currentStageKey" = 'gold'
WHERE "currentStageKey" = 'platinum'
  AND "stagesJson" LIKE '%{"key":"platinum","label":"Platinum","kind":"human_interview"}%'
  AND "stagesJson" LIKE '%"key":"gold"%';

UPDATE "CandidatePipeline" SET "decidedAtStageKey" = 'gold'
WHERE "decidedAtStageKey" = 'platinum'
  AND "stagesJson" LIKE '%{"key":"platinum","label":"Platinum","kind":"human_interview"}%'
  AND "stagesJson" LIKE '%"key":"gold"%';

-- The Platinum entry sits before Diamond (trailing comma) in the default plan
-- and last (leading comma) in a plan that ended with it.
UPDATE "CandidatePipeline" SET "stagesJson" = REPLACE(REPLACE("stagesJson",
  '{"key":"platinum","label":"Platinum","kind":"human_interview"},', ''),
  ',{"key":"platinum","label":"Platinum","kind":"human_interview"}', '')
WHERE "stagesJson" LIKE '%{"key":"platinum","label":"Platinum","kind":"human_interview"}%'
  AND "stagesJson" LIKE '%"key":"gold"%';

UPDATE "Role" SET "pipelineStagesJson" = REPLACE(REPLACE("pipelineStagesJson",
  '{"key":"platinum","label":"Platinum","kind":"human_interview"},', ''),
  ',{"key":"platinum","label":"Platinum","kind":"human_interview"}', '')
WHERE "pipelineStagesJson" LIKE '%{"key":"platinum","label":"Platinum","kind":"human_interview"}%'
  AND "pipelineStagesJson" LIKE '%"key":"gold"%';
