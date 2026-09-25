import { describe, it, expect } from 'vitest';
import {
  blockingDecline, captureConsented, captureLiveness, captureReport, consentOutstanding, ENTRY_NOTICE,
  CAPTURE_SILENCE_MS, firstDecline, hearingCheck, mayEnterRoom, requiredOf, roundBlock, staffPartyFor,
  type ObservationStatus, type ParticipantRef, type RoomRoster,
} from '../src/domain/observedRound.js';

/**
 * The entry gate, tested where it is decided rather than through a route.
 *
 * The property under test throughout is the one the whole design rests on:
 * there is no combination of inputs that admits somebody, or lets capture run,
 * without an affirmative consent for every person the round requires. The
 * refusals matter as much as the single acceptance, so most of these are
 * refusals.
 *
 * "Requires" is computed from the round's SEATS as well as its rows, which is
 * the correction a review of the rebased branch forced: seats and rows drift
 * apart the moment HR swaps an expert or adds a panellist, and a rule that
 * could only see rows could not see the person who had just been seated.
 */

const AT = new Date('2026-09-25T09:00:00.000Z');

function person(
  party: ParticipantRef['party'], consented: boolean, declined = false, over: Partial<ParticipantRef> = {},
): ParticipantRef {
  return {
    party, personId: `${party}-1`,
    consentAt: consented ? AT : null, declinedAt: declined ? AT : null, admittedAt: null, ...over,
  };
}

const CANDIDATE = person('candidate', true);
const INTERVIEWER = person('interviewer', true);
const BOTH = [CANDIDATE, INTERVIEWER];

/** The ordinary round: one seated interviewer, and both of them agreed. */
const SEATED: RoomRoster = { participants: BOTH, seats: ['interviewer-1'] };

const roster = (participants: readonly ParticipantRef[], seats: readonly string[] = []): RoomRoster =>
  ({ participants, seats });

function entry(over: Partial<Parameters<typeof mayEnterRoom>[0]> = {}) {
  return mayEnterRoom({
    status: 'CONSENTED' as ObservationStatus, roster: SEATED, roundStatus: 'SCHEDULED', me: INTERVIEWER, ...over,
  });
}

describe('who the round requires', () => {
  it('always requires the candidate', () => {
    expect(requiredOf(SEATED).some((r) => r.party === 'candidate')).toBe(true);
  });

  /**
   * The hole this rule exists to close.
   *
   * HR seats a second panellist, or swaps in a different expert, after the
   * observation was made. That person has no participant row at all — so a rule
   * reading rows could not see them, while the device in the room hears them
   * perfectly well.
   */
  it('requires somebody seated after the observation was made, with no row of their own', () => {
    const late = requiredOf(roster(BOTH, ['interviewer-1', 'interviewer-2']));

    expect(late.find((r) => r.personId === 'interviewer-2')?.row).toBeNull();
  });

  it('holds the round closed until that late arrival has agreed', () => {
    expect(consentOutstanding(roster(BOTH, ['interviewer-1', 'interviewer-2']))).toEqual(['interviewer']);
  });

  /**
   * Un-seating before anybody joined means the person is not coming, so they
   * stop being required — which is exactly what makes swapping a busy expert
   * work rather than stranding the candidate.
   */
  it('stops requiring somebody whose seat was taken away before the round began', () => {
    const swappedOut = person('interviewer', false, true, { personId: 'interviewer-2' });

    expect(captureConsented(roster([...BOTH, swappedOut], ['interviewer-1']))).toBe(true);
  });

  /**
   * After admission the door only opens one way. Their voice may already be in
   * the recording, and un-requiring them would let a round that a withdrawal
   * correctly blocked be unblocked by quietly dropping them from the panel.
   */
  it('goes on requiring somebody who was in the room, seat or no seat', () => {
    const wasInside = person('interviewer', true, false, { personId: 'interviewer-2', admittedAt: AT });

    expect(requiredOf(roster([...BOTH, wasInside], ['interviewer-1'])).map((r) => r.personId))
      .toContain('interviewer-2');
  });

  it('will not let dropping a withdrawn panellist from the seat unblock the round', () => {
    const withdrew: ParticipantRef = {
      party: 'interviewer', personId: 'interviewer-2', consentAt: null, declinedAt: AT, admittedAt: AT,
    };

    expect(captureConsented(roster([...BOTH, withdrew], ['interviewer-1']))).toBe(false);
  });

  it('still needs an interviewer on a round booked with typed names and nobody seated', () => {
    expect(consentOutstanding(roster([CANDIDATE]))).toEqual(['interviewer']);
  });

  it('accepts whoever took on a round nobody was seated for', () => {
    expect(consentOutstanding(roster(BOTH))).toEqual([]);
  });
});

