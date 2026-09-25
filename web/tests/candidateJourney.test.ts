import { describe, it, expect } from 'vitest';
import {
  buildJourney, initialsOf, interviewerName, journeyTitle, quoteTiming, DEFAULT_INTERVIEWER,
  type JourneyInput, type JourneyPipeline, type JourneyRound,
} from '../src/components/candidateJourney';

describe('interviewerName', () => {
  it('uses the name the session was conducted under', () => {
    expect(interviewerName('Rasmus')).toBe('Rasmus');
  });

  it('trims a name that arrived padded', () => {
    expect(interviewerName('  Rasmus  ')).toBe('Rasmus');
  });

  // Naming an interviewer the candidate never met is worse than not naming one.
  it('falls back to a plain description when the session does not say', () => {
    expect([interviewerName(null), interviewerName(undefined), interviewerName('   ')])
      .toEqual([DEFAULT_INTERVIEWER, DEFAULT_INTERVIEWER, DEFAULT_INTERVIEWER]);
  });
});

/**
 * The mapping from what the server returns to the four journey columns.
 *
 * Every scenario here is one a recruiter actually meets: a candidate nobody has
 * started yet, one mid-interview, one whose interview is waiting on a person,
 * one part-way through human rounds, and one already decided. The last group
 * covers a role that configured its own stage plan, because stage keys and
 * labels are tenant data — nothing may assume "silver" or "Gold".
 */

const STAGES = [
  { key: 'participation', label: 'Participation', kind: 'intake' },
  { key: 'bronze', label: 'Bronze', kind: 'profile_review' },
  { key: 'silver', label: 'Silver', kind: 'ai_interview' },
  { key: 'gold', label: 'Gold', kind: 'human_interview' },
  { key: 'diamond', label: 'Diamond', kind: 'human_interview' },
] as const;

const CANDIDATE = { id: 'cand-1', fullName: 'Asha Menon', email: 'asha@example.com', roleId: 'role-1' };

const ROLE = {
  title: 'Senior Platform Engineer',
  level: 'Senior',
  context: 'Owns the deployment platform used by every product team.',
  outcomes: ['Cut deploy lead time to under an hour'],
  responsibilities: ['Run the release pipeline'],
  scorecardVersion: 3,
  scorecardStatus: 'approved',
};

function input(over: Partial<JourneyInput> = {}): JourneyInput {
  return {
    candidate: CANDIDATE,
    role: ROLE,
    profile: { skills: ['Kubernetes', 'Go'], totalYears: 9 },
    fit: { overall: 78, confidence: 0.62, missing: ['Terraform'], probes: ['Ask about on-call'] },
    resumeText: 'Asha Menon — platform engineer with nine years of experience.',
    sessions: [],
    sessionMeta: {},
    pipeline: null,
    assessment: null,
    assessmentBlockedReason: null,
    missingEvidence: [],
    candidateFeedback: null,
    ...over,
  };
}

function pipeline(over: Partial<JourneyPipeline> = {}): JourneyPipeline {
  return {
    id: 'pipe-1',
    stages: STAGES,
    currentStageKey: 'participation',
    status: 'ACTIVE',
    decision: null,
    decisionReason: null,
    decidedAtStageKey: null,
    decidedAt: null,
    rounds: [],
    ...over,
  };
}

