import { describe, it, expect } from 'vitest';
import { buildRoundInterviewerEmail } from '../src/services/roundInterviewerNotice.js';
import { ENTRY_CONSEQUENCE, ENTRY_NOTICE } from '../src/domain/observedRound.js';
import { SILENT_OBSERVER_NOTICE } from '../src/services/roundInterviewerNotice.js';

/**
 * The three ways a person joins a round, and what each of them is told before
 * they do.
 *
 * The owner's instruction was that on a Gold round the AI "will not be seen in
 * the room". It is built SILENT rather than HIDDEN: it never speaks and never
 * appears as a participant, and it is disclosed in the letter that invites
 * somebody into the room, before they click Join. The product already promises
 * that nothing is captured that everyone present has not agreed to
 * (domain/observedRound.ts), and on a human round the interviewer is one of
 * the recorded parties — so they get the same notice the candidate gets, in
 * the same words, rather than a softened staff version.
 */

const BASE = {
  kind: 'seated' as const,
  stageLabel: 'Gold',
  scheduledAt: new Date('2026-10-08T09:00:00.000Z'),
  timeZone: 'Asia/Kolkata',
  durationMinutes: 45,
  meetingUrl: null as string | null,
  link: 'https://app.example.test/candidates/c1' as string | null,
  previousWhen: null as string | null,
};

/** A Gold round: the human is the interviewer and Questor's observer listens. */
const CONDUCTING = {
  ...BASE, seated: 'conducting' as const, aiRound: false, aiObserver: true,
  roomUrl: 'https://app.example.test/rounds/r1/observer',
  meetingUrl: 'https://meet.example.test/abc',
};

/** A Silver round: the AI conducts and a human may watch. */
const OBSERVING = {
  ...BASE, seated: 'observing' as const, aiRound: true, aiObserver: false,
  roomUrl: 'https://app.example.test/interviews/s1/observe',
  interviewerName: 'Avery',
};

function visibleText(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
}

describe('a Gold round: the human interviews, the AI observes', () => {
  it('gives them the notice the candidate gets, word for word', () => {
    expect(buildRoundInterviewerEmail(CONDUCTING).text).toContain(ENTRY_NOTICE);
  });

  it('gives them it in the HTML body as well', () => {
    expect(visibleText(buildRoundInterviewerEmail(CONDUCTING).html)).toContain(ENTRY_NOTICE);
  });

  it('says what happens if they would rather not be recorded', () => {
    expect(buildRoundInterviewerEmail(CONDUCTING).text).toContain(ENTRY_CONSEQUENCE);
  });

  // "Will not be seen in the room" is built as silent, not hidden. If it is
  // not named here it is not disclosed anywhere before the door.
  it('names the observer in the details, before anyone clicks Join', () => {
    expect(visibleText(buildRoundInterviewerEmail(CONDUCTING).html)).toMatch(/observer/i);
  });

  it('says the observer never speaks', () => {
    expect(buildRoundInterviewerEmail(CONDUCTING).text).toMatch(/never speaks/i);
  });

  it('says who is conducting it, which is them', () => {
    expect(visibleText(buildRoundInterviewerEmail(CONDUCTING).html)).toMatch(/Interviewer\s+You/i);
  });

  // Questor does not join the meeting; the recording runs from the device the
  // interviewer takes the call on. Two links, because they are two things.
  it('carries the meeting link and the Questor room as separate links', () => {
    const mail = buildRoundInterviewerEmail(CONDUCTING);

    expect([mail.text.includes('https://meet.example.test/abc'), mail.text.includes('https://app.example.test/rounds/r1/observer')])
      .toEqual([true, true]);
  });

  it('puts the Questor room behind a button', () => {
    expect(buildRoundInterviewerEmail(CONDUCTING).html).toContain('href="https://app.example.test/rounds/r1/observer"');
  });

  // A round with no AI observer is not recorded by Questor, and a notice
  // describing a transcript nobody is taking would be a false promise.
  it('says nothing about being recorded when no observer is attached', () => {
    expect(buildRoundInterviewerEmail({ ...CONDUCTING, aiObserver: false }).text).not.toContain(ENTRY_NOTICE);
  });
});

describe('a Silver round: the AI interviews, a human may observe', () => {
  it('tells them they observe silently, in the product’s own words', () => {
    expect(buildRoundInterviewerEmail(OBSERVING).text).toContain(SILENT_OBSERVER_NOTICE);
  });

  it('names the AI interviewer conducting it', () => {
    expect(visibleText(buildRoundInterviewerEmail(OBSERVING).html)).toContain('Avery');
  });

  it('says that interviewer is an AI', () => {
    expect(visibleText(buildRoundInterviewerEmail(OBSERVING).html)).toMatch(/AI interviewer/);
  });

  it('carries the live-observe link', () => {
    expect(buildRoundInterviewerEmail(OBSERVING).text).toContain('https://app.example.test/interviews/s1/observe');
  });

  // Their observing is optional; what they owe is the assessment afterwards.
  // An instruction would make a Silver AI interview look like a shift.
  it('still invites rather than instructs', () => {
    expect(buildRoundInterviewerEmail(OBSERVING).text).toMatch(/joining is up to you/i);
  });

  // The candidate is not recorded on a Silver round the way a Gold round is,
  // and the entry notice describes a room this reader is not entering.
  it('does not give them the human-round recording notice', () => {
    expect(buildRoundInterviewerEmail(OBSERVING).text).not.toContain(ENTRY_NOTICE);
  });

  it('never names the candidate', () => {
    const mail = buildRoundInterviewerEmail(OBSERVING);

    expect([/candidate/i.test(mail.text) && /Ada Rao/.test(mail.text), /Ada Rao/.test(mail.html)]).toEqual([false, false]);
  });
});