describe('who has agreed', () => {
  it('names the candidate as outstanding until they have agreed', () => {
    expect(consentOutstanding(roster([INTERVIEWER]))).toEqual(['candidate']);
  });

  it('names the interviewer as outstanding until they have agreed', () => {
    expect(consentOutstanding(roster([CANDIDATE], ['interviewer-1']))).toEqual(['interviewer']);
  });

  it('does not hold the round open for HR, who was never required', () => {
    expect(consentOutstanding(SEATED)).toEqual([]);
  });

  // A Gold round may be booked with two people conducting it. Both are on the
  // same call, so the first one's device hears the second whether or not the
  // second ever opened Questor — one agreement between them is not consent.
  it('holds the round open until EVERY seated interviewer has agreed', () => {
    const second = person('interviewer', false, false, { personId: 'interviewer-2' });

    expect(consentOutstanding(roster([...BOTH, second], ['interviewer-1', 'interviewer-2']))).toEqual(['interviewer']);
  });

  it('opens once both seated interviewers have agreed', () => {
    const second = person('interviewer', true, false, { personId: 'interviewer-2' });

    expect(consentOutstanding(roster([...BOTH, second], ['interviewer-1', 'interviewer-2']))).toEqual([]);
  });

  it('counts a party who declined as not having agreed', () => {
    expect(consentOutstanding(roster([CANDIDATE, person('interviewer', false, true)], ['interviewer-1'])))
      .toEqual(['interviewer']);
  });

  it('reports the person who said no', () => {
    expect(firstDecline([person('candidate', false, true), INTERVIEWER])?.party).toBe('candidate');
  });
});

describe('whether capture may run at all', () => {
  it('allows it only once every required party has agreed', () => {
    expect(captureConsented(SEATED)).toBe(true);
  });

  it('refuses it when nobody has agreed', () => {
    expect(captureConsented(roster([]))).toBe(false);
  });

  it('refuses it when only the interviewer has agreed', () => {
    expect(captureConsented(roster([INTERVIEWER], ['interviewer-1']))).toBe(false);
  });

  it('refuses it while a second seated interviewer has not agreed', () => {
    const second = person('interviewer', false, false, { personId: 'interviewer-2' });

    expect(captureConsented(roster([...BOTH, second], ['interviewer-1', 'interviewer-2']))).toBe(false);
  });

  // An HR colleague declining means they are not coming, not that the
  // candidate's interview is called off. They are still never captured: only
  // the entry gate admits anybody, and it admits nobody who has not agreed.
  it('still allows it when an HR colleague who was never required declined', () => {
    expect(captureConsented(roster([...BOTH, person('hr', false, true)], ['interviewer-1']))).toBe(true);
  });

  it('reports no blocking decline for an HR colleague who said no', () => {
    expect(blockingDecline(roster([...BOTH, person('hr', false, true)], ['interviewer-1']))).toBeNull();
  });

  it('reports the candidate as the blocking decline when they said no', () => {
    expect(blockingDecline(roster([person('candidate', false, true), INTERVIEWER], ['interviewer-1']))?.party)
      .toBe('candidate');
  });
});

