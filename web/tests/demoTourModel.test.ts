import { describe, expect, it } from 'vitest';
import { DEMO_BEATS } from '../src/components/demo/demoScript';
import {
  beatAnnouncement, beatOffered, capsSentence, captionDurationMs, demoKeyAction, demoProgress, hasNarration, interviewChoices,
  nextBeat, offeredBeats, pauseDemoTour, previousBeat, rememberTourSeen, resolveRoute, resumeDemoTour, skipDemoTour, startDemoTour,
  tourAlreadySeen, waitsForChoice, type DemoStatus,
} from '../src/components/demo/demoTourModel';

const story = { orgSlug: 'acme-demo', roleId: 'role1', candidateId: 'cand1', sessionId: 'sess1', assessmentId: 'ass1' };
const status: DemoStatus = { visitor: { name: 'Rhea Kapoor', firstName: 'Rhea' }, caps: { roles: 2, candidates: 3, interviews: 3 }, modes: { candidate: true, observer: false }, story };

describe('the script', () => {
  it('tells nineteen beats in order, each with a line to say', () => {
    expect(DEMO_BEATS.map((b) => b.id)).toEqual(Array.from({ length: 19 }, (_, i) => `B${String(i + 1).padStart(2, '0')}`));
    for (const beat of DEMO_BEATS) expect(beat.caption.trim().length).toBeGreaterThan(20);
  });

  it('runs about five and a half minutes of speech', () => {
    const total = DEMO_BEATS.reduce((sum, b) => sum + b.seconds, 0);
    expect(total).toBeGreaterThan(280);
    expect(total).toBeLessThan(345);
  });

  it('never names a way of sitting the interview in the audio, so the recording holds whichever is offered', () => {
    const closing = DEMO_BEATS.find((b) => b.id === 'B19')!;
    expect(closing.caption).not.toMatch(/observer|as the candidate/i);
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

describe('stepping through', () => {
  it('starts on the first beat, playing', () => {
    expect(startDemoTour(19)).toEqual({ phase: 'playing', index: 0, ending: null });
  });

  it('is already finished when there is nothing to show', () => {
    expect(startDemoTour(0).phase).toBe('ended');
  });

  it('finishes past the last beat', () => {
    const last = { phase: 'playing' as const, index: 18, ending: null };
    expect(nextBeat(last, 19)).toEqual({ phase: 'ended', index: 18, ending: 'finished' });
  });

  it('resumes playing when stepping forward from a pause', () => {
    expect(nextBeat({ phase: 'paused', index: 2, ending: null }, 19)).toEqual({ phase: 'playing', index: 3, ending: null });
  });

  it('replays the first beat when stepping back from it', () => {
    expect(previousBeat({ phase: 'playing', index: 0, ending: null }).index).toBe(0);
  });

  it('pauses and resumes', () => {
    const paused = pauseDemoTour(startDemoTour(19));
    expect(paused.phase).toBe('paused');
    expect(resumeDemoTour(paused).phase).toBe('playing');
  });

  it('records a skip as an ending', () => {
    expect(skipDemoTour({ phase: 'paused', index: 4, ending: null })).toEqual({ phase: 'ended', index: 4, ending: 'skipped' });
  });

  it('ignores steps outside a run', () => {
    const ended = { phase: 'ended' as const, index: 18, ending: 'finished' as const };
    expect([nextBeat(ended, 19), previousBeat(ended), pauseDemoTour(ended)]).toEqual([ended, ended, ended]);
  });
});

describe('what the visitor sees and hears', () => {
  it('counts progress over the offered beats', () => {
    expect(demoProgress({ phase: 'playing', index: 6, ending: null }, 19)).toEqual({ current: 7, total: 19, percent: 37 });
    expect(demoProgress({ phase: 'ended', index: 18, ending: 'finished' }, 19).percent).toBe(100);
  });

  it('announces the beat before its caption', () => {
    expect(beatAnnouncement(DEMO_BEATS[7], { current: 8, total: 19, percent: 42 })).toBe('Beat 8 of 19: The scorecard.');
  });

  it('maps the keys: space, R, the arrows and Escape', () => {
    expect([' ', 'r', 'ArrowRight', 'ArrowLeft', 'Escape', 'Tab'].map(demoKeyAction)).toEqual(['toggle-pause', 'replay', 'next', 'back', 'skip-tour', null]);
  });

  it('runs a beat on its caption for the scripted seconds when there is no audio', () => {
    expect(hasNarration(null, 'B01')).toBe(false);
    expect(hasNarration({ B01: { durationMs: 18200 } }, 'B01')).toBe(true);
    expect(captionDurationMs(DEMO_BEATS[0])).toBe(18000);
  });

  it('holds the two choice cards after their narration, and no other beat', () => {
    expect(DEMO_BEATS.filter(waitsForChoice).map((b) => b.id)).toEqual(['B18', 'B19']);
  });

  it('offers exactly the interview modes the server says are on', () => {
    expect(interviewChoices({ candidate: true, observer: true })).toEqual(['candidate', 'observer']);
    expect(interviewChoices({ candidate: false, observer: true })).toEqual(['observer']);
    expect(interviewChoices({ candidate: false, observer: false })).toEqual([]);
  });

  it('writes the caps line from the server\'s numbers', () => {
    expect(capsSentence(status.caps)).toBe('In the demo you can add up to 2 roles, 3 candidates and 3 interviews.');
  });

  it('shows the start card once per browser session, and copes with no storage', () => {
    const store = new Map<string, string>();
    const session = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); } };
    expect(tourAlreadySeen(session)).toBe(false);
    rememberTourSeen(session);
    expect(tourAlreadySeen(session)).toBe(true);
    expect(tourAlreadySeen(null)).toBe(false);
    expect(() => rememberTourSeen({ getItem: () => null, setItem: () => { throw new Error('quota'); } })).not.toThrow();
  });
});
