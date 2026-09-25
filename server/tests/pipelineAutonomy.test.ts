import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { prisma } from '../src/db.js';
import { wipe } from '../src/seed/demoData.js';
import { DEFAULT_STAGES, type PipelineStage } from '../src/domain/pipelineStages.js';
import {
  DECISION_OUTCOMES, PIPELINE_EVENTS, resolveDecision, resolveTransition, targetStageKey,
} from '../src/domain/pipelineAutonomy.js';

/**
 * The candidate journey: Participation → Bronze → Silver → Gold → Diamond.
 *
 * Two events still move a candidate on their own — onboarding starts the
 * pipeline, an analysed resume reaches Bronze — and they move forward, never
 * back, and do nothing the second time. Everything from Silver onwards is a
 * person's decision: `interview.scheduled` and `interview.assessed` are still
 * raised and still audited, and carry nobody.
 */

const NO_AI_INTERVIEW: readonly PipelineStage[] = [
  { key: 'intake', label: 'Intake', kind: 'intake' },
  { key: 'panel', label: 'Panel', kind: 'human_interview' },
];

/** A plan that never reads a CV: the profiled event has no stage of its kind to reach. */
const NO_PROFILE_REVIEW = NO_AI_INTERVIEW;

/** A plan whose only profile-review stage is its last, which no event may reach. */
const LAST_STAGE_IS_PROFILE_REVIEW: readonly PipelineStage[] = [
  { key: 'intake', label: 'Intake', kind: 'intake' },
  { key: 'screened', label: 'Screened', kind: 'profile_review' },
];

describe('the default medallion stages', () => {
  it('are Participation, Bronze, Silver, Gold and Diamond', () => {
    expect(DEFAULT_STAGES.map((s) => s.label)).toEqual(['Participation', 'Bronze', 'Silver', 'Gold', 'Diamond']);
  });

  it('no longer include Platinum', () => {
    expect(DEFAULT_STAGES.some((s) => s.key === 'platinum')).toBe(false);
  });
});

describe('targetStageKey', () => {
  it('sends an onboarded candidate to Participation', () => {
    expect(targetStageKey(DEFAULT_STAGES, 'candidate.onboarded')).toBe('participation');
  });

  it('sends a candidate whose profile was analysed to Bronze', () => {
    expect(targetStageKey(DEFAULT_STAGES, 'candidate.profiled')).toBe('bronze');
  });

  it('sends nobody to Silver when an interview is scheduled: HR decides that move', () => {
    expect(targetStageKey(DEFAULT_STAGES, 'interview.scheduled')).toBeNull();
  });

  it('sends nobody to Gold when an interview is assessed: HR decides that move too', () => {
    expect(targetStageKey(DEFAULT_STAGES, 'interview.assessed')).toBeNull();
  });

  it('sends a finalised candidate to Diamond', () => {
    expect(targetStageKey(DEFAULT_STAGES, 'candidate.finalized')).toBe('diamond');
  });

  it('has no target when the role plan lacks a stage of that kind', () => {
    expect(targetStageKey(NO_PROFILE_REVIEW, 'candidate.profiled')).toBeNull();
  });

  it('finalises to the last stage of a custom plan', () => {
    expect(targetStageKey(NO_AI_INTERVIEW, 'candidate.finalized')).toBe('panel');
  });

  it('never lets a profile reading reach a plan\'s last stage, even when it is the only stage of its kind', () => {
    expect(targetStageKey(LAST_STAGE_IS_PROFILE_REVIEW, 'candidate.profiled')).toBeNull();
  });
});

describe('resolveTransition', () => {
  it('moves forward from Participation to Bronze when the resume has been analysed', () => {
    expect(resolveTransition(DEFAULT_STAGES, 'participation', 'candidate.profiled')).toEqual({ from: 'participation', to: 'bronze' });
  });

  it('does nothing when the candidate is already at the target stage', () => {
    expect(resolveTransition(DEFAULT_STAGES, 'bronze', 'candidate.profiled')).toBeNull();
  });

  it('never moves a candidate backwards', () => {
    expect(resolveTransition(DEFAULT_STAGES, 'gold', 'candidate.profiled')).toBeNull();
  });

  // The whole of part one of "HR decides": the two events that used to carry a
  // candidate to Silver and to Gold are still raised, and now carry nobody.
  it('leaves a scheduled interview where it found the candidate', () => {
    expect(resolveTransition(DEFAULT_STAGES, 'bronze', 'interview.scheduled')).toBeNull();
  });

  it('leaves an assessed interview where it found the candidate', () => {
    expect(resolveTransition(DEFAULT_STAGES, 'silver', 'interview.assessed')).toBeNull();
  });

  it('keeps a Diamond candidate at Diamond whatever happens next', () => {
    const outcomes = PIPELINE_EVENTS.map((event) => resolveTransition(DEFAULT_STAGES, 'diamond', event));
    expect(outcomes).toEqual([null, null, null, null, null]);
  });

  it('does nothing when the current stage is not in the plan', () => {
    expect(resolveTransition(DEFAULT_STAGES, 'platinum', 'candidate.finalized')).toBeNull();
  });

  it('never reaches Diamond from an interview event', () => {
    const reached = ['candidate.onboarded', 'candidate.profiled', 'interview.scheduled', 'interview.assessed'] as const;
    expect(reached.map((event) => resolveTransition(DEFAULT_STAGES, 'participation', event)?.to)).not.toContain('diamond');
  });
});

