import { describe, it, expect } from 'vitest';
import { anonymiseTranscript, calibrationFromDistance, validateVerdict, MAX_ANSWER_EXCERPT_CHARS, MAX_BODY_CHARS } from '../src/sim/judge.js';
import { MAX_PROMPT_CHARS } from '../src/sim/peers.js';
import { templateRole } from '../src/sim/roleFactory.js';
import { templateCandidate } from '../src/sim/candidateFactory.js';
import type { SimTranscript, SimTurn } from '../src/sim/types.js';

const role = templateRole({ family: 'data_engineering', band: 'senior' });
const candidate = templateCandidate({ role, band: 'senior', strength: 'strong' });

function transcript(turns: SimTurn[], lane: SimTranscript['lane'] = 'questor'): SimTranscript {
  return {
    lane,
    interviewer: lane === 'questor' ? 'questor' : 'gemini',
    candidatePeer: 'codex',
    role,
    candidate,
    turns,
    endedEarly: false,
    durationMs: 1000,
  };
}

describe('anonymiseTranscript', () => {
  it('labels speakers without naming the interviewer', () => {
    const out = anonymiseTranscript(transcript([
      { speaker: 'interviewer', text: 'Tell me about the migration.' },
      { speaker: 'candidate', text: 'I led it.' },
    ]));
    expect(out).toContain('INTERVIEWER:');
    expect(out).toContain('CANDIDATE:');
    expect(out).toContain('Tell me about the migration.');
  });

  it('removes the persona name, which identifies the engine outright', () => {
    const out = anonymiseTranscript(transcript([
      { speaker: 'interviewer', text: "I'm Schranders and I'll be asking the questions." },
      { speaker: 'candidate', text: 'Nice to meet you Schranders.' },
    ]));
    expect(out).not.toMatch(/schranders/i);
  });

  it('removes model self-identification, which identifies the benchmark lane', () => {
    const out = anonymiseTranscript(transcript([
      { speaker: 'interviewer', text: 'As Claude, I would ask about scale.' },
      { speaker: 'candidate', text: 'I am Gemini and I ran that pipeline.' },
    ], 'peer'));
    for (const tell of [/claude/i, /gemini/i, /codex/i, /openai/i, /anthropic/i]) {
      expect(out).not.toMatch(tell);
    }
  });

  it('drops the consent disclosure and the acknowledgement that follows it', () => {
    // Only Lane A opens this way, so leaving it in tells the judge which lane it
    // is reading before it reaches a single question.
    const out = anonymiseTranscript(transcript([
      { speaker: 'interviewer', kind: 'disclosure', text: 'Your voice is transcribed as we talk. Shall we begin?' },
      { speaker: 'candidate', text: 'Yes, I can hear you clearly.' },
      { speaker: 'interviewer', text: 'Tell me about the migration.' },
      { speaker: 'candidate', text: 'I led it.' },
    ]));
    expect(out).not.toMatch(/transcribed/i);
    expect(out).not.toMatch(/hear you clearly/i);
    expect(out).toContain('Tell me about the migration.');
  });

  it('leaves a transcript with no disclosure untouched', () => {
    const turns: SimTurn[] = [
      { speaker: 'interviewer', text: 'What broke last?' },
      { speaker: 'candidate', text: 'The nightly load.' },
    ];
    const out = anonymiseTranscript(transcript(turns, 'peer'));
    expect(out).toContain('What broke last?');
    expect(out).toContain('The nightly load.');
  });

  it('never leaks the lane or the interviewer identity', () => {
    const a = anonymiseTranscript(transcript([{ speaker: 'interviewer', text: 'Same question.' }], 'questor'));
    const b = anonymiseTranscript(transcript([{ speaker: 'interviewer', text: 'Same question.' }], 'peer'));
    expect(a).toBe(b);
  });
});

describe('anonymiseTranscript — prompt bounding', () => {
  it('excerpts a long candidate answer and marks that it did', () => {
    const out = anonymiseTranscript(transcript([
      { speaker: 'candidate', text: 'y'.repeat(5000) },
    ]));
    expect(out.length).toBeLessThan(1200);
    expect(out).toContain('answer truncated for review');
  });

  it('gives a question far more room than an answer, since the question is what is judged', () => {
    // Questions were originally never truncated at all. That had to change: a
    // work-sample question embeds a whole code artefact, and transcripts of them
    // blew the process-argument ceiling and killed the judge call outright. They
    // still get more than twice an answer's budget, and the opening — which is
    // what reveals the level it was pitched at — always survives.
    const question = `Walk me through ${'the migration '.repeat(200)}step by step.`;
    const out = anonymiseTranscript(transcript([{ speaker: 'interviewer', text: question }]));
    expect(out).toContain('Walk me through the migration');
    expect(out.length).toBeGreaterThan(MAX_ANSWER_EXCERPT_CHARS * 2);
    expect(out).toContain('question truncated for review');
  });

  it('leaves a question of ordinary length exactly as it was', () => {
    const question = 'Walk me through, step by step, how that problem reached you.';
    const out = anonymiseTranscript(transcript([{ speaker: 'interviewer', text: question }]));
    expect(out).toContain(question);
    expect(out).not.toContain('truncated');
  });

  it('keeps a long interview under the peer prompt ceiling', () => {
    // 40 turns of 3000 characters is a realistic senior interview and used to
    // produce a judge prompt over the Windows argv limit — every judge call in
    // the sweep died with ENAMETOOLONG before reaching the model.
    const turns: SimTurn[] = [];
    for (let i = 0; i < 20; i++) {
      turns.push({ speaker: 'interviewer', text: `Question ${i} about the platform.` });
      turns.push({ speaker: 'candidate', text: 'z'.repeat(3000) });
    }
    expect(anonymiseTranscript(transcript(turns)).length).toBeLessThan(MAX_PROMPT_CHARS / 2);
  });

  it('leaves a short answer exactly as it was', () => {
    const out = anonymiseTranscript(transcript([{ speaker: 'candidate', text: 'I led the migration.' }]));
    expect(out).toContain('I led the migration.');
    expect(out).not.toContain('truncated');
  });
});

