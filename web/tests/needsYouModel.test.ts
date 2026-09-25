import { describe, it, expect } from 'vitest';
import {
  bellBadge, bellLabel, clockLabel, closesIn, comingUpState, crewNote, crewSentence, doneLine, greetingFor, kindLine,
  lookedLine, splitComingUp, waitCaption, waitLabel, whyLine,
  type ComingUpItem, type CrewMember, type NeedsYouRow,
} from '../src/components/hrbox/needsYouModel';

const NOW = Date.parse('2026-09-22T06:30:00.000Z'); // 12:00 in Kolkata
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const iso = (ms: number) => new Date(ms).toISOString();

function row(overrides: Partial<NeedsYouRow> = {}): NeedsYouRow {
  return {
    id: 'review:s1', kind: 'review', urgent: false, since: iso(NOW - 3 * HOUR),
    candidate: { id: 'c1', name: 'Arjun Mehta' }, role: { id: 'r1', title: 'Senior Backend Engineer' },
    subject: null, sessionId: 's1', assessmentId: 'a1', facts: {}, openedBy: [],
    action: { label: 'Review', to: '/assessments/a1' },
    ...overrides,
  };
}

/** A round you are seated on, due at `at`. Its clock counts down, not up. */
function startingRow(at: number): NeedsYouRow {
  return row({
    id: 'round_starting:r1', kind: 'round_starting', urgent: true, since: iso(at),
    sessionId: null, assessmentId: null,
    action: { label: 'Join', to: 'https://meet.example.com/room', external: true },
  });
}

function member(overrides: Partial<CrewMember>): CrewMember {
  return { id: 'maya', name: 'Maya', status: 'idle', candidateFirstName: null, at: null, ...overrides };
}

function upcoming(overrides: Partial<ComingUpItem>): ComingUpItem {
  return {
    id: 'x', kind: 'ai', at: iso(NOW + HOUR), timeZone: null, live: false,
    candidate: { id: 'c', name: 'Tomas Garcia' }, role: { id: 'r', title: 'Data Engineer' },
    interviewerId: 'theo', interviewerName: 'Theo', to: '/interviews/x', ...overrides,
  };
}

describe('waits', () => {
  it('says minutes under an hour', () => {
    expect(waitLabel(iso(NOW - 18 * MIN), NOW)).toBe('18 min');
  });

  it('says hours under two days', () => {
    expect(waitLabel(iso(NOW - 26 * HOUR), NOW)).toBe('26 h');
  });

  it('says days after that', () => {
    expect(waitLabel(iso(NOW - 5 * DAY), NOW)).toBe('5 days');
  });

  it('counts an invitation from when it was sent', () => {
    expect(waitCaption('invitation_expiring')).toBe('Sent');
  });

  // Every other row counts up from a wait. This one counts down to a time that
  // has not arrived, and waitLabel clamps a future instant to zero — which
  // would have printed "1 min" for a round a quarter of an hour away.
  it('counts down in minutes to a round that has not started', () => {
    expect(clockLabel(startingRow(NOW + 12 * MIN), NOW)).toBe('in 12 min');
  });

  it('says a round already under way is on now', () => {
    expect(clockLabel(startingRow(NOW - 5 * MIN), NOW)).toBe('now');
  });
});

describe('row copy', () => {
  it('marks an urgent kind as urgent', () => {
    expect(kindLine(row({ kind: 'human_request', urgent: true }), NOW)).toBe('Asked for a person · urgent');
  });

  it('says when an invitation closes', () => {
    expect(kindLine(row({ kind: 'invitation_expiring', facts: { expiresAt: iso(NOW + 2 * DAY) } }), NOW)).toBe('Invitation closes in 2 days');
  });

  it('closes in hours on the last day', () => {
    expect(closesIn(iso(NOW + 5 * HOUR), NOW)).toBe('in 5 h');
  });

  it('tells a seated interviewer the meeting is open', () => {
    expect(whyLine(startingRow(NOW + 5 * MIN))).toBe('You are conducting this. The meeting is open.');
  });

  it('says so plainly when a round about to start has no meeting link', () => {
    const noLink = startingRow(NOW + 5 * MIN);
    expect(whyLine({ ...noLink, action: { label: 'Get ready', to: '/candidates/c1' } })).toContain('No meeting link');
  });

  it('names the interviewer whose assessment is in', () => {
    expect(whyLine(row({ facts: { interviewerName: 'Avery' } }))).toBe("Avery's assessment is in. Your read comes first.");
  });

  it('tells a reader who cannot sign it off that the review is ready for someone else', () => {
    expect(whyLine(row({ canAct: false, facts: { interviewerName: 'Avery' } })))
      .toBe("Avery's assessment is in. Ready for review: you can read it, someone else signs it off.");
  });

  it('says whether an expiring invitation was opened', () => {
    expect(whyLine(row({ kind: 'invitation_expiring', facts: { opened: true } }))).toBe('Opened the link, not started yet.');
  });
});

