import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../../src/db.js';
import type { InterviewPlan, LibraryQuestionSnapshot, PlanBlock, TurnRecord } from '../../src/domain/types.js';
import { anchorsFor, recordLibraryUsage, usageRowsFor } from '../../src/library/usage.js';
import { eraseCandidate } from '../../src/services/dataRights.js';
import { entry, seedLibraryWorld, type LibraryWorld } from './libraryFixtures.js';

/** Usage rows with block source, the rung path, and the anchors the evaluator grades against. */

function rung(entryId: string, difficultyTag: number): LibraryQuestionSnapshot {
  return { entryId, standardId: null, questionText: `Q ${entryId}`, anchors: [`anchor ${entryId}`], form: 'star', difficultyTag };
}

function block(competencyId: string, library: PlanBlock['library']): PlanBlock {
  return { competencyId, competencyName: competencyId, intent: '', targetMinutes: 6, followupHints: [], prohibited: [], library };
}

function trialPlan(ids: { lib: [string, string]; }): InterviewPlan {
  return {
    durationMinutes: 45, language: 'en', modules: [], coverageTargets: {},
    library: { mode: 'trial', rubricVersion: 'sc', roleSlug: 'payments-platform-engineer', band: 'established', windowDays: 30, trialPercent: 50, selectedAt: '' },
    blocks: [
      block('c1', { source: 'library', competencyKey: 'k1', trial: true, ladder: [rung(ids.lib[0], 1), rung(ids.lib[1], 2)], startRung: 0 }),
      block('c2', { source: 'builtin', reason: 'trial_control', competencyKey: 'k2', trial: true }),
      block('c3', { source: 'builtin', reason: 'no_ladder', competencyKey: 'k3', trial: false }),
    ],
  };
}

let n = 0;
const agent = (competencyId: string, extra: Partial<TurnRecord> = {}): TurnRecord => ({ id: `a${++n}`, index: n, speaker: 'agent', text: 'Tell me about it.', startMs: 0, endMs: 0, confidence: 1, competencyId, kind: 'question', ...extra });
const said = (competencyId: string, text: string): TurnRecord => ({ id: `c${++n}`, index: n, speaker: 'candidate', text, startMs: 0, endMs: 0, confidence: 1, competencyId });

const GOOD = 'During the migration project I led the rollout and we reduced failed payouts by 40 percent.';

function transcript(): TurnRecord[] {
  return [
    agent('c1', { libraryEntryId: 'e1' }), said('c1', GOOD),
    agent('c1', { libraryEntryId: 'e2', kind: 'followup' }), said('c1', 'What do you mean exactly?'), said('c1', GOOD),
    agent('c2'), said('c2', GOOD), agent('c2', { kind: 'followup' }), said('c2', GOOD),
  ];
}

describe('usageRowsFor', () => {
  it('writes one row per library rung asked and one per built-in block reached', () => {
    const rows = usageRowsFor(trialPlan({ lib: ['e1', 'e2'] }), transcript());
    expect(rows.map((r) => r.blockKey)).toEqual(['c1#e1', 'c1#e2', 'c2#builtin']);
  });

  it('records the block source', () => {
    const rows = usageRowsFor(trialPlan({ lib: ['e1', 'e2'] }), transcript());
    expect(rows.map((r) => r.blockSource)).toEqual(['library', 'library', 'builtin']);
  });

  it('records the rung path', () => {
    const rows = usageRowsFor(trialPlan({ lib: ['e1', 'e2'] }), transcript());
    expect(rows.slice(0, 2).map((r) => [r.rungIndex, r.rungMove])).toEqual([[0, 'start'], [1, 'up']]);
  });

  it('counts a confusion marker against the rung it followed', () => {
    const rows = usageRowsFor(trialPlan({ lib: ['e1', 'e2'] }), transcript());
    expect(rows[1].confusionMarkers).toBe(1);
  });

  it('counts the follow-ups of a built-in block as probes', () => {
    expect(usageRowsFor(trialPlan({ lib: ['e1', 'e2'] }), transcript())[2].probeCount).toBe(1);
  });

  it('marks both sides of the trial pair', () => {
    const rows = usageRowsFor(trialPlan({ lib: ['e1', 'e2'] }), transcript());
    expect(rows.every((r) => r.trial)).toBe(true);
  });

  it('records a non-answer with no yield credit', () => {
    const turns = [agent('c2'), said('c2', 'Pass.')];
    expect(usageRowsFor(trialPlan({ lib: ['e1', 'e2'] }), turns)[0]).toMatchObject({ outcome: 'skipped', evidenceYield: 0 });
  });

  it('keeps a library block that ran on the built-in bank out of the pairing', () => {
    const turns = [agent('c1'), said('c1', GOOD)];
    expect(usageRowsFor(trialPlan({ lib: ['e1', 'e2'] }), turns)[0]).toMatchObject({ blockSource: 'builtin', trial: false, entryId: null });
  });

  it('writes nothing for a plan without the library', () => {
    const { library: _library, ...plain } = trialPlan({ lib: ['e1', 'e2'] });
    expect(usageRowsFor(plain, transcript())).toEqual([]);
  });
});