/**
 * A person's decision drives the pipeline: approving a stage moves the
 * candidate to the one after it (Silver → Gold, Gold → Diamond); approving
 * the last stage, or rejecting or withdrawing anywhere, closes it. Forward
 * only, and approving a stage already left changes nothing.
 */
describe('resolveDecision', () => {
  it('moves an approved Silver candidate to Gold', () => {
    expect(resolveDecision(DEFAULT_STAGES, 'silver', 'APPROVED', 'silver'))
      .toEqual({ kind: 'advance', from: 'silver', to: 'gold', final: false });
  });

  it('moves an approved Gold candidate to Diamond, and says so is the last stage', () => {
    expect(resolveDecision(DEFAULT_STAGES, 'gold', 'APPROVED', 'gold'))
      .toEqual({ kind: 'advance', from: 'gold', to: 'diamond', final: true });
  });

  it('closes an approved Diamond candidate as approved', () => {
    expect(resolveDecision(DEFAULT_STAGES, 'diamond', 'APPROVED', 'diamond'))
      .toEqual({ kind: 'close', outcome: 'APPROVED', atStageKey: 'diamond' });
  });

  it('closes a rejected candidate at the stage they are at, whatever the decision was about', () => {
    expect(resolveDecision(DEFAULT_STAGES, 'gold', 'REJECTED', 'silver'))
      .toEqual({ kind: 'close', outcome: 'REJECTED', atStageKey: 'gold' });
  });

  it('closes a withdrawn candidate at the stage they are at', () => {
    expect(resolveDecision(DEFAULT_STAGES, 'bronze', 'WITHDRAWN', 'bronze'))
      .toEqual({ kind: 'close', outcome: 'WITHDRAWN', atStageKey: 'bronze' });
  });

  it('does nothing when the approved stage has already been left', () => {
    expect(resolveDecision(DEFAULT_STAGES, 'gold', 'APPROVED', 'silver')).toBeNull();
  });

  it('is idempotent: approving the same stage twice resolves to nothing the second time', () => {
    const first = resolveDecision(DEFAULT_STAGES, 'silver', 'APPROVED', 'silver');
    expect(resolveDecision(DEFAULT_STAGES, first?.kind === 'advance' ? first.to : 'silver', 'APPROVED', 'silver')).toBeNull();
  });

  // Approving a round a candidate has not formally reached brings them TO it,
  // never past it. A candidate can now be interviewed while their pipeline
  // still says Bronze, and carrying them from Bronze to Gold would skip Silver
  // — which is not cosmetic, because a tier is struck by the move that leaves
  // it, so a candidate vaulted over Silver would earn no Silver credential.
  it('brings a candidate up to the round that was approved, never past it', () => {
    expect(resolveDecision(DEFAULT_STAGES, 'bronze', 'APPROVED', 'silver'))
      .toEqual({ kind: 'advance', from: 'bronze', to: 'silver', final: false });
  });

  it('still moves them off a round they are standing at when it is approved', () => {
    expect(resolveDecision(DEFAULT_STAGES, 'silver', 'APPROVED', 'silver'))
      .toEqual({ kind: 'advance', from: 'silver', to: 'gold', final: false });
  });

  it('does nothing for an approval of a stage the plan does not contain', () => {
    expect(resolveDecision(DEFAULT_STAGES, 'silver', 'APPROVED', 'platinum')).toBeNull();
  });

  it('does nothing for an approval when the current stage is not in the plan', () => {
    expect(resolveDecision(DEFAULT_STAGES, 'platinum', 'APPROVED', 'silver')).toBeNull();
  });

  it('never approves a candidate straight into the last stage from behind it', () => {
    expect(resolveDecision(DEFAULT_STAGES, 'silver', 'APPROVED', 'diamond')).toBeNull();
  });

  it('reaches the last stage of a plan whose only human stage is the last one, because a person approved it', () => {
    expect(resolveDecision(NO_AI_INTERVIEW, 'intake', 'APPROVED', 'intake'))
      .toEqual({ kind: 'advance', from: 'intake', to: 'panel', final: true });
  });

  it('knows exactly three outcomes', () => {
    expect(DECISION_OUTCOMES).toEqual(['APPROVED', 'REJECTED', 'WITHDRAWN']);
  });
});

/*
 * The verdict → stored-decision mapping moved to domain/verdict.ts, which is
 * the one place the two enums are allowed to meet, and is covered by
 * tests/verdictVocabulary.test.ts — including the browser's copy of it.
 */

/**
 * The Platinum retirement migration is plain SQL (REPLACE and LIKE only), so
 * the same statements run here against SQLite as run in production on Postgres.
 */
const MIGRATION = join(process.cwd(), 'prisma', 'postgres', 'migrations', '20260920180000_retire_platinum_stage', 'migration.sql');