describe('who else has looked', () => {
  it('says no one yet when nobody has', () => {
    expect(lookedLine([])).toBe('No one yet');
  });

  it('names one colleague by first name', () => {
    expect(lookedLine([{ userId: 'u', name: 'Rahul Verma', initials: 'RV' }])).toBe('Rahul opened it');
  });

  it('names two and counts the rest', () => {
    const people = ['Kavya S', 'Anil K', 'Rahul V'].map((name, i) => ({ userId: String(i), name, initials: 'X' }));
    expect(lookedLine(people)).toBe('Kavya, Anil and 1 more saw it');
  });
});

describe('the greeting', () => {
  it('says good morning before noon', () => {
    expect(greetingFor(9)).toBe('Good morning');
  });

  it('says what the live interviewer is doing and who waits on a read', () => {
    const crew = [member({ id: 'maya', name: 'Maya', status: 'live', candidateFirstName: 'Priya' }), member({ id: 'avery', name: 'Avery', status: 'done', candidateFirstName: 'Arjun' })];
    expect(crewSentence(crew, { total: 1, items: [row({ facts: { interviewerName: 'Avery' } })] })).toBe('Maya is mid-interview with Priya. Avery finished with Arjun and is waiting on your read.');
  });

  it('does not tell a recruiter an interviewer waits on their read, when the sign-off is not theirs', () => {
    const crew = [member({ id: 'avery', name: 'Avery', status: 'done', candidateFirstName: 'Arjun' })];
    expect(crewSentence(crew, { total: 1, items: [row({ canAct: false, facts: { interviewerName: 'Avery' } })] }))
      .toBe('Avery finished with Arjun today.');
  });

  it('counts what needs you when the interviewers are quiet', () => {
    expect(crewSentence([member({})], { total: 5, items: [] })).toBe('Five things need you. Everything else is moving on its own.');
  });

  it('says so plainly when nothing needs you', () => {
    expect(crewSentence([], { total: 0, items: [] })).toBe('Nothing needs you right now. The interviewers will say when something does.');
  });

  it('gives a scheduled interviewer their time on the organisation clock', () => {
    expect(crewNote(member({ status: 'scheduled', at: '2026-09-22T11:00:00.000Z' }), 'Asia/Kolkata')).toBe('16:30');
  });
});

describe('coming up', () => {
  it('splits today from the rest of the week on the organisation clock', () => {
    const items = [upcoming({ id: 'a', at: iso(NOW + HOUR) }), upcoming({ id: 'b', at: iso(NOW + 2 * DAY) })];
    const split = splitComingUp(items, 'Asia/Kolkata', NOW);
    expect([split.today.map((i) => i.id), split.later.map((i) => i.id)]).toEqual([['a'], ['b']]);
  });

  it('keeps a live interview in today', () => {
    expect(splitComingUp([upcoming({ live: true, at: iso(NOW - HOUR) })], 'Asia/Kolkata', NOW).today.length).toBe(1);
  });

  it('says how soon an AI interview starts', () => {
    expect(comingUpState(upcoming({ at: iso(NOW + 5 * HOUR) }), NOW)).toBe('Starts in 5 h');
  });

  it('calls a human round a human round', () => {
    expect(comingUpState(upcoming({ kind: 'human' }), NOW)).toBe('Human round');
  });
});

describe('done recently', () => {
  it('says who reviewed and what they decided', () => {
    expect(doneLine({ id: 'r', kind: 'review_completed', at: iso(NOW), candidate: { id: 'c', name: 'A' }, role: null, by: 'Rahul Verma', outcome: 'PROCEED', to: '/' })).toBe('Rahul Verma reviewed it: proceed');
  });
});

describe('the bell', () => {
  it('shows no number at zero', () => {
    expect(bellBadge(0)).toBe('');
  });

  it('caps the number at 99+', () => {
    expect(bellBadge(140)).toBe('99+');
  });

  it('names the count for a screen reader', () => {
    expect(bellLabel(3)).toBe('3 things need you');
  });
});