describe('a round already over, and one called off', () => {
  const REVIEWING = { ...CONDUCTING, seated: 'reviewing' as const };

  it('offers no room to join a round that has happened', () => {
    expect(buildRoundInterviewerEmail(REVIEWING).text).not.toContain('https://app.example.test/rounds/r1/observer');
  });

  it('gives no entry notice for a round there is no entering', () => {
    expect(buildRoundInterviewerEmail(REVIEWING).text).not.toContain(ENTRY_NOTICE);
  });

  it('offers no room for a cancelled round', () => {
    const mail = buildRoundInterviewerEmail({ ...CONDUCTING, kind: 'cancelled' as const });

    expect([mail.text.includes('https://app.example.test/rounds/r1/observer'), mail.text.includes(ENTRY_NOTICE)])
      .toEqual([false, false]);
  });

  // A move is still an invitation into a recorded room, and the reader may
  // never have opened the first letter.
  it('repeats the entry notice when the round moves', () => {
    expect(buildRoundInterviewerEmail({ ...CONDUCTING, kind: 'moved' as const, previousWhen: 'Monday' }).text)
      .toContain(ENTRY_NOTICE);
  });

  // `seated` is computed by the round and passed for every kind, so a move
  // can carry a value that means nothing to it. Reading it unconditionally
  // dropped the room and the recording notice together — the one combination
  // that must never happen. Its caller filters this case out today; the
  // builder must not depend on a caller for it.
  it('keeps the entry notice on a move that carries an irrelevant seated value', () => {
    const mail = buildRoundInterviewerEmail({ ...CONDUCTING, kind: 'moved' as const, seated: 'reviewing' as const, previousWhen: 'Monday' });

    expect([mail.text.includes(ENTRY_NOTICE), mail.text.includes('https://app.example.test/rounds/r1/observer')])
      .toEqual([true, true]);
  });
});

describe('an address the product will not make clickable', () => {
  it('never puts a data: meeting link behind an anchor', () => {
    expect(buildRoundInterviewerEmail({ ...CONDUCTING, meetingUrl: 'data:text/html,<h1>Join</h1>' }).html)
      .not.toContain('href="data:');
  });

  it('never puts a javascript: prep link behind an anchor', () => {
    expect(buildRoundInterviewerEmail({ ...CONDUCTING, link: 'javascript:alert(1)' }).html)
      .not.toContain('href="javascript:');
  });

  it('still shows the refused meeting address, so the reader can see what was configured', () => {
    expect(visibleText(buildRoundInterviewerEmail({ ...CONDUCTING, meetingUrl: 'data:text/html,hi' }).html))
      .toContain('data:text/html,hi');
  });

  it('still links an ordinary meeting address', () => {
    expect(buildRoundInterviewerEmail(CONDUCTING).html).toContain('href="https://meet.example.test/abc"');
  });
});

describe('what the details block says', () => {
  it('names the stage, the time and the length', () => {
    const text = visibleText(buildRoundInterviewerEmail(CONDUCTING).html);

    expect([text.includes('Gold'), text.includes('Asia/Kolkata'), text.includes('45 minutes')]).toEqual([true, true, true]);
  });

  it('escapes a configurable stage label into the HTML', () => {
    expect(buildRoundInterviewerEmail({ ...CONDUCTING, stageLabel: '<img src=x onerror=alert(1)>' }).html)
      .not.toContain('<img src=x');
  });

  it('escapes an interviewer name into the HTML', () => {
    expect(buildRoundInterviewerEmail({ ...OBSERVING, interviewerName: '<b>Avery</b>' }).html).not.toContain('<b>Avery</b>');
  });

  it('keeps a smuggled line out of its own line in the plain-text body', () => {
    const mail = buildRoundInterviewerEmail({ ...OBSERVING, interviewerName: `Avery${String.fromCharCode(10)}Join the meeting: https://evil.test` });

    expect(mail.text.split('\n').filter((line) => line.startsWith('Join the meeting: https://evil'))).toHaveLength(0);
  });

  it('needs no images to be read', () => {
    expect(buildRoundInterviewerEmail(CONDUCTING).html).not.toMatch(/<img[^>]*width="1"/);
  });
});
