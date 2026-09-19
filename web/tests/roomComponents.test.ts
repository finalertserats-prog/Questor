import { describe, it, expect, vi, beforeAll } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// The panels reach the speech module through the portal page, and it reads
// `window` on import. A bare stand-in is enough: nothing here speaks.
vi.hoisted(() => { Object.assign(globalThis, { window: globalThis }); });
import { Conversation } from '../src/components/room/Conversation';
import { Composer, type ComposerProps } from '../src/components/room/Composer';
import { ParticipantsRail, type ParticipantsRailProps } from '../src/components/room/ParticipantsRail';
import { MIC_UNAVAILABLE_NOTE } from '../src/components/room/roomComposerModel';
import { DonePanel } from '../src/components/room/RoomPanels';

// Server rendering runs no effects; React says so once per layout effect.
beforeAll(() => { vi.spyOn(console, 'error').mockImplementation(() => undefined); });

const interviewer = { name: 'Maya', initial: 'M' };

describe('Conversation', () => {
  it('shows a code answer in a pre with its indentation', () => {
    const html = renderToStaticMarkup(createElement(Conversation, {
      messages: [{ id: 'a', speaker: 'candidate', text: 'SELECT 1\n  FROM t', code: true, atMs: 65_000 }],
      interviewer, candidateInitials: 'PS', revealing: null,
    }));
    expect(html).toContain('<pre class="room-code">SELECT 1\n  FROM t</pre>');
  });

  it('stamps each message with its time into the interview', () => {
    const html = renderToStaticMarkup(createElement(Conversation, {
      messages: [{ id: 'a', speaker: 'agent', text: 'Hello', atMs: 65_000 }],
      interviewer, candidateInitials: 'PS', revealing: null,
    }));
    expect(html).toContain('<time>01:05</time>');
  });

  it('holds back words the interviewer has not said yet', () => {
    const html = renderToStaticMarkup(createElement(Conversation, {
      messages: [{ id: 'a', speaker: 'agent', text: 'Tell me more' }],
      interviewer, candidateInitials: 'PS', revealing: { id: 'a', spoken: () => 1 },
    }));
    expect(html).toContain('room-word is-pending');
  });

  it('has a polite live region for what is newly said', () => {
    const html = renderToStaticMarkup(createElement(Conversation, {
      messages: [], interviewer, candidateInitials: 'PS', revealing: null,
    }));
    expect(html).toContain('role="status"');
  });

  it('does not make the whole history a live region, so a rejoin is not read out in full', () => {
    const html = renderToStaticMarkup(createElement(Conversation, {
      messages: [{ id: 'a', speaker: 'agent', text: 'Hello' }], interviewer, candidateInitials: 'PS', revealing: null,
    }));
    expect(html).not.toMatch(/<ol[^>]*aria-live/);
  });
});

const composerProps = (over: Partial<ComposerProps> = {}): ComposerProps => ({
  mode: 'type', speakUnavailable: null, phase: 'listening', paused: false, interviewerName: 'Maya',
  capturing: false, interim: '', typed: '', canSend: false, currentQuestion: 'Tell me about your role.',
  repeatAvailable: true, nudge: null, getCandidateLevel: () => 0,
  onTypedChange: () => undefined, onSelectMode: () => undefined, onSend: () => undefined,
  onDoneSpeaking: () => undefined, onRepeat: () => undefined, onResume: () => undefined,
  ...over,
});

