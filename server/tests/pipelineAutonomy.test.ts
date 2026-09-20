import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { prisma } from '../src/db.js';
import { wipe } from '../src/seed/demoData.js';
import { DEFAULT_STAGES, type PipelineStage } from '../src/domain/pipelineStages.js';
import { PIPELINE_EVENTS, resolveTransition, targetStageKey } from '../src/domain/pipelineAutonomy.js';

/**
 * The autonomous candidate journey: Participation → Bronze → Silver → Gold →
 * Diamond. Events move a candidate forward and never back; the same event
 * twice does nothing; Diamond is only ever reached by a person finalising.
 */

const NO_AI_INTERVIEW: readonly PipelineStage[] = [
  { key: 'intake', label: 'Intake', kind: 'intake' },
  { key: 'panel', label: 'Panel', kind: 'human_interview' },
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

  it('sends a candidate with an interview scheduled to Silver', () => {
    expect(targetStageKey(DEFAULT_STAGES, 'interview.scheduled')).toBe('silver');
  });

  it('sends a candidate with an assessed interview to Gold', () => {
    expect(targetStageKey(DEFAULT_STAGES, 'interview.assessed')).toBe('gold');
  });

  it('sends a finalised candidate to Diamond', () => {
    expect(targetStageKey(DEFAULT_STAGES, 'candidate.finalized')).toBe('diamond');
  });

  it('has no target when the role plan lacks a stage of that kind', () => {
    expect(targetStageKey(NO_AI_INTERVIEW, 'interview.scheduled')).toBeNull();
  });

  it('finalises to the last stage of a custom plan', () => {
    expect(targetStageKey(NO_AI_INTERVIEW, 'candidate.finalized')).toBe('panel');
  });

  it('never lets an assessment reach a plan\'s last stage, even when it is the only human stage', () => {
    expect(targetStageKey(NO_AI_INTERVIEW, 'interview.assessed')).toBeNull();
  });
});

describe('resolveTransition', () => {
  it('moves forward from Participation to Silver when an interview is scheduled', () => {
    expect(resolveTransition(DEFAULT_STAGES, 'participation', 'interview.scheduled')).toEqual({ from: 'participation', to: 'silver' });
  });

  it('does nothing when the candidate is already at the target stage', () => {
    expect(resolveTransition(DEFAULT_STAGES, 'silver', 'interview.scheduled')).toBeNull();
  });

  it('never moves a candidate backwards', () => {
    expect(resolveTransition(DEFAULT_STAGES, 'gold', 'interview.scheduled')).toBeNull();
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
