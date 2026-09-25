import { describe, expect, it } from 'vitest';
import { DEMO_BEATS } from '../src/components/demo/demoScript';
import {
  beatOffered, capsSentence, closingChoices, demoSteps, interviewChoices, offeredBeats, rememberTourSeen, resolveRoute, tourAlreadySeen,
  type DemoStatus,
} from '../src/components/demo/demoTourModel';

const story = { orgSlug: 'acme-demo', roleId: 'role1', candidateId: 'cand1', sessionId: 'sess1', assessmentId: 'ass1' };
const status: DemoStatus = { visitor: { name: 'Rhea Kapoor', firstName: 'Rhea' }, caps: { roles: 2, candidates: 3, interviews: 3 }, modes: { candidate: true, observer: false }, story };

describe('the script', () => {
  it('tells nineteen beats in order, each with something to say', () => {
    expect(DEMO_BEATS.map((b) => b.id)).toEqual(Array.from({ length: 19 }, (_, i) => `B${String(i + 1).padStart(2, '0')}`));
    for (const beat of DEMO_BEATS) expect(beat.body.trim().length).toBeGreaterThan(20);
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
    expect(offeredBeats(DEMO_BEATS, status)).toHaveLength(19);
  });

  it('leaves out the story beats when the sandbox has no story', () => {
    const offered = offeredBeats(DEMO_BEATS, { ...status, story: null });
    expect(offered.map((b) => b.id)).toEqual(['B01', 'B03', 'B04', 'B05', 'B06', 'B17', 'B18', 'B19']);
  });

  it('leaves out the interview card when no way of sitting it is on offer', () => {
    expect(beatOffered(DEMO_BEATS[18], { ...status, modes: { candidate: false, observer: false } })).toBe(false);
  });

  it('leaves out the door when the organisation has no address', () => {
    expect(beatOffered(DEMO_BEATS[1], { ...status, story: { ...story, orgSlug: null } })).toBe(false);
  });

  it('fills the sandbox\'s ids into each route', () => {
    expect(resolveRoute(DEMO_BEATS[1], status)).toBe('/o/acme-demo?tour=door');
    expect(resolveRoute(DEMO_BEATS.find((b) => b.id === 'B13')!, status)).toBe('/assessments/ass1');
    expect(resolveRoute(DEMO_BEATS.find((b) => b.id === 'B10')!, status)).toBe('/candidates/cand1?tab=journey');
  });
});

describe('the tour\'s steps', () => {
  it('are the offered beats, each on its screen', () => {
    const steps = demoSteps(DEMO_BEATS, status);
    expect(steps.map((s) => s.id)).toEqual(DEMO_BEATS.map((b) => b.id));
    expect(steps[12].route).toBe('/assessments/ass1');
    expect(steps[12].anchor).toBe('assessment-ai');
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