describe('a round that cannot go ahead', () => {
  const blocked = (
    participants: readonly ParticipantRef[],
    status: ObservationStatus = 'AWAITING_CONSENT',
    over: Partial<Parameters<typeof roundBlock>[0]> = {},
  ) => roundBlock({ status, roster: roster(participants, ['interviewer-1']), roundStatus: 'SCHEDULED', ...over });

  it('says nothing is in the way while everyone is simply still to answer', () => {
    expect(blocked([person('candidate', false), person('interviewer', false)])).toBeNull();
  });

  it('says why it cannot go ahead when the candidate declined', () => {
    expect(blocked([person('candidate', false, true), INTERVIEWER])?.reason)
      .toContain('The candidate has not agreed to this round being recorded');
  });

  it('gives the reason as a sentence rather than a status code', () => {
    expect(blocked([person('candidate', false, true), INTERVIEWER])?.reason).toMatch(/\.$/);
  });

  it('never leaves a dead end: there is always something a person can do next', () => {
    expect(blocked([person('candidate', false, true), INTERVIEWER])?.nextSteps.length).toBeGreaterThan(0);
  });

  it('does not put the fault on the person who declined', () => {
    const block = blocked([person('candidate', false, true), INTERVIEWER]);
    expect(`${block?.reason} ${block?.nextSteps.join(' ')}`).not.toMatch(/refus|fault|unwilling|blame/i);
  });

  it('distinguishes the interviewer declining from the candidate declining', () => {
    expect(blocked([CANDIDATE, person('interviewer', false, true)])?.reason)
      .toContain('The interviewer has not agreed');
  });

  it('blocks a round whose recording stopped part-way, rather than calling it done', () => {
    expect(blocked(BOTH, 'STOPPED')?.reason).toContain('stopped part-way');
  });

  /**
   * The owner's change (2026-09-25): a round that ran for twenty minutes and
   * was then withdrawn from tells the hiring team a great deal about how to
   * proceed. Burying the partial record would leave them deciding on nothing.
   */
  it('tells HR the partial record exists when something was captured first', () => {
    expect(blocked(BOTH, 'STOPPED', { hasPartialRecord: true })?.reason)
      .toContain('record of what was actually said up to then');
  });

  it('offers reading it as a next step, not only rebooking', () => {
    expect(blocked(BOTH, 'STOPPED', { hasPartialRecord: true })?.nextSteps.join(' '))
      .toContain('Read what was captured');
  });

  it('says plainly when stopping left nothing behind', () => {
    expect(blocked(BOTH, 'STOPPED', { hasPartialRecord: false })?.reason)
      .toContain('Nothing was captured before it stopped');
  });

  it('quotes the reason the person gave, in their own words', () => {
    const block = blocked(BOTH, 'STOPPED', {
      withdrawal: { by: 'candidate', reason: 'I did not know this would be recorded.' },
    });

    expect(block?.reason).toContain('I did not know this would be recorded.');
  });

  it('says who gave the reason, so HR knows who to talk to', () => {
    expect(blocked(BOTH, 'STOPPED', { withdrawal: { by: 'candidate', reason: 'Not today.' } })?.reason)
      .toContain('The candidate gave this reason');
  });

  it('says nothing extra when no reason was given, rather than implying one was withheld', () => {
    expect(blocked(BOTH, 'STOPPED', { withdrawal: { by: 'candidate', reason: '' } })?.reason)
      .not.toMatch(/reason/i);
  });

  it('carries the reason on a decline as well as on a stop', () => {
    const block = blocked([person('candidate', false, true), INTERVIEWER], 'DECLINED', {
      withdrawal: { by: 'candidate', reason: 'I would rather not be recorded.' },
    });

    expect(block?.reason).toContain('I would rather not be recorded.');
  });

  it('stops asking about a round that already ran', () => {
    expect(roundBlock({ status: 'DECLINED', roster: SEATED, roundStatus: 'CANCELLED' })).toBeNull();
  });
});

describe('entering the room', () => {
  it('lets in a consented person once everyone required has agreed', () => {
    expect(entry().allowed).toBe(true);
  });

  it('refuses a person who has not agreed themselves', () => {
    expect(entry({ me: person('interviewer', false) }).allowed).toBe(false);
  });

  it('refuses a person who is not in this round at all', () => {
    expect(entry({ me: null }).allowed).toBe(false);
  });

  it('refuses the interviewer while the candidate has still to agree', () => {
    const decision = entry({
      status: 'AWAITING_CONSENT',
      roster: roster([INTERVIEWER, person('candidate', false)], ['interviewer-1']),
    });
    expect(decision.allowed).toBe(false);
  });

  it('refuses the first interviewer while a colleague seated beside them has not agreed', () => {
    const decision = entry({
      status: 'AWAITING_CONSENT',
      roster: roster(BOTH, ['interviewer-1', 'interviewer-2']),
    });
    expect(decision.allowed).toBe(false);
  });

  it('says the room opens by itself, so waiting is not a dead end either', () => {
    const decision = entry({
      status: 'AWAITING_CONSENT',
      roster: roster([INTERVIEWER, person('candidate', false)], ['interviewer-1']),
    });
    expect(decision.allowed === false && decision.nextSteps.length).toBeGreaterThan(0);
  });

  it('refuses everyone once the candidate has declined, the interviewer included', () => {
    expect(entry({
      status: 'DECLINED',
      roster: roster([INTERVIEWER, person('candidate', false, true)], ['interviewer-1']),
    }).allowed).toBe(false);
  });

  it('refuses a consented HR colleague while the candidate has still to agree', () => {
    const hr = person('hr', true);
    expect(entry({
      status: 'AWAITING_CONSENT', me: hr,
      roster: roster([INTERVIEWER, hr, person('candidate', false)], ['interviewer-1']),
    }).allowed).toBe(false);
  });

  it('refuses entry to a round the team already closed', () => {
    expect(entry({ roundStatus: 'COMPLETED' }).allowed).toBe(false);
  });

  it('refuses entry once the observation has ended', () => {
    expect(entry({ status: 'ENDED' }).allowed).toBe(false);
  });

  it('refuses entry to a round whose recording was stopped', () => {
    expect(entry({ status: 'STOPPED' }).allowed).toBe(false);
  });

  it('lets a consented person rejoin a round already being captured', () => {
    expect(entry({ status: 'LISTENING' }).allowed).toBe(true);
  });
});