function round(over: Partial<JourneyRound> = {}): JourneyRound {
  return {
    id: 'round-1',
    stageKey: 'gold',
    conductedBy: 'HUMAN',
    sessionId: null,
    interviewers: ['Hiring manager'],
    scheduledAt: '2026-10-08T09:00:00.000Z',
    status: 'SCHEDULED',
    notes: '',
    completedAt: null,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Small pieces
// ---------------------------------------------------------------------------

describe('initialsOf', () => {
  it('takes the first letter of the first and last name', () => {
    expect(initialsOf('Asha Menon')).toBe('AM');
  });

  it('falls back to a single letter for a one-word name', () => {
    expect(initialsOf('Prince')).toBe('P');
  });

  it('returns a placeholder rather than an empty avatar for a blank name', () => {
    expect(initialsOf('   ')).toBe('?');
  });
});

describe('journeyTitle', () => {
  it('names the role the candidate applied for', () => {
    expect(journeyTitle('Senior Platform Engineer')).toBe('Candidate journey: Senior Platform Engineer');
  });

  it('omits the colon when the role is not known', () => {
    expect(journeyTitle(null)).toBe('Candidate journey');
  });
});

describe('quoteTiming', () => {
  it('reads as a span of minutes and seconds into the interview', () => {
    expect(quoteTiming(492000, 525000)).toBe('08:12–08:45');
  });

  it('shows a single point when the quote has no measured span', () => {
    expect(quoteTiming(492000, 492000)).toBe('08:12');
  });
});

// ---------------------------------------------------------------------------
// The four columns, in sequence
// ---------------------------------------------------------------------------

describe('the journey as a sequence', () => {
  it('is four numbered columns in the concept order', () => {
    const journey = buildJourney(input());

    expect(journey.columns.map((c) => c.key)).toEqual(['onboard', 'ai-interview', 'schedule', 'decision']);
    expect(journey.columns.map((c) => c.step)).toEqual([1, 2, 3, 4]);
  });

  it('marks exactly one column as the current step', () => {
    const journey = buildJourney(input({ pipeline: pipeline({ currentStageKey: 'gold' }) }));

    expect(journey.columns.filter((c) => c.state === 'current')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 1. A candidate nobody has started
// ---------------------------------------------------------------------------

describe('a candidate with no pipeline', () => {
  const journey = buildJourney(input());

  it('puts the candidate at onboarding, since that is all that has happened', () => {
    expect(journey.columns.map((c) => c.state)).toEqual(['current', 'upcoming', 'upcoming', 'upcoming']);
  });

  it('shows the profile card built from the candidate and their role', () => {
    expect(journey.onboard.profile).toMatchObject({
      initials: 'AM', fullName: 'Asha Menon', roleTitle: 'Senior Platform Engineer',
    });
  });

  it('carries the job description from the role scorecard', () => {
    expect(journey.onboard.job.available).toBe(true);
    expect(journey.onboard.job.responsibilities).toEqual(['Run the release pipeline']);
  });

  it('carries the parsed resume and the job-fit result', () => {
    expect(journey.onboard.resume.parsed).toBe(true);
    expect(journey.onboard.resume.skills).toEqual(['Kubernetes', 'Go']);
    expect(journey.onboard.fit.overall).toBe(78);
  });

  it('reports that no AI interview exists rather than inventing a state', () => {
    expect(journey.aiInterview.phase).toBe('none');
    expect(journey.aiInterview.session).toBeNull();
  });

  it('says the pipeline has to be started before human rounds can be scheduled', () => {
    expect(journey.schedule.stages).toEqual([]);
    expect(journey.schedule.note).toMatch(/start the pipeline/i);
  });

  it('records no decision', () => {
    expect(journey.decision.decision.recorded).toBe(false);
  });
});

describe('a candidate whose resume has not been parsed', () => {
  const journey = buildJourney(input({ profile: null, fit: null, resumeText: '' }));

  it('says the resume is missing instead of showing an empty card', () => {
    expect(journey.onboard.resume.parsed).toBe(false);
    expect(journey.onboard.resume.note).toMatch(/no resume/i);
  });

  it('says the job fit has not been scored', () => {
    expect(journey.onboard.fit.scored).toBe(false);
    expect(journey.onboard.fit.overall).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// What the candidate themselves asked for
// ---------------------------------------------------------------------------

describe('a candidate who asked for written feedback', () => {
  const journey = buildJourney(input({
    candidateFeedback: {
      optIn: { choice: 'YES', decidedAt: '2026-10-02T10:00:00.000Z' },
      draft: { status: 'DRAFT', candidateRequested: true, assessmentId: 'assess-1' },
      humanRequest: { requested: false, requestedAt: null },
    },
  }));

  it('says they asked, and when', () => {
    expect(journey.decision.candidateFeedback.answered).toBe(true);
    expect(journey.decision.candidateFeedback.wantsFeedback).toBe(true);
    expect(journey.decision.candidateFeedback.answerLabel).toMatch(/asked us for written feedback/i);
    expect(journey.decision.candidateFeedback.decidedAt).toBe('2026-10-02T10:00:00.000Z');
  });

  it('flags the draft as waiting on a person, and links to it', () => {
    expect(journey.decision.candidateFeedback.draftWaiting).toBe(true);
    expect(journey.decision.candidateFeedback.draftLabel).toMatch(/waiting/i);
    expect(journey.decision.candidateFeedback.draftHref).toBe('/assessments/assess-1');
  });
});

describe('a candidate who declined written feedback', () => {
  const journey = buildJourney(input({
    candidateFeedback: {
      optIn: { choice: 'NO', decidedAt: '2026-10-02T10:00:00.000Z' },
      draft: { status: null, candidateRequested: false, assessmentId: null },
      humanRequest: { requested: false, requestedAt: null },
    },
  }));

  it('says so in words that stop someone emailing them anyway', () => {
    expect(journey.decision.candidateFeedback.wantsFeedback).toBe(false);
    expect(journey.decision.candidateFeedback.answerLabel).toMatch(/declined/i);
    expect(journey.decision.candidateFeedback.answerLabel).toMatch(/do not email/i);
  });

  it('shows nothing waiting on anyone', () => {
    expect(journey.decision.candidateFeedback.draftWaiting).toBe(false);
    expect(journey.decision.candidateFeedback.draftHref).toBeNull();
  });
});

describe('a candidate nobody has asked yet', () => {
  const journey = buildJourney(input());

  it('reports "not asked" as its own outcome rather than as a refusal', () => {
    // These two lead to opposite actions — one means somebody may still offer,
    // the other means nobody may email — so the board must never render them
    // alike. That is how a candidate who said no ends up contacted anyway.
    expect(journey.decision.candidateFeedback.answered).toBe(false);
    expect(journey.decision.candidateFeedback.wantsFeedback).toBe(false);
    expect(journey.decision.candidateFeedback.answerLabel).toMatch(/not a refusal/i);
    expect(journey.decision.candidateFeedback.humanRequested).toBe(false);
  });

  it('says feedback cannot go to them until they say yes', () => {
    expect(journey.decision.candidateFeedback.answerLabel).toMatch(/only sent after they say yes/i);
  });
});

describe('approved feedback for a candidate who has not said yes', () => {
  const approvedFor = (optIn: { choice: string; decidedAt: string } | null) => buildJourney(input({
    candidateFeedback: {
      optIn,
      draft: { status: 'APPROVED', candidateRequested: false, assessmentId: 'assess-1' },
      humanRequest: { requested: false, requestedAt: null },
    },
  }));

  it('is not described as waiting to be sent when nobody asked them', () => {
    expect(approvedFor(null).decision.candidateFeedback.draftLabel).toMatch(/cannot be sent until the candidate says yes/i);
  });

  it('is not described as waiting to be sent when they declined', () => {
    expect(approvedFor({ choice: 'NO', decidedAt: '2026-10-02T10:00:00.000Z' }).decision.candidateFeedback.draftLabel)
      .toMatch(/cannot be sent/i);
  });

  it('is described as waiting to be sent once they said yes', () => {
    expect(approvedFor({ choice: 'YES', decidedAt: '2026-10-02T10:00:00.000Z' }).decision.candidateFeedback.draftLabel)
      .toBe('Approved and waiting to be sent.');
  });
});

describe('a candidate who asked to speak to a person', () => {
  const journey = buildJourney(input({
    candidateFeedback: {
      optIn: { choice: 'YES', decidedAt: '2026-10-02T10:00:00.000Z' },
      draft: { status: 'SENT', candidateRequested: true, assessmentId: 'assess-1' },
      humanRequest: { requested: true, requestedAt: '2026-10-05T12:00:00.000Z' },
    },
  }));

  it('surfaces the request beside the decision, with when they asked', () => {
    expect(journey.decision.candidateFeedback.humanRequested).toBe(true);
    expect(journey.decision.candidateFeedback.humanRequestLabel).toMatch(/speak to a person/i);
    expect(journey.decision.candidateFeedback.humanRequestedAt).toBe('2026-10-05T12:00:00.000Z');
  });

  it('does not describe already-sent feedback as waiting on anyone', () => {
    expect(journey.decision.candidateFeedback.draftWaiting).toBe(false);
    expect(journey.decision.candidateFeedback.draftLabel).toMatch(/sent/i);
  });
});

// ---------------------------------------------------------------------------
// 2. Mid AI interview
// ---------------------------------------------------------------------------

describe('a candidate part-way through the AI interview', () => {
  const journey = buildJourney(input({
    pipeline: pipeline({
      currentStageKey: 'silver',
      rounds: [round({ id: 'r-ai', stageKey: 'silver', conductedBy: 'AI', sessionId: 'sess-1', interviewers: [], scheduledAt: '2026-10-01T09:00:00.000Z' })],
    }),
    sessions: [{ id: 'sess-1', state: 'ASSESSING', scheduledAt: '2026-10-01T09:00:00.000Z', createdAt: '2026-09-30T09:00:00.000Z' }],
    sessionMeta: { 'sess-1': { recommendation: null, assessmentId: null, invited: true } },
  }));

  it('makes the AI interview the current column', () => {
    expect(journey.columns.map((c) => c.state)).toEqual(['done', 'current', 'upcoming', 'upcoming']);
  });

  it('names the stage the AI interview runs at, from the role plan', () => {
    expect(journey.aiInterview.stageLabel).toBe('Silver');
  });

  it('reports it as underway', () => {
    expect(journey.aiInterview.phase).toBe('in-progress');
    expect(journey.aiInterview.awaitingHumanReview).toBe(false);
  });

  it('offers live observation, which is a read-only transcript', () => {
    expect(journey.aiInterview.observeHref).toBe('/interviews/sess-1/observe');
    expect(journey.aiInterview.observeNote).toMatch(/read-only/i);
    expect(journey.aiInterview.observeNote).toMatch(/told/i);
  });

  it('does not offer the transcript until the interview has ended', () => {
    expect(journey.aiInterview.transcriptHref).toBeNull();
  });

  it('carries the scheduled time from the round', () => {
    expect(journey.aiInterview.scheduledAt).toBe('2026-10-01T09:00:00.000Z');
  });
});

describe('the zone a scheduled time was booked in', () => {
  it('travels with the AI interview time', () => {
    const journey = buildJourney(input({
      pipeline: pipeline({ currentStageKey: 'silver', rounds: [] }),
      sessions: [{ id: 'sess-z', state: 'INVITED', scheduledAt: '2026-10-01T09:00:00.000Z', scheduledTimeZone: 'Asia/Kolkata', createdAt: '2026-09-30T09:00:00.000Z' }],
    }));

    expect(journey.aiInterview.scheduledTimeZone).toBe('Asia/Kolkata');
  });

  it('travels with a human round', () => {
    const journey = buildJourney(input({
      pipeline: pipeline({
        currentStageKey: 'gold',
        rounds: [round({ id: 'r-z', stageKey: 'gold', status: 'SCHEDULED', scheduledAt: '2026-10-15T09:00:00.000Z', scheduledTimeZone: 'Europe/London' })],
      }),
    }));

    expect(journey.schedule.stages.flatMap((s) => s.rounds.map((r) => r.scheduledTimeZone))).toEqual(['Europe/London']);
  });

  it('is null for a time booked without one', () => {
    const journey = buildJourney(input({
      pipeline: pipeline({ currentStageKey: 'silver', rounds: [] }),
      sessions: [{ id: 'sess-n', state: 'INVITED', scheduledAt: '2026-10-01T09:00:00.000Z', createdAt: '2026-09-30T09:00:00.000Z' }],
    }));

    expect(journey.aiInterview.scheduledTimeZone).toBeNull();
  });
});

describe('an AI interview that was created but never sent', () => {
  const journey = buildJourney(input({
    pipeline: pipeline({ currentStageKey: 'silver' }),
    sessions: [{ id: 'sess-2', state: 'PROVISIONED', scheduledAt: null, createdAt: '2026-09-30T09:00:00.000Z' }],
    sessionMeta: { 'sess-2': { recommendation: null, assessmentId: null, invited: false } },
  }));

  it('says the invitation has not gone out', () => {
    expect(journey.aiInterview.phase).toBe('not-invited');
    expect(journey.aiInterview.statusNote).toMatch(/invitation/i);
  });

  it('offers neither live observation nor a transcript', () => {
    expect(journey.aiInterview.observeHref).toBeNull();
    expect(journey.aiInterview.transcriptHref).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 3. Awaiting human review
// ---------------------------------------------------------------------------

describe('an AI interview awaiting human review', () => {
  const journey = buildJourney(input({
    pipeline: pipeline({
      currentStageKey: 'silver',
      rounds: [round({ id: 'r-ai', stageKey: 'silver', conductedBy: 'AI', sessionId: 'sess-3', interviewers: [], status: 'COMPLETED' })],
    }),
    sessions: [{ id: 'sess-3', state: 'REVIEW_READY', scheduledAt: null, createdAt: '2026-09-30T09:00:00.000Z' }],
    sessionMeta: { 'sess-3': { recommendation: 'CONSIDER', assessmentId: 'assess-1', invited: true } },
  }));

  it('raises the awaiting-review flag from the interview state, not a guess', () => {
    expect(journey.aiInterview.phase).toBe('awaiting-review');
    expect(journey.aiInterview.awaitingHumanReview).toBe(true);
  });

  it('links to the transcript, which is what exists afterwards', () => {
    expect(journey.aiInterview.transcriptHref).toBe('/interviews/sess-3');
    expect(journey.aiInterview.observeHref).toBeNull();
  });

  it('links to the assessment it produced', () => {
    expect(journey.aiInterview.assessmentHref).toBe('/assessments/assess-1');
  });

  it('carries the recommendation into the decision column', () => {
    expect(journey.decision.recommendation).toBe('CONSIDER');
  });
});

describe('an assessment held behind blind review', () => {
  const journey = buildJourney(input({
    pipeline: pipeline({ currentStageKey: 'silver' }),
    sessions: [{ id: 'sess-4', state: 'REVIEW_READY', scheduledAt: null, createdAt: '2026-09-30T09:00:00.000Z' }],
    sessionMeta: { 'sess-4': { recommendation: 'PROCEED', assessmentId: 'assess-2', invited: true } },
    assessmentBlockedReason: 'Record your independent verdict first.',
  }));

  it('says why the summary is not shown instead of showing nothing', () => {
    expect(journey.decision.assessment.blocked).toBe(true);
    expect(journey.decision.assessment.note).toBe('Record your independent verdict first.');
    expect(journey.decision.assessment.quotes).toEqual([]);
  });

  it('still points at the assessment, since recording a verdict is the way past the gate', () => {
    expect(journey.decision.assessment.href).toBe('/assessments/assess-2');
  });

  it('does not show the AI recommendation beside the gate', () => {
    expect(journey.decision.recommendation).toBeNull();
  });

  it('marks the recommendation as waiting on the reviewer', () => {
    expect(journey.decision.blindReviewPending).toBe(true);
  });
});

describe('an interview list row that left the AI call out for blind review', () => {
  const journey = buildJourney(input({
    pipeline: pipeline({ currentStageKey: 'silver' }),
    sessions: [{ id: 'sess-5', state: 'REVIEW_READY', scheduledAt: null, createdAt: '2026-09-30T09:00:00.000Z' }],
    sessionMeta: { 'sess-5': { blindReviewPending: true, assessmentId: 'assess-5', invited: true } },
  }));

  it('marks the recommendation as waiting on the reviewer', () => {
    expect(journey.decision.blindReviewPending).toBe(true);
  });

  it('has no recommendation to show', () => {
    expect(journey.decision.recommendation).toBeNull();
  });
});

describe('a candidate with more than one interview session', () => {
  const journey = buildJourney(input({
    pipeline: pipeline({
      currentStageKey: 'silver',
      rounds: [round({ id: 'r-ai', stageKey: 'silver', conductedBy: 'AI', sessionId: 'sess-assessed', interviewers: [] })],
    }),
    // Newest first, as the server returns them. The newest is a retake that
    // nobody has sat yet; the round points at the one that was actually assessed.
    sessions: [
      { id: 'sess-retake', state: 'INVITED', scheduledAt: null, createdAt: '2026-10-02T09:00:00.000Z' },
      { id: 'sess-assessed', state: 'REVIEW_READY', scheduledAt: null, createdAt: '2026-09-30T09:00:00.000Z' },
    ],
    sessionMeta: {
      'sess-retake': { recommendation: null, assessmentId: null, invited: true },
      'sess-assessed': { recommendation: 'PROCEED', assessmentId: 'assess-9', invited: true },
    },
  }));

  it('shows the session the AI round points at, not merely the newest', () => {
    expect(journey.aiInterview.session?.id).toBe('sess-assessed');
  });

  it('takes the recommendation from that same session', () => {
    expect(journey.decision.recommendation).toBe('PROCEED');
    expect(journey.decision.assessment.href).toBe('/assessments/assess-9');
  });
});

describe('a role plan with no AI interview stage', () => {
  // The stage schema permits this: at most one AI stage, not at least one.
  const NO_AI = [
    { key: 'applied', label: 'Applied', kind: 'intake' },
    { key: 'screen', label: 'Paper screen', kind: 'profile_review' },
    { key: 'panel', label: 'Panel', kind: 'human_interview' },
  ] as const;

  it('never marks the AI interview step done for an interview that cannot happen', () => {
    const journey = buildJourney(input({ pipeline: pipeline({ stages: NO_AI, currentStageKey: 'panel' }) }));

    expect(journey.columns.map((c) => c.state)).toEqual(['done', 'upcoming', 'current', 'upcoming']);
  });

  it('does not claim an AI interview happened once a decision is recorded', () => {
    const journey = buildJourney(input({
      pipeline: pipeline({ stages: NO_AI, currentStageKey: 'panel', status: 'DECIDED', decision: 'APPROVED', decidedAtStageKey: 'panel' }),
    }));

    expect(journey.aiInterview.state).toBe('upcoming');
    expect(journey.aiInterview.phase).toBe('none');
  });
});

// ---------------------------------------------------------------------------
// 4. Mixed human rounds
// ---------------------------------------------------------------------------

describe('a candidate with mixed human rounds', () => {
  const journey = buildJourney(input({
    pipeline: pipeline({
      currentStageKey: 'diamond',
      rounds: [
        round({
          id: 'r-gold', stageKey: 'gold', status: 'COMPLETED', interviewers: ['Dev Rao', 'Lin Wu'],
          notes: 'Walked through a production incident end to end with a measured outcome.',
          completedAt: '2026-10-08T10:00:00.000Z',
        }),
        round({ id: 'r-gold-2', stageKey: 'gold', status: 'SCHEDULED', interviewers: ['Priya Nair'], scheduledAt: '2026-10-15T09:00:00.000Z' }),
        round({ id: 'r-dia', stageKey: 'diamond', status: 'CANCELLED', interviewers: [], scheduledAt: '2026-10-20T09:00:00.000Z' }),
      ],
    }),
  }));

  it('groups the rounds under the human stages of the role plan, in order', () => {
    expect(journey.schedule.stages.map((s) => s.label)).toEqual(['Gold', 'Diamond']);
    expect(journey.schedule.stages.map((s) => s.rounds.map((r) => r.id))).toEqual([['r-gold', 'r-gold-2'], ['r-dia']]);
  });

  it('keeps each round\'s status as the server recorded it', () => {
    const statuses = journey.schedule.stages.flatMap((s) => s.rounds.map((r) => r.status));
    expect(statuses).toEqual(['COMPLETED', 'SCHEDULED', 'CANCELLED']);
  });

  it('names the interviewers, and says so when none were named', () => {
    const [gold, diamond] = journey.schedule.stages;
    expect(gold.rounds[0].interviewers).toEqual(['Dev Rao', 'Lin Wu']);
    expect(diamond.rounds[0].interviewerNote).toMatch(/not named/i);
  });

  it('offers only the scheduled rounds as ones that can still be completed', () => {
    expect(journey.schedule.openRounds.map((r) => r.id)).toEqual(['r-gold-2']);
  });

  it('says plainly that Questor does not host these rounds', () => {
    expect(journey.schedule.note).toMatch(/does not host/i);
  });

  it('carries the completed round\'s written notes into the evidence column', () => {
    expect(journey.decision.humanNotes.map((n) => n.roundId)).toEqual(['r-gold']);
    expect(journey.decision.humanNotes[0].stageLabel).toBe('Gold');
    expect(journey.decision.humanNotes[0].notes).toMatch(/production incident/);
    expect(journey.decision.humanNotes[0].retained).toBe(true);
  });

  it('marks a stage with nothing scheduled rather than leaving it blank', () => {
    const empty = buildJourney(input({ pipeline: pipeline({ currentStageKey: 'gold' }) }));
    expect(empty.schedule.stages[0].note).toMatch(/no round/i);
  });

  it('says when a completed round\'s notes were cleared by retention', () => {
    const purged = buildJourney(input({
      pipeline: pipeline({
        currentStageKey: 'diamond',
        rounds: [round({ id: 'r-old', status: 'COMPLETED', notes: '', completedAt: '2025-01-01T10:00:00.000Z' })],
      }),
    }));

    expect(purged.decision.humanNotes[0].retained).toBe(false);
    expect(purged.decision.humanNotes[0].notes).toMatch(/retention/i);
  });
});

// ---------------------------------------------------------------------------
// 5. Decided
// ---------------------------------------------------------------------------

describe('a decided candidate', () => {
  const journey = buildJourney(input({
    pipeline: pipeline({
      currentStageKey: 'gold',
      status: 'DECIDED',
      decision: 'APPROVED',
      decisionReason: 'Strongest evidence on incident ownership across both rounds.',
      decidedAtStageKey: 'gold',
      decidedAt: '2026-10-09T12:00:00.000Z',
    }),
    assessment: {
      id: 'assess-3',
      recommendation: 'PROCEED',
      summary: 'Consistent ownership of production systems.',
      competencies: [
        {
          name: 'Incident response', level: 4, requiredLevel: 3, notEnoughEvidence: false,
          evidence: [{ quote: 'I paged myself and ran the rollback.', startMs: 492000, endMs: 525000 }],
        },
        { name: 'Cost awareness', level: null, requiredLevel: 3, notEnoughEvidence: true, evidence: [] },
      ],
    },
    missingEvidence: ['Diamond'],
  }));

  it('makes the decision the current step and everything before it done', () => {
    expect(journey.columns.map((c) => c.state)).toEqual(['done', 'done', 'done', 'current']);
  });

  it('records the outcome, the reason and the stage it was made at', () => {
    expect(journey.decision.decision).toMatchObject({
      recorded: true,
      value: 'APPROVED',
      reason: 'Strongest evidence on incident ownership across both rounds.',
      stageLabel: 'Gold',
    });
  });

  it('states the outcome as the final word on the journey', () => {
    expect(journey.decision.decision.outcome).toBe('Approved at Gold. The journey is complete.');
  });

  it('shows the assessment summary with its evidence quoted and timed', () => {
    expect(journey.decision.assessment.summary).toBe('Consistent ownership of production systems.');
    expect(journey.decision.assessment.quotes).toEqual([
      { competency: 'Incident response', quote: 'I paged myself and ran the rollback.', timing: '08:12–08:45' },
    ]);
  });

  it('names the competencies the interview did not reach', () => {
    expect(journey.decision.assessment.notEnoughEvidence).toEqual(['Cost awareness']);
  });

  it('carries forward the stages Questor holds no evidence for', () => {
    expect(journey.decision.evidenceGaps).toEqual(['Diamond']);
  });

  it('states that the evidence is quoted from the transcript, not recorded audio', () => {
    expect(journey.decision.assessment.evidenceNote).toMatch(/transcript/i);
    expect(journey.decision.assessment.evidenceNote).not.toMatch(/audio recording/i);
  });
});

// ---------------------------------------------------------------------------
// 6. A role with its own stage plan
// ---------------------------------------------------------------------------

describe('a role with its own stage plan', () => {
  const CUSTOM = [
    { key: 'applied', label: 'Applied', kind: 'intake' },
    { key: 'screen', label: 'Paper screen', kind: 'profile_review' },
    { key: 'ai_round', label: 'Conversation with Maya', kind: 'ai_interview' },
    { key: 'panel', label: 'Panel', kind: 'human_interview' },
    { key: 'exec', label: 'Exec chat', kind: 'human_interview' },
  ] as const;

  it('uses the role\'s own labels for the AI stage', () => {
    const journey = buildJourney(input({ pipeline: pipeline({ stages: CUSTOM, currentStageKey: 'ai_round' }) }));

    expect(journey.aiInterview.stageLabel).toBe('Conversation with Maya');
  });

  it('lists the human stages in the plan\'s order, not alphabetically', () => {
    const journey = buildJourney(input({ pipeline: pipeline({ stages: CUSTOM, currentStageKey: 'panel' }) }));

    expect(journey.schedule.stages.map((s) => s.key)).toEqual(['panel', 'exec']);
  });

  it('marks the column that owns the current stage, whatever the stage is called', () => {
    const journey = buildJourney(input({ pipeline: pipeline({ stages: CUSTOM, currentStageKey: 'screen' }) }));

    expect(journey.columns.map((c) => c.state)).toEqual(['current', 'upcoming', 'upcoming', 'upcoming']);
  });

  it('marks each human stage as done, current or upcoming against the plan order', () => {
    const journey = buildJourney(input({ pipeline: pipeline({ stages: CUSTOM, currentStageKey: 'exec' }) }));

    expect(journey.schedule.stages.map((s) => s.state)).toEqual(['done', 'current']);
  });

  it('falls back to the stage key when a round names a stage the plan no longer has', () => {
    const journey = buildJourney(input({
      pipeline: pipeline({
        stages: CUSTOM,
        currentStageKey: 'panel',
        rounds: [round({ id: 'r-ghost', stageKey: 'removed_stage', status: 'COMPLETED', notes: 'A round from an older plan.', completedAt: '2026-10-08T10:00:00.000Z' })],
      }),
    }));

    expect(journey.decision.humanNotes[0].stageLabel).toBe('removed_stage');
  });
});

// ---------------------------------------------------------------------------
// 8. The outcome line
// ---------------------------------------------------------------------------

/**
 * Decisions move the journey on their own (server: domain/pipelineAutonomy.ts).
 * The board reports where that left the candidate in one line — the outcome —
 * so a rejection reads as the end of the journey and an approval as progress.
 */
describe('the outcome line', () => {
  it('says a rejected candidate is not progressing, with no stage after it', () => {
    const journey = buildJourney(input({
      pipeline: pipeline({ currentStageKey: 'gold', status: 'DECIDED', decision: 'REJECTED', decidedAtStageKey: 'gold', decisionReason: 'Missing the core competency.' }),
    }));

    expect([journey.decision.decision.outcome, journey.schedule.stages.map((s) => s.state)])
      .toEqual(['Not progressing. The journey ended at Gold.', ['decided', 'skipped']]);
  });

  it('says a withdrawn candidate withdrew', () => {
    const journey = buildJourney(input({
      pipeline: pipeline({ currentStageKey: 'silver', status: 'DECIDED', decision: 'WITHDRAWN', decidedAtStageKey: 'silver' }),
    }));

    expect(journey.decision.decision.outcome).toBe('The candidate withdrew at Silver. The journey ended there.');
  });

  it('says a candidate approved out of the AI interview is progressing to the next round', () => {
    const journey = buildJourney(input({ pipeline: pipeline({ currentStageKey: 'gold' }) }));

    expect(journey.decision.decision.outcome).toBe('Progressing to the next round: Gold.');
  });

  it('has nothing to say before a pipeline exists', () => {
    expect(buildJourney(input()).decision.decision.outcome).toBeNull();
  });
});
