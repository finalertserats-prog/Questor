import { describe, expect, it } from 'vitest';
import { FIRST_RUN_COPY, firstRunCard } from '../src/components/hrbox/needsYouModel';
import type { FirstRun, NeedsYouFeed } from '../src/components/hrbox/needsYouModel';
// Imported from the server rather than copied, so a step added there and
// forgotten here genuinely fails. The one live enum mismatch this product has
// had was a needs-you kind in exactly that shape — the only mirrored union in
// the HR-Box cluster with no parity test. From `domain/`, which is four
// strings and no runtime: the service beside it opens a database.
import { FIRST_RUN_STEPS } from '../../server/src/domain/firstRun';

/**
 * The first screen a new organisation sees.
 *
 * Home told an organisation where nothing had happened yet the same thing it
 * told a team that was simply caught up: "Nothing needs you — the interviewers
 * will say when something does." To someone who had just been given an
 * account, the product's own opening line said wait, and the only first-run
 * guidance in Questor sat on a tab they were never shown.
 *
 * The first fix said "Start with a role" instead — and then kept saying it.
 * The card was driven by the queue alone, and the queue of an organisation
 * with a role, an approved scorecard and a candidate is just as empty as that
 * of one with nothing at all. So an organisation that had done three of the
 * four steps was invited to do the first one again, and never told about the
 * interview it was one click from starting.
 *
 * Two real organisations registered in production, saw that screen, and
 * produced no events at all. These tests exist so the card can never point
 * backwards again.
 */

function feed(firstRun: FirstRun | null): NeedsYouFeed {
  return {
    generatedAt: new Date().toISOString(),
    crew: [],
    needsYou: { total: 0, page: 1, pageSize: 10, items: [] },
    comingUp: [],
    doneRecently: [],
    firstRun,
  } as unknown as NeedsYouFeed;
}

const run = (over: Partial<FirstRun> = {}): FirstRun => ({
  step: 'role', roleId: null, candidateId: null, canAct: true, ...over,
});

describe('the first-run card', () => {
  it('says nothing at all once the organisation is under way', () => {
    expect(firstRunCard(feed(null))).toBeNull();
  });

  it('asks a brand-new organisation for a role', () => {
    expect(firstRunCard(feed(run({ step: 'role' })))?.action).toEqual({ label: 'Create your first role', to: '/roles/new' });
  });

  it('sends them to the role itself once the scorecard is the thing missing', () => {
    const card = firstRunCard(feed(run({ step: 'scorecard', roleId: 'role-1' })));
    expect(card?.action).toEqual({ label: 'Approve the scorecard', to: '/roles/role-1' });
  });

  it('asks for a candidate on the role that is ready for one', () => {
    const card = firstRunCard(feed(run({ step: 'candidate', roleId: 'role-1' })));
    expect(card?.action).toEqual({ label: 'Add your first candidate', to: '/candidates/new?roleId=role-1' });
  });

  it('sends them to the journey tab, where the interview is actually set up', () => {
    const card = firstRunCard(feed(run({ step: 'interview', roleId: 'role-1', candidateId: 'cand-1' })));
    expect(card?.action).toEqual({ label: 'Set up the interview', to: '/candidates/cand-1?tab=journey' });
  });

  it('never invites someone to redo a step they have already done', () => {
    const steps = ['scorecard', 'candidate', 'interview'] as const;
    const backwards = steps.filter((step) => firstRunCard(feed(run({ step, roleId: 'role-1', candidateId: 'cand-1' })))?.action?.to === '/roles/new');
    expect(backwards).toEqual([]);
  });

  it('offers no button to someone who would be refused, and says who to ask', () => {
    const card = firstRunCard(feed(run({ step: 'scorecard', roleId: 'role-1', canAct: false })));
    expect([card?.action, card?.message.includes('admin')]).toEqual([null, true]);
  });

  it('has copy for every step the server can send', () => {
    const missing = FIRST_RUN_STEPS.filter((step) => !(step in FIRST_RUN_COPY));
    expect(missing).toEqual([]);
  });

  it('has no copy for a step the server cannot send', () => {
    const orphaned = Object.keys(FIRST_RUN_COPY).filter((step) => !(FIRST_RUN_STEPS as readonly string[]).includes(step));
    expect(orphaned).toEqual([]);
  });

  it('names the step in the title, so the card reads differently as it advances', () => {
    const titles = (['role', 'scorecard', 'candidate', 'interview'] as const)
      .map((step) => firstRunCard(feed(run({ step, roleId: 'role-1', candidateId: 'cand-1' })))?.title);
    expect(new Set(titles).size).toBe(4);
  });
});
