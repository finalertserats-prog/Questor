import { describe, expect, it } from 'vitest';
import { DEMO_BEATS } from '../src/components/demo/demoScript';
import {
  beatOffered, capsSentence, closingChoices, demoSteps, interviewChoices, offeredBeats, rememberTourSeen, resolveRoute, tourAlreadySeen,
  type DemoStatus,
} from '../src/components/demo/demoTourModel';

const story = { orgSlug: 'acme-demo', roleId: 'role1', candidateId: 'cand1', sessionId: 'sess1', assessmentId: 'ass1' };
const status: DemoStatus = { visitor: { name: 'Rhea Kapoor', firstName: 'Rhea' }, caps: { roles: 2, candidates: 3, interviews: 3 }, modes: { candidate: true, observer: false }, story };

describe('the script', () => {
  // Ids name the beats rather than number them, so cutting B02 and B17 leaves
  // gaps on purpose: the anchors, the e2e walk and the script document all call
  // the remaining beats by the labels they already had. B21 — finalising,
  // which completes the workflow — comes before the two closing cards rather
  // than taking the retired B17's name. B20 was drafted for the human rounds
  // and cut: its block is empty in the provisioned sandbox, so the beat only
  // apologised for the screen.
  it('tells eighteen beats in order, each with something to say', () => {
    expect(DEMO_BEATS.map((b) => b.id)).toEqual([
      'B01', 'B03', 'B04', 'B05', 'B06', 'B07', 'B08', 'B09', 'B10',
      'B11', 'B12', 'B13', 'B14', 'B15', 'B16', 'B21', 'B18', 'B19',
    ]);
    for (const beat of DEMO_BEATS) expect(beat.body.trim().length).toBeGreaterThan(20);
  });

  // The owner's workflow now runs to its end: finalising is the real control,
  // and it is the last thing the story points at before the closing cards hand
  // the product back. The tour is modal to a pointer (styles/tour.css: the
  // scrim blocks the page), so nothing spotlit can be pressed until it is over.
  it('ends the story on finalising, whose anchor its own press removes', () => {
    const ids = DEMO_BEATS.map((b) => b.id);
    expect(ids.slice(ids.indexOf('B16'))).toEqual(['B16', 'B21', 'B18', 'B19']);
    const finalise = DEMO_BEATS.find((b) => b.id === 'B21')!;
    expect(finalise.anchor).toBe('pipeline-finalize');
    expect(finalise.closing).toBeUndefined();
    // Finalising moves her to the last stage, which makes `finalStage` null
    // and takes the button away, so a replay must be able to tell that from a
    // page still loading. The companion is drawn by the same component.
    expect(finalise.anchorSettledBy).toBe('pipeline-stage-track');
  });

  /**
   * A beat is read at whatever stage the sandbox is standing at, and B21's is
   * not fixed: the visitor may finalise from Silver, or record Proceed (which
   * the story narrates), replay, and read it again with Priya at Gold. A
   * sandbox provisioned before the hr-decides lane starts her at Gold too.
   *
   * So B21 must not name a stage, and must not do the arithmetic for one. Its
   * first draft said finalising "skips Gold ... so she is credited with Silver
   * and Diamond": right from Silver, and the exact opposite of what the same
   * press does from Gold, where awardsForPromotion strikes Gold and Diamond.
   */
  it('describes finalising without pinning it to a stage the sandbox may not be at', () => {
    const body = DEMO_BEATS.find((b) => b.id === 'B21')!.body;
    expect(body).toMatch(/from wherever she is standing/i);
    expect(body).not.toMatch(/skips Gold/i);
    expect(body).not.toMatch(/credited with Silver and Diamond/i);
    // Nor may it invent a rule: nothing in awardsForPromotion or /finalize
    // reads a round, so Questor does not refuse to certify rounds nobody ran.
    expect(body).not.toMatch(/certify rounds/i);
  });

  // The verdict panel is the only thing in the story that offers an action,
  // and the tour is modal, so nothing is recorded while it runs. The copy may
  // invite the review; it may never report it as done.
  it('invites the review that unlocks finalising, and never claims the story recorded it', () => {
    const body = DEMO_BEATS.find((b) => b.id === 'B21')!.body;
    expect(body).toMatch(/refused until a person has reviewed/i);
    // Every past-tense form of "you did it", not one phrasing of it.
    expect(body).not.toMatch(/you(?:'ve| have)?\s+(?:just\s+)?(?:recorded|reviewed|pressed|finalised|finalized)/i);
    expect(body).not.toMatch(/(?:the verdict|review) you (?:just )?(?:made|gave|left)/i);
  });

  it('keeps each card to a few sentences: one thing, and what it does', () => {
    for (const beat of DEMO_BEATS) expect(beat.body.split(/[.!?](?:\s|$)/).filter(Boolean).length, beat.id).toBeLessThanOrEqual(4);
  });

  it('never names a way of sitting the interview in the closing line, so it holds whichever is offered', () => {
    const closing = DEMO_BEATS.find((b) => b.id === 'B19')!;
    expect(closing.body).not.toMatch(/observer|as the candidate/i);
  });
});

describe('which beats a sandbox can show', () => {
  it('offers everything when the story and an interview mode are present', () => {
    expect(offeredBeats(DEMO_BEATS, status)).toHaveLength(18);
  });

  it('leaves out the story beats when the sandbox has no story', () => {
    const offered = offeredBeats(DEMO_BEATS, { ...status, story: null });
    expect(offered.map((b) => b.id)).toEqual(['B01', 'B03', 'B04', 'B05', 'B06', 'B18', 'B19']);
  });

  it('leaves out the interview card when no way of sitting it is on offer', () => {
    expect(beatOffered(DEMO_BEATS.find((b) => b.id === 'B19')!, { ...status, modes: { candidate: false, observer: false } })).toBe(false);
  });

  // B02 (the organisation's sign-in page) and B17 (the account-request page)
  // were cut: a visitor who is already inside should not be sent back out to a
  // public page to be told how the door works.
  it('never leaves the signed-in product', () => {
    const outside = DEMO_BEATS.filter((b) => b.route.startsWith('/o/') || b.route.startsWith('/signup'));
    expect(outside).toEqual([]);
  });

  it('fills the sandbox\'s ids into each route', () => {
    expect(resolveRoute(DEMO_BEATS.find((b) => b.id === 'B13')!, status)).toBe('/assessments/ass1');
    expect(resolveRoute(DEMO_BEATS.find((b) => b.id === 'B10')!, status)).toBe('/candidates/cand1?tab=journey');
    // The pipeline panel sits below the journey board on the same tab.
    expect(resolveRoute(DEMO_BEATS.find((b) => b.id === 'B21')!, status)).toBe('/candidates/cand1?tab=journey');
  });
});

describe('the tour\'s steps', () => {
  it('are the offered beats, each on its screen', () => {
    const steps = demoSteps(DEMO_BEATS, status);
    expect(steps.map((s) => s.id)).toEqual(DEMO_BEATS.map((b) => b.id));
    const aiBeat = steps.find((step) => step.id === 'B13')!;
    expect(aiBeat.route).toBe('/assessments/ass1');
    expect(aiBeat.anchor).toBe('assessment-ai');
  });

  it('greets the visitor by name on the welcome card, and by nothing when the name is unknown', () => {
    expect(demoSteps(DEMO_BEATS, status)[0].title).toBe('Hello, Rhea.');
    expect(demoSteps(DEMO_BEATS, status)[0].body).toMatch(/^Welcome to Questor\./);
    expect(demoSteps(DEMO_BEATS, { ...status, visitor: { name: '', firstName: '' } })[0].title).toBe('Welcome to Questor');
  });

  it('offers exactly the interview modes the server says are on', () => {
    expect(interviewChoices({ candidate: true, observer: true })).toEqual(['candidate', 'observer']);
    expect(interviewChoices({ candidate: false, observer: true })).toEqual(['observer']);
    expect(interviewChoices({ candidate: false, observer: false })).toEqual([]);
  });

  it('puts those on the interview card, a New role button on the explore card, and none elsewhere', () => {
    const interview = DEMO_BEATS.find((b) => b.id === 'B19')!;
    expect(closingChoices(interview, status)?.map((c) => c.id)).toEqual(['candidate']);
    expect(closingChoices(interview, { ...status, modes: { candidate: true, observer: true } })?.map((c) => c.id)).toEqual(['candidate', 'observer']);
    expect(closingChoices(DEMO_BEATS.find((b) => b.id === 'B18')!, status)?.map((c) => c.id)).toEqual(['new-role']);
    expect(closingChoices(DEMO_BEATS[4], status)).toBeUndefined();
  });

  it('writes the caps line from the server\'s numbers, on the explore card only', () => {
    expect(capsSentence(status.caps)).toBe('In the demo you can add up to 2 roles, 3 candidates and 3 interviews.');
    const steps = demoSteps(DEMO_BEATS, status);
    expect(steps.find((s) => s.id === 'B18')?.note).toContain('up to 2 roles');
    expect(steps.filter((s) => s.note !== undefined).map((s) => s.id)).toEqual(['B18']);
  });

  it('begins the story once per browser session, and copes with no storage', () => {
    const store = new Map<string, string>();
    const session = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); } };
    expect(tourAlreadySeen(session)).toBe(false);
    rememberTourSeen(session);
    expect(tourAlreadySeen(session)).toBe(true);
    expect(tourAlreadySeen(null)).toBe(false);
    expect(() => rememberTourSeen({ getItem: () => null, setItem: () => { throw new Error('quota'); } })).not.toThrow();
  });
});