describe('Composer', () => {
  it('explains why speaking is unavailable without consent', () => {
    const html = renderToStaticMarkup(createElement(Composer, composerProps({ speakUnavailable: MIC_UNAVAILABLE_NOTE })));
    expect(html).toContain("voice capture wasn&#x27;t agreed at the start");
  });

  it('disables the Speak option without consent', () => {
    const html = renderToStaticMarkup(createElement(Composer, composerProps({ speakUnavailable: MIC_UNAVAILABLE_NOTE })));
    expect(html).toMatch(/<button type="button" aria-pressed="false" disabled=""[^>]*>.*?Speak<\/button>/);
  });

  it('gives the code editor a monospace class and a keyboard way out', () => {
    const html = renderToStaticMarkup(createElement(Composer, composerProps({ mode: 'code' })));
    expect(html).toContain('class="room-answer is-code"');
  });

  it('puts the rejoin greeting before the pending question', () => {
    const html = renderToStaticMarkup(createElement(Composer, composerProps({ questionPrefix: 'Welcome back.' })));
    expect(html).toContain('Welcome back. Tell me about your role.');
  });

  it('offers Continue when the last answer is awaiting a reply', () => {
    const html = renderToStaticMarkup(createElement(Composer, composerProps({ onContinue: () => undefined })));
    expect(html).toContain('Continue</button>');
  });

  it('pins the current question', () => {
    const html = renderToStaticMarkup(createElement(Composer, composerProps()));
    expect(html).toContain('Current question');
  });

  it('lets the full current question be opened from the keyboard', () => {
    const html = renderToStaticMarkup(createElement(Composer, composerProps()));
    expect(html).toMatch(/<button[^>]*aria-expanded="false"[^>]*>/);
  });

  it('does not mark the microphone as a toggle as well as renaming it', () => {
    const html = renderToStaticMarkup(createElement(Composer, composerProps({ mode: 'speak', capturing: true })));
    expect(html).not.toMatch(/room-mic[^>]*aria-pressed|aria-pressed[^>]*room-mic/);
  });

  it('labels the pressed microphone as the way to finish a spoken answer', () => {
    const html = renderToStaticMarkup(createElement(Composer, composerProps({ mode: 'speak', capturing: true })));
    expect(html).toContain('aria-label="Done answering"');
  });
});

const railProps = (over: Partial<ParticipantsRailProps> = {}): ParticipantsRailProps => ({
  interviewer, candidate: { name: 'Priya Sharma', initial: 'PS' },
  aiStatus: 'Ready', aiThinking: false, aiSpeaking: false,
  getAiLevel: () => 0, getCandidateLevel: () => 0, candidateStatus: () => 'Mic ready',
  observers: [], privacy: 'Maya is an AI interviewer.',
  ...over,
});

describe('DonePanel', () => {
  it('says only that the interview is complete when this room did not see it end', () => {
    const feedback = { offered: true, choice: null, saving: false, error: '', onAnswer: () => undefined };
    const html = renderToStaticMarkup(createElement(DonePanel, { feedback, completedNote: 'Already done.' }));
    expect(html).toContain('Your interview is complete');
  });
});

describe('DonePanel after leaving', () => {
  const feedback = { offered: false, choice: null, saving: false, error: '', onAnswer: () => undefined };

  it('says the candidate left, not that the interview was submitted for review', () => {
    const html = renderToStaticMarkup(createElement(DonePanel, { feedback, withdrawn: true }));
    expect(html).not.toContain('submitted for human review');
  });

  it('keeps the promise that nothing counts against them', () => {
    const html = renderToStaticMarkup(createElement(DonePanel, { feedback, withdrawn: true }));
    expect(html).toContain('will not count against you');
  });
});

describe('ParticipantsRail', () => {
  it('names the interviewer without an AI tag on the tile', () => {
    const html = renderToStaticMarkup(createElement(ParticipantsRail, railProps()));
    const tile = html.slice(html.indexOf('data-testid="room-interviewer"'), html.indexOf('room-tile-you'));
    expect(tile).not.toMatch(/AI interviewer/i);
  });

  it('keeps the AI disclosure in the captured-facts note', () => {
    const html = renderToStaticMarkup(createElement(ParticipantsRail, railProps()));
    expect(html).toContain('Maya is an AI interviewer.');
  });

  it('shows no observer tile when nobody is observing', () => {
    const html = renderToStaticMarkup(createElement(ParticipantsRail, railProps()));
    expect(html).not.toContain('room-tile-observer');
  });

  it('shows an observer who is present', () => {
    const html = renderToStaticMarkup(createElement(ParticipantsRail, railProps({ observers: [{ name: 'Jordan Lee' }] })));
    expect(html).toContain('Hiring team · observing silently');
  });
});

describe('room stylesheet', () => {
  it('keeps words not yet spoken readable', async () => {
    const { readFileSync } = await import('node:fs');
    const css = readFileSync(new URL('../src/styles/room.css', import.meta.url), 'utf8');
    const rule = css.match(/\.room-word\.is-pending\s*\{[^}]*opacity:\s*([\d.]+)/);
    expect(Number(rule?.[1])).toBeGreaterThanOrEqual(0.5);
  });
});