describe('who a member of staff is in the room', () => {
  it('calls the person seated on the round the interviewer', () => {
    expect(staffPartyFor({ seated: true, runsTheProcess: false, roundHasSeats: true })).toBe('interviewer');
  });

  it('calls a colleague who runs the process HR, because joining is expected of them', () => {
    expect(staffPartyFor({ seated: false, runsTheProcess: true, roundHasSeats: true })).toBe('hr');
  });

  // A round booked with typed names has nobody seated. Calling the recruiter
  // HR there would leave it with no interviewer, and a round with nobody
  // conducting it can never be entered — so it could never run at all.
  it('treats whoever runs the process as the interviewer when nobody is seated', () => {
    expect(staffPartyFor({ seated: false, runsTheProcess: true, roundHasSeats: false })).toBe('interviewer');
  });

  it('gives no seat to someone who neither conducts the round nor runs the process', () => {
    expect(staffPartyFor({ seated: false, runsTheProcess: false, roundHasSeats: false })).toBeNull();
  });
});

describe('the notice everyone passes', () => {
  it('says the audio itself is not kept', () => {
    expect(ENTRY_NOTICE).toContain('audio itself is never stored');
  });

  it('says nobody in the room is there without having agreed', () => {
    expect(ENTRY_NOTICE).toContain('Nobody enters this room without agreeing');
  });

  it('does not claim the observer judges anyone', () => {
    expect(ENTRY_NOTICE).toContain('does not score, rate, summarise or recommend');
  });
});

/**
 * The two silent failures.
 *
 * Both leave a round that LOOKS observed. The first is at least visibly dead
 * once you ask; the second is worse, because what it produces reads as
 * evidence — a complete transcript of an interview the candidate is missing
 * from. Neither may be detected by anything that needs a microphone, so both
 * rules are pure and tested here.
 */
describe('whether the round is actually being heard', () => {
  const START = new Date('2026-09-25T09:00:00.000Z');
  const at = (ms: number) => new Date(START.getTime() + ms);
  const watch = (over: Partial<Parameters<typeof captureLiveness>[0]> = {}) =>
    captureLiveness({ status: 'LISTENING', lastHeardAt: at(0), startedAt: START, now: at(10_000), ...over });

  it('is live while a device keeps proving it is capturing', () => {
    expect(watch().liveness).toBe('live');
  });

  it('says nothing about a round that is not running', () => {
    expect(watch({ status: 'CONSENTED' })).toEqual({ liveness: 'not_running', warning: '', fixBy: null });
  });

  it('treats a long silence as capture having stopped', () => {
    expect(watch({ now: at(CAPTURE_SILENCE_MS + 1000) }).liveness).toBe('silent');
  });

  it('does not fire on one slow upload', () => {
    expect(watch({ now: at(CAPTURE_SILENCE_MS - 1000) }).liveness).toBe('live');
  });

  it('says a device never arrived when nothing was ever heard', () => {
    expect(watch({ lastHeardAt: null, now: at(CAPTURE_SILENCE_MS + 1000) }).liveness).toBe('never_started');
  });

  // The interviewer is the only person who can reopen a tab or re-grant a
  // microphone, so the warning has to be addressed to them and has to say what
  // to do rather than that something is wrong.
  it('addresses the warning to the person who can fix it', () => {
    expect(watch({ now: at(CAPTURE_SILENCE_MS + 1000) }).fixBy).toBe('interviewer');
  });

  it('names the remedy rather than reporting a fault', () => {
    expect(watch({ now: at(CAPTURE_SILENCE_MS + 1000) }).warning).toMatch(/allow the microphone/i);
  });
});