describe('anchorsFor', () => {
  it('gives the evaluator the anchors of the rungs actually asked', () => {
    expect(anchorsFor(trialPlan({ lib: ['e1', 'e2'] }), [agent('c1', { libraryEntryId: 'e2' })])).toEqual({ c1: ['anchor e2'] });
  });

  it('gives nothing for a rung never asked', () => {
    expect(anchorsFor(trialPlan({ lib: ['e1', 'e2'] }), [agent('c1')])).toEqual({});
  });
});

describe('recordLibraryUsage', () => {
  let world: LibraryWorld;
  beforeEach(async () => {
    world = await seedLibraryWorld();
  });

  async function livePlan() {
    const a = await entry(world, { difficultyTag: 1 });
    const b = await entry(world, { difficultyTag: 2, form: 'opinion' });
    return trialPlan({ lib: [a.id, b.id] });
  }

  function turnsFor(plan: InterviewPlan): TurnRecord[] {
    const [a, b] = plan.blocks[0].library?.ladder ?? [];
    return [agent('c1', { libraryEntryId: a.entryId }), said('c1', GOOD), agent('c1', { libraryEntryId: b.entryId, kind: 'followup' }), said('c1', GOOD), agent('c2'), said('c2', GOOD)];
  }

  it('writes the rows once however often the interview is finalised', async () => {
    const plan = await livePlan();
    const input = { sessionId: 's1', tenantId: world.admin.tenantId, roleId: world.roleId, plan, turns: turnsFor(plan) };
    await recordLibraryUsage(input);
    await recordLibraryUsage(input);
    expect(await prisma.libraryUsage.count({ where: { interviewSessionId: 's1' } })).toBe(3);
  });

  it('writes the rows once when finalisations race', async () => {
    const plan = await livePlan();
    for (let round = 0; round < 10; round++) {
      const input = { sessionId: `race-${round}`, tenantId: world.admin.tenantId, roleId: world.roleId, plan, turns: turnsFor(plan) };
      await Promise.all([recordLibraryUsage(input), recordLibraryUsage(input), recordLibraryUsage(input)]);
      expect(await prisma.libraryUsage.count({ where: { interviewSessionId: `race-${round}` } })).toBe(3);
    }
  });

  it('keys the rows to the role for the no-repeat window', async () => {
    const plan = await livePlan();
    await recordLibraryUsage({ sessionId: 's2', tenantId: world.admin.tenantId, roleId: world.roleId, plan, turns: turnsFor(plan) });
    const rows = await prisma.libraryUsage.findMany({ where: { interviewSessionId: 's2' } });
    expect(rows.every((r) => r.roleSlug === 'payments-platform-engineer')).toBe(true);
  });

  it('promotes a probational entry once it has enough clean uses', async () => {
    const probational = await entry(world, { difficultyTag: 1, status: 'probational' });
    const other = await entry(world, { difficultyTag: 2, form: 'opinion' });
    const plan = trialPlan({ lib: [probational.id, other.id] });
    for (let i = 0; i < 5; i++) {
      await recordLibraryUsage({ sessionId: `p${i}`, tenantId: world.admin.tenantId, roleId: world.roleId, plan, turns: turnsFor(plan) });
    }
    expect((await prisma.libraryEntry.findUniqueOrThrow({ where: { id: probational.id } })).status).toBe('live');
  });

  it('is erased with the interview when the candidate is erased', async () => {
    const plan = await livePlan();
    const candidate = await prisma.candidate.create({ data: { tenantId: world.admin.tenantId, roleId: world.roleId, fullName: 'Erase Me', email: `erase-${Date.now()}@example.com` } });
    const scorecard = await prisma.roleScorecardVersion.findFirstOrThrow({ where: { roleId: world.roleId } });
    const session = await prisma.interviewSession.create({ data: { tenantId: world.admin.tenantId, candidateId: candidate.id, roleId: world.roleId, scorecardId: scorecard.id, state: 'REVIEW_READY' } });
    await recordLibraryUsage({ sessionId: session.id, tenantId: world.admin.tenantId, roleId: world.roleId, plan, turns: turnsFor(plan) });
    await eraseCandidate({ tenantId: world.admin.tenantId, candidateId: candidate.id, actorId: world.admin.id, reason: 'Candidate asked to be forgotten.' });
    expect(await prisma.libraryUsage.count({ where: { interviewSessionId: session.id } })).toBe(0);
  });
});