describe('calibrationFromDistance', () => {
  it('scores a perfectly pitched interview top marks', () => {
    expect(calibrationFromDistance(0)).toBe(10);
  });

  it('falls off as the pitch drifts from the candidate', () => {
    expect(calibrationFromDistance(1)).toBeLessThan(calibrationFromDistance(0));
    expect(calibrationFromDistance(2)).toBeLessThan(calibrationFromDistance(1));
    expect(calibrationFromDistance(3)).toBeLessThan(calibrationFromDistance(2));
  });

  it('never goes negative, however far off the pitch is', () => {
    expect(calibrationFromDistance(5)).toBeGreaterThanOrEqual(0);
    expect(calibrationFromDistance(99)).toBeGreaterThanOrEqual(0);
  });
});

describe('validateVerdict', () => {
  const good = {
    pitchedBand: 'senior',
    calibration: 7,
    engagement: 8,
    evidenceYield: 6,
    fairness: 9,
    notes: ['asked about cross-team design'],
    misfitQuestions: [],
  };

  it('accepts a well-formed verdict', () => {
    expect(() => validateVerdict(good)).not.toThrow();
  });

  it('rejects an unknown band, which would silently corrupt the metric', () => {
    expect(() => validateVerdict({ ...good, pitchedBand: 'wizard' })).toThrow();
  });

  it('clamps scores into range rather than trusting the judge', () => {
    const v = validateVerdict({ ...good, calibration: 47, fairness: -5 });
    expect(v.calibration).toBeLessThanOrEqual(10);
    expect(v.fairness).toBeGreaterThanOrEqual(0);
  });

  it('rejects a verdict with no band at all', () => {
    expect(() => validateVerdict({ ...good, pitchedBand: undefined })).toThrow();
  });
});

describe('anonymiseTranscript — hard ceiling', () => {
  it('excerpts a work-sample question that embeds a code artefact', () => {
    // Bounding only answers was not enough: work-sample questions carry whole
    // SQL or Python artefacts, and a transcript of them reached 31,480 chars —
    // past the process-argument ceiling, so the judge died and the cell lost its
    // verdict.
    const artefact = `Let's do a short practical one. ${'SELECT customer_id, COUNT(*) FROM orders GROUP BY 1; '.repeat(60)}`;
    const out = anonymiseTranscript(transcript([{ speaker: 'interviewer', text: artefact }]));
    expect(out.length).toBeLessThan(1100);
    expect(out).toContain('question truncated for review');
    // The opening survives — that is what shows the level it was pitched at.
    expect(out).toContain("Let's do a short practical one.");
  });

  it('keeps even a pathological transcript under the peer prompt ceiling', () => {
    const turns: SimTurn[] = [];
    for (let i = 0; i < 40; i++) {
      turns.push({ speaker: 'interviewer', text: `Q${i} ${'x'.repeat(4000)}` });
      turns.push({ speaker: 'candidate', text: 'y'.repeat(4000) });
    }
    const out = anonymiseTranscript(transcript(turns));
    // The real requirement: body plus the CV, band menu and instructions must
    // clear the process-argument ceiling with room to spare.
    expect(out.length).toBeLessThanOrEqual(MAX_BODY_CHARS + 200);
    expect(out.length + 6000).toBeLessThan(MAX_PROMPT_CHARS);
  });

  it('says so when it drops earlier turns, rather than handing over a silent fragment', () => {
    const turns: SimTurn[] = [];
    for (let i = 0; i < 40; i++) {
      turns.push({ speaker: 'interviewer', text: `Question ${i} ${'x'.repeat(500)}` });
      turns.push({ speaker: 'candidate', text: 'y'.repeat(500) });
    }
    const out = anonymiseTranscript(transcript(turns));
    expect(out).toContain('earlier turns omitted for length');
    // Drops from the start: the close is where the pitch reads clearest.
    expect(out).toContain('Question 39');
  });

  it('leaves a normal-length interview completely untouched', () => {
    const turns: SimTurn[] = [
      { speaker: 'interviewer', text: 'What broke last?' },
      { speaker: 'candidate', text: 'The nightly load.' },
    ];
    const out = anonymiseTranscript(transcript(turns));
    expect(out).not.toContain('truncated');
    expect(out).not.toContain('omitted');
  });
});