describe('whether both voices are reaching the device', () => {
  const MINUTE = 60_000;
  const times = <T,>(n: number, make: () => T): T[] => Array.from({ length: n }, make);
  // Speech the device heard well: conversational density, around 13 characters
  // a second of wall clock.
  const heard = () => ({ durationMs: 30_000, chars: 390 });
  // A headset: the device catches the interviewer's question, then thirty-odd
  // seconds of the candidate answering that never reach it.
  const deaf = () => ({ durationMs: 40_000, chars: 90 });

  const round = (minutes: number, stretches: Array<{ durationMs: number; chars: number }>) =>
    ({ elapsedMs: minutes * MINUTE, stretches });

  it('says nothing early on, when a quiet stretch means nothing', () => {
    expect(hearingCheck(round(5, times(8, deaf))).oneSided).toBe(false);
  });

  it('reads a normal two-way round as both voices being heard', () => {
    expect(hearingCheck(round(30, times(40, heard))).oneSided).toBe(false);
  });

  it('spots a round where only the interviewer is reaching the device', () => {
    expect(hearingCheck(round(30, times(20, deaf))).oneSided).toBe(true);
  });

  /**
   * The false alarm the first attempt at this rule produced.
   *
   * A candidate reading a problem, thinking, or working through a coding
   * exercise leaves a long quiet stretch on any device — an average over the
   * round could not tell one of those from twenty, and would have cried wolf
   * on ordinary rounds. It now takes repeated quiet stretches, and most of the
   * round, before anything is said.
   */
  it('does not fire on a round with one long silent stretch in it', () => {
    expect(hearingCheck(round(30, [...times(25, heard), { durationMs: 10 * MINUTE, chars: 40 }])).oneSided).toBe(false);
  });

  it('does not fire on a handful of quiet stretches among plenty of speech', () => {
    expect(hearingCheck(round(30, [...times(25, heard), ...times(5, deaf)])).oneSided).toBe(false);
  });

  it('needs the quiet stretches to repeat, not merely to dominate a short round', () => {
    expect(hearingCheck(round(30, times(3, deaf))).oneSided).toBe(false);
  });

  // A dead capture has its own remedy. Reporting both at once is how neither
  // gets acted on.
  it('leaves a capture that heard nothing at all to the liveness check', () => {
    expect(hearingCheck(round(30, [])).oneSided).toBe(false);
  });

  it('names the actual remedy, because a general warning is not acted on', () => {
    expect(hearingCheck(round(30, times(20, deaf))).warning).toMatch(/headset/i);
  });

  it('puts it on the recording rather than on anyone in the room', () => {
    expect(hearingCheck(round(30, times(20, deaf))).warning).not.toMatch(/fail|fault|wrong|error/i);
  });
});

describe('what a finished round says it captured', () => {
  const report = (over: Partial<Parameters<typeof captureReport>[0]> = {}) =>
    captureReport({ status: 'ENDED', speechCount: 40, captureStatus: 'OK', oneSided: false, ...over });

  it('says nothing about a round still running', () => {
    expect(report({ status: 'LISTENING' }).coverage).toBe('pending');
  });

  it('says plainly when nothing was captured', () => {
    expect(report({ speechCount: 0 }).sentence).toContain('Nothing was captured');
  });

  it('refuses to let a captureless round pass as a normal completed one', () => {
    expect(report({ speechCount: 0 }).sentence).toContain('no transcript');
  });

  it('marks a round with gaps as partly captured', () => {
    expect(report({ captureStatus: 'DEGRADED' }).coverage).toBe('partial');
  });

  it('reports one-sidedness ahead of the gaps, being the worse thing to be told', () => {
    expect(report({ captureStatus: 'DEGRADED', oneSided: true }).coverage).toBe('one_sided');
  });

  it('says a one-sided recording is not a transcript of the interview', () => {
    expect(report({ oneSided: true }).sentence).toContain('not a transcript');
  });

  it('puts it on the recording rather than on anyone in the room', () => {
    expect(report({ oneSided: true }).sentence).not.toMatch(/fault|failed to|should have/i);
  });

  it('says nothing at all about a round that captured everything', () => {
    expect(report()).toEqual({ coverage: 'full', sentence: '' });
  });
});
