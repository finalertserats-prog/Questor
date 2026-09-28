import { describe, it, expect } from 'vitest';
import { detectCandidateIntent } from '../src/engines/candidateIntent.js';

/**
 * A long answer must not stop the server.
 *
 * One candidate answering with four thousand characters froze the whole
 * process for **35 seconds**, measured end to end against a running server:
 * `/api/health`, asked a quarter of a second into the turn, took 34.8 s to
 * come back. Node is single-threaded, so that is every other tenant's live
 * interview, every page load and the health check a load balancer polls, all
 * stopped by one person typing. The portal allows 120 turns an hour per
 * token, so one invitation buys roughly an hour of stall per hour.
 *
 * It is not a slow path. It is an outage anybody holding an invitation can
 * cause on demand, and a competency interview asks people to talk at length.
 *
 * The cost was catastrophic backtracking in the `whole()` family — a
 * `^PAD(core)TAIL$` shape with nested quantifiers, run against a long string
 * that was never going to match. The reader is now bounded; the transcript is
 * not touched.
 */

// A real long answer: prose, no cue, the shape that actually triggered it.
const longAnswer = (chars: number) => {
  const sentence = 'We rebuilt the ingestion pipeline and I owned the migration plan for it, working with the platform team on the cutover window and the rollback we never needed. ';
  return sentence.repeat(Math.ceil(chars / sentence.length)).slice(0, chars);
};

const timed = (text: string) => {
  const started = performance.now();
  const reading = detectCandidateIntent(text);
  return { ms: performance.now() - started, reading };
};

describe('the time it takes to read one turn', () => {
  it('reads a four-thousand-character answer in well under a second', () => {
    // It took 9.9 s in isolation and 35 s through the server. The budget here
    // is generous on purpose — this is a regression guard, not a benchmark,
    // and it must not go red because the machine was busy.
    const { ms } = timed(longAnswer(4000));
    expect(ms).toBeLessThan(250);
  });

  it('does not get dramatically worse as the answer grows', () => {
    // The failure mode was super-linear: 400 chars was fine, 4,000 was not.
    // Ten times the text must not be a hundred times the work.
    const small = timed(longAnswer(400)).ms;
    const large = timed(longAnswer(8000)).ms;
    expect(large).toBeLessThan(Math.max(60, small * 25));
  });

  it('reads a very long answer at all, rather than refusing it', () => {
    // Bounding the reader must not turn a long answer into a non-answer: the
    // candidate said something, and it is still an answer.
    expect(timed(longAnswer(12_000)).reading.intent).toBe('answer');
  });
});

describe('what a bounded reader must still hear', () => {
  const ESSAY = longAnswer(3000);

  it('hears a request to stop at the start of a long answer', () => {
    expect(detectCandidateIntent(`Can we stop here please. ${ESSAY}`).intent).toBe('stop');
  });

  it('hears a request for a person at the end of a long answer', () => {
    expect(detectCandidateIntent(`${ESSAY} Can I speak to a human instead?`).intent).toBe('human_request');
  });

  it('still reads a long answer that asks for nothing as an answer', () => {
    expect(detectCandidateIntent(ESSAY).intent).toBe('answer');
  });

  /**
   * A GAP THIS CHANGE DID NOT CAUSE AND DOES NOT FIX, recorded because
   * measuring the bound is what exposed it.
   *
   * "…and that is the whole story. Sorry, I have to go now." is read as an
   * answer, not as a stop. `MUST_GO` is anchored with `^`, so a leaving cue is
   * only heard when it OPENS the turn — which is not where a polite person
   * puts it. Verified against the shipped reader before this change: identical
   * on every case here, so the bound altered nothing.
   *
   * Left alone deliberately. Un-anchoring `MUST_GO` is how "I need to go back
   * to 2019 for that one" started ending interviews (audit E3), and that is a
   * considered change with its own corpus, not a rider on an outage fix.
   */
  it('reads a leaving cue at the very end of a long turn the same way it always has', () => {
    const reading = detectCandidateIntent(`${ESSAY} Sorry, I have to go now.`);
    expect(reading.intent).toBe('answer');
  });
});

describe('a whole-message reading is still a whole message', () => {
  it('hears the shortest form', () => {
    expect(detectCandidateIntent('stop').intent).toBe('stop');
  });

  it('hears a padded one', () => {
    expect(detectCandidateIntent('ok, sorry, please stop now thanks').intent).toBe('stop');
  });

  it('does not treat an essay as a whole-message refusal', () => {
    // The bound's whole purpose: "is this message nothing but a stop phrase?"
    // is not a question worth asking of four thousand characters.
    expect(detectCandidateIntent(`${longAnswer(3000)} and that is the whole story.`).intent).toBe('answer');
  });
});

describe('the seam between the two ends cannot invent a request', () => {
  /**
   * The defect a review caught in the first cut of this fix.
   *
   * Reading `first600 + " " + last600` as one string puts two pieces of text
   * beside each other that the candidate never said beside each other. A turn
   * whose first window ends "…I need to" and whose last window opens "stop
   * working on the payroll migration…" then contains "i need to stop", and the
   * interview ends on a sentence nobody wrote. The ends are searched
   * separately for exactly this reason.
   */
  const pad = (chars: number) => 'and then we reviewed the numbers together with the team. '.repeat(40).slice(0, chars);

  it('does not read "I need to" + "stop working on X" across the join as a stop', () => {
    const head = `${pad(580)} I need to`;
    const tail = `stop working on the payroll migration ${pad(560)}`;
    const middle = pad(3000);

    expect(detectCandidateIntent(`${head} ${middle} ${tail}`).intent).toBe('answer');
  });

  it('does not read "can we" + "do this another time" across the join as a postpone', () => {
    const head = `${pad(585)} can we`;
    const tail = `do this another time round for the second cohort ${pad(550)}`;

    expect(detectCandidateIntent(`${head} ${pad(3000)} ${tail}`).intent).toBe('answer');
  });

  it('still hears a real request that sits wholly inside one end', () => {
    // The control: the bound must not be an excuse to stop listening.
    expect(detectCandidateIntent(`${pad(3000)} Can we stop here please.`).intent).toBe('stop');
  });
});