const SIX_STAGES = JSON.stringify([
  ...DEFAULT_STAGES.slice(0, 4),
  { key: 'platinum', label: 'Platinum', kind: 'human_interview' },
  DEFAULT_STAGES[4],
]);

async function runMigration() {
  const statements = readFileSync(MIGRATION, 'utf8')
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const statement of statements) await prisma.$executeRawUnsafe(statement);
}

/** A custom plan that ends at Platinum and has no Gold stage to fall back to. */
const NO_GOLD = JSON.stringify([
  DEFAULT_STAGES[0],
  { key: 'platinum', label: 'Platinum', kind: 'human_interview' },
]);

async function platinumPipeline(stage: string, decidedAtStageKey: string | null = null, plan = SIX_STAGES) {
  const tenant = await prisma.tenant.create({ data: { name: `Retire ${stage}` } });
  const role = await prisma.role.create({ data: { tenantId: tenant.id, title: 'Engineer', pipelineStagesJson: plan } });
  const candidate = await prisma.candidate.create({ data: { tenantId: tenant.id, roleId: role.id, fullName: 'Pat Lee', email: 'pat@example.test' } });
  const pipeline = await prisma.candidatePipeline.create({
    data: { tenantId: tenant.id, candidateId: candidate.id, roleId: role.id, stagesJson: plan, currentStageKey: stage, decidedAtStageKey },
  });
  const round = await prisma.interviewRound.create({
    data: { tenantId: tenant.id, pipelineId: pipeline.id, stageKey: 'platinum', conductedBy: 'HUMAN', scheduledAt: new Date() },
  });
  return { role, pipeline, round };
}

describe('retiring Platinum', () => {
  it('moves a candidate at Platinum to Gold', async () => {
    await wipe();
    const { pipeline } = await platinumPipeline('platinum');

    await runMigration();

    expect((await prisma.candidatePipeline.findUniqueOrThrow({ where: { id: pipeline.id } })).currentStageKey).toBe('gold');
  });

  it('removes Platinum from the snapshotted stage plan', async () => {
    await wipe();
    const { pipeline } = await platinumPipeline('silver');

    await runMigration();

    const after = await prisma.candidatePipeline.findUniqueOrThrow({ where: { id: pipeline.id } });
    expect(JSON.parse(after.stagesJson)).toEqual(DEFAULT_STAGES);
  });

  it('leaves a candidate at another stage where they are', async () => {
    await wipe();
    const { pipeline } = await platinumPipeline('silver');

    await runMigration();

    expect((await prisma.candidatePipeline.findUniqueOrThrow({ where: { id: pipeline.id } })).currentStageKey).toBe('silver');
  });

  it('records a decision made at Platinum as made at Gold', async () => {
    await wipe();
    const { pipeline } = await platinumPipeline('platinum', 'platinum');

    await runMigration();

    expect((await prisma.candidatePipeline.findUniqueOrThrow({ where: { id: pipeline.id } })).decidedAtStageKey).toBe('gold');
  });

  it('moves rounds scheduled at Platinum to Gold', async () => {
    await wipe();
    const { round } = await platinumPipeline('platinum');

    await runMigration();

    expect((await prisma.interviewRound.findUniqueOrThrow({ where: { id: round.id } })).stageKey).toBe('gold');
  });

  it('removes Platinum from a role\'s stage plan', async () => {
    await wipe();
    const { role } = await platinumPipeline('gold');

    await runMigration();

    const after = await prisma.role.findUniqueOrThrow({ where: { id: role.id } });
    expect(JSON.parse(after.pipelineStagesJson)).toEqual(DEFAULT_STAGES);
  });

  it('leaves a custom plan with Platinum but no Gold whole: the candidate stays at Platinum', async () => {
    await wipe();
    const { pipeline } = await platinumPipeline('platinum', null, NO_GOLD);

    await runMigration();

    const after = await prisma.candidatePipeline.findUniqueOrThrow({ where: { id: pipeline.id } });
    expect([after.currentStageKey, after.stagesJson]).toEqual(['platinum', NO_GOLD]);
  });

  it('leaves rounds of a custom plan with Platinum but no Gold where they are', async () => {
    await wipe();
    const { round } = await platinumPipeline('platinum', null, NO_GOLD);

    await runMigration();

    expect((await prisma.interviewRound.findUniqueOrThrow({ where: { id: round.id } })).stageKey).toBe('platinum');
  });

  it('leaves a role plan with Platinum but no Gold unchanged', async () => {
    await wipe();
    const { role } = await platinumPipeline('platinum', null, NO_GOLD);

    await runMigration();

    expect((await prisma.role.findUniqueOrThrow({ where: { id: role.id } })).pipelineStagesJson).toBe(NO_GOLD);
  });

  it('is safe to run twice', async () => {
    await wipe();
    const { pipeline } = await platinumPipeline('platinum');
    await runMigration();

    await runMigration();

    const after = await prisma.candidatePipeline.findUniqueOrThrow({ where: { id: pipeline.id } });
    expect([after.currentStageKey, JSON.parse(after.stagesJson).length]).toEqual(['gold', 5]);
  });
});
