import { describe, it, expect } from 'vitest';
import { FIXED_COPY, renderAutoFeedbackEmail, TALK_LINK_PLACEHOLDER } from '../src/providers/email/autoFeedbackEmail.js';
import { buildEvidenceFeedback, MARKER_LABEL, textGuardrailViolations, type FeedbackContent } from '../src/services/feedbackContentModel.js';
import type { AssessmentResult, CompetencyScore, RoleSuccessProfile } from '../src/domain/types.js';

/**
 * The feedback email itself: the layout the owner approved, in tables and
 * inline styles so Gmail, Outlook and Apple Mail all render it, with a plain
 * text body carrying the same sections in the same order.
 */

const CONTENT: FeedbackContent = {
  swot: {
    strengths: ['Hands-on scripting: a 12-market tracker you built and checked yourself.', 'You describe process clearly, step by step, without jargon.'],
    weaknesses: ['Examples usually stop before the result, so the impact is left unsaid.', 'Decisions are described as the team\'s, rarely as yours.'],
    opportunities: ['Your habit of checking before launch is rarer than you think — lead with it.', 'One concrete detail per story would lift every answer.'],
    watchOuts: ['"We" instead of "I" can read as a smaller part than you had.', 'Long answers drift; the strongest point often arrives last.'],
  },
  competencies: [
    {
      id: 'prog', name: 'Survey programming', marker: 'strength',
      roleAsks: 'Scripting complex questionnaires and catching logic errors before fieldwork.',
      whatWeHeard: 'A 12-market tracker scripted and checked by you, with two testers before launch.',
      quote: 'I planned a 12-market tracker in Decipher, scripted it myself, and set up checks with two testers before anything went live.',
      toGoFurther: 'Name the errors those checks caught and what they would have cost in field.',
    },
    {
      id: 'pm', name: 'Project management', marker: 'partly',
      roleAsks: 'Owning delivery end to end: timelines, client and field coordination, and handling change.',
      whatWeHeard: 'A deadline that moved a week earlier, and your call to cut the pilot to two markets.',
      quote: 'The client moved the deadline up by a week, so I cut the pilot to two markets and briefed the field team early.',
      toGoFurther: 'Say what the change cost or saved, and what you would do differently.',
    },
    {
      id: 'tools', name: 'Survey tools', marker: 'not-covered',
      roleAsks: 'Depth across the platforms the team uses, and knowing where each one stops.',
      whatWeHeard: 'This did not come up in the time we had, so there is nothing here either way.',
      quote: '',
      toGoFurther: 'Prepare one short story per platform: a limit you hit, and how you worked around it.',
    },
  ],
  nextSteps: [
    'Add the ending to three stories: what changed, in numbers where you have them.',
    'Re-tell one story out loud, naming your own decisions.',
    'Keep a two-sentence story ready for each tool on your CV.',
  ],
};

function render(over: Partial<Parameters<typeof renderAutoFeedbackEmail>[0]> = {}) {
  return renderAutoFeedbackEmail({
    to: 'jayesh@example.test', candidateName: 'Dr. Jayesh Rahul', roleTitle: 'Project Manager',
    companyName: 'Acme Research', content: CONTENT, talkUrl: null,
    interviewedAt: new Date('2026-09-20T09:00:00.000Z'), timeZone: 'Asia/Kolkata', durationMinutes: 30, signOff: 'questor', ...over,
  });
}

describe('the header band', () => {
  it('thanks the candidate for the interview in the subject', () => {
    expect(render().message.subject).toBe('Your interview feedback — Project Manager at Acme Research');
  });

  it('names the role and the company', () => {
    expect(render().message.html).toContain('Project Manager · Acme Research');
  });

  it('names the candidate, the date and how long it took', () => {
    expect(render().message.html).toContain('Jayesh · interviewed 20 September 2026 (Asia/Kolkata) · 30 minutes');
  });

  it('dates the interview in the given zone, not UTC', () => {
    // 20:45 UTC on the 21st is 02:15 on the 22nd in Kolkata.
    const late = new Date('2026-09-21T20:45:00.000Z');
    expect(render({ interviewedAt: late }).message.text).toContain('interviewed 22 September 2026 (Asia/Kolkata)');
  });

  it('dates the interview in a zone west of UTC as that zone reads it', () => {
    // 01:00 UTC on the 22nd is still the evening of the 21st in New York.
    const evening = new Date('2026-09-22T01:00:00.000Z');
    expect(render({ interviewedAt: evening, timeZone: 'America/New_York' }).message.html).toContain('interviewed 21 September 2026 (America/New_York)');
  });

  it('greets them by first name', () => {
    expect(render().message.text).toContain('Hi Jayesh,');
  });

  it('says plainly that this describes the interview only', () => {
    expect(render().message.text).toMatch(/describes the interview itself/i);
  });
});

describe('at a glance', () => {
  it('has a row for every competency', () => {
    for (const c of CONTENT.competencies) expect(render().message.html).toContain(c.name);
  });

  it('marks each row in words', () => {
    const html = render().message.html;
    for (const label of [MARKER_LABEL.strength, MARKER_LABEL.partly, MARKER_LABEL['not-covered']]) {
      expect(html).toContain(label);
    }
  });

  it('draws the bars as table cells, with no image or SVG', () => {
    expect(render().message.html).not.toMatch(/<img|<svg/i);
  });

  it('draws four segments for every row', () => {
    // Four cells per bar, one bar per competency.
    expect(render().message.html.match(/height="9"/g)).toHaveLength(CONTENT.competencies.length * 4);
  });

  it('explains what "not covered" means', () => {
    expect(render().message.text).toMatch(/did not come up, not that anything was wrong/i);
  });

  it('says how long the conversation had', () => {
    expect(render().message.text).toContain('30 minutes');
  });
});

describe('the four-box summary', () => {
  it.each(['Strengths', 'Worth working on', 'Opportunities', 'Worth being aware of'])('has a %s quarter', (heading) => {
    expect(render().message.html).toContain(heading);
  });

  /**
   * "Weaknesses" and "Threats" are the textbook SWOT words, and they are the
   * wrong words to send a person who has just been interviewed: one names the
   * candidate as deficient, the other names them as a danger. Both read as a
   * finding about the person rather than about one conversation, which is also
   * how they become evidence in a discrimination claim. The quarters keep their
   * places and their data keys; only what the candidate reads changes.
   */
  it.each(['Weakness', 'Threat', 'Watch-out', 'SWOT'])('never shows the candidate the word %s', (word) => {
    const { message } = render();
    expect(message.html).not.toMatch(new RegExp(word, 'i'));
    expect(message.text).not.toMatch(new RegExp(word, 'i'));
  });

  it('carries every bullet in the text body too', () => {
    const text = render().message.text;
    for (const bullet of [...CONTENT.swot.strengths, ...CONTENT.swot.weaknesses, ...CONTENT.swot.opportunities, ...CONTENT.swot.watchOuts]) {
      expect(text).toContain(bullet);
    }
  });
});

describe('what the role asks, and what we heard', () => {
  it.each(['The role asks for', 'What we heard', 'Your words', 'To go further'])('labels %s', (label) => {
    expect(render().message.html).toContain(label);
  });

  it("prints the candidate's own words", () => {
    expect(render().message.html).toContain('scripted it myself');
  });

  it('leaves "Your words" out where nothing came up', () => {
    // Two quotes among three competencies, in both bodies.
    expect(render().message.text.match(/Your words:/g)).toHaveLength(2);
  });

  it('still says what the role asks for something that did not come up', () => {
    expect(render().message.text).toContain('Depth across the platforms the team uses');
  });
});

describe('the closing sections', () => {
  it('numbers the next steps', () => {
    const text = render().message.text;
    expect(text).toContain('1. Add the ending to three stories');
    expect(text).toContain('3. Keep a two-sentence story ready');
  });

  it('says what happens next without promising anything', () => {
    expect(render().message.text).toMatch(/What happens next/i);
  });

  // The template's own words get the same sweep as the model's: a promise or
  // a verdict is no better for being hard-coded.
  it.each(FIXED_COPY.map((line) => [line.slice(0, 40), line] as const))('keeps its own fixed wording within the guardrails: %s', (_head, line) => {
    expect(textGuardrailViolations(line)).toEqual([]);
  });

  it('offers to speak to a person when a link was issued', () => {
    expect(render({ talkUrl: 'https://questor.example/talk-to-a-person/abc' }).message.text)
      .toContain('https://questor.example/talk-to-a-person/abc');
  });

  it('writes the link out in the HTML as well as linking it', () => {
    const html = render({ talkUrl: 'https://questor.example/talk-to-a-person/abc' }).message.html;
    expect(html).toContain('If the button does not work');
  });

  it('leaves the offer out entirely when no link could be issued', () => {
    expect(render().message.text).not.toMatch(/speak to someone/i);
  });

  it('never stores the working link in the record of what was sent', () => {
    expect(render({ talkUrl: 'https://questor.example/talk-to-a-person/abc' }).storedText).not.toContain('/talk-to-a-person/abc');
  });

  it('marks where the link was in that record', () => {
    expect(render({ talkUrl: 'https://questor.example/talk-to-a-person/abc' }).storedText).toContain(TALK_LINK_PLACEHOLDER);
  });

  it('records exactly the plain-text body when there was no link', () => {
    const rendered = render();
    expect(rendered.storedText).toBe(rendered.message.text);
  });
});

describe('who it comes from', () => {
  it('signs as Questor by default', () => {
    expect(render().message.text).toContain('The Questor team');
  });

  it('says on whose behalf it was sent', () => {
    expect(render().message.html).toContain('Sent on behalf of Acme Research · Questor');
  });

  it('signs as the organisation when they have asked to', () => {
    expect(render({ signOff: 'company' }).message.text).toContain('The Acme Research hiring team');
  });

  it('drops Questor from the footer when the organisation signs it', () => {
    const html = render({ signOff: 'company' }).message.html;
    expect(html).toContain('Sent on behalf of Acme Research');
    expect(html).not.toContain('· Questor');
  });
});

describe('safety of the rendered message', () => {
  it('escapes whatever a point contains before it reaches the HTML', () => {
    const hostile: FeedbackContent = { ...CONTENT, swot: { ...CONTENT.swot, strengths: ['You said "<script>alert(1)</script>" clearly.', CONTENT.swot.strengths[1]] } };
    expect(render({ content: hostile }).message.html).not.toContain('<script>');
  });

  it('keeps a newline in the role title out of the subject', () => {
    expect(render({ roleTitle: 'Project\nManager' }).message.subject).not.toMatch(/\n/);
  });

  it('does not mention AI anywhere', () => {
    const { text, html } = render().message;
    expect(`${text}\n${html}`).not.toMatch(/\bAI\b|artificial intelligence|automated/i);
  });

  it('reads sensibly when the interview date is unknown', () => {
    expect(render({ interviewedAt: null }).message.html).toContain('Jayesh · 30 minutes');
  });
});

function competency(id: string, name: string, level: number | null, requiredLevel: number, quote: string): CompetencyScore {
  return {
    id, name, level, requiredLevel, confidence: 0.8, notEnoughEvidence: level === null,
    evidence: level === null ? [] : [{ turnId: id, startMs: 0, endMs: 1, quote }], rationale: 'Level 4 of 5.', rubricVersion: 'r',
  };
}

function result(recommendation: AssessmentResult['recommendation'], overallScore: number | null, competencies: CompetencyScore[]): AssessmentResult {
  return {
    assessmentVersion: 'A', roleScorecardVersion: 's', recommendation, confidence: 0.66, evidenceCoverage: 0.5,
    overallScore, competencies, strengths: ['4/5 on SQL'], concerns: ['Below the bar'], contradictions: [],
    openQuestions: [], limitations: [], summary: `Scored ${overallScore}/100; ${recommendation}.`,
  };
}

const PROFILE: RoleSuccessProfile = {
  roleContext: '', outcomes: [], responsibilities: [],
  competencies: [{
    id: 'sql', name: 'SQL', definition: 'Writing the queries the reporting stack runs on.', category: 'technical',
    classification: 'essential', weight: 1, requiredLevel: 3, targetLevel: 4, indicators: [], evidenceModes: [],
  }],
  scoringRules: { mustPassCompetencyIds: [], notEnoughEvidencePolicy: 'exclude', passThreshold: 60 },
  policyRules: { prohibitedTopics: [], requiredDisclosures: [], accommodationsEnabled: true, jurisdiction: 'IN' },
  redFlags: [], seniority: 'Mid',
};

// Whatever the assessment concluded, the letter reads the same way: no number,
// no verdict. Quotes are the candidate's own words and are stripped first.
// "your own decisions" is feedback about them; "we decided" would be a verdict.
const DECISION_WORDS = /\b(score[sd]?|scoring|level|rating|rated|recommend\w*|pass(ed)?|fail(ed)?|rank\w*|hire[sd]?|offer|reject\w*|unsuccessful|shortlist\w*|next round|we decided|hiring decision|weight\w*|threshold|other candidates|PROCEED|CONSIDER|DO_NOT_PROGRESS|SCORING_UNAVAILABLE)\b|\d+\s*\/\s*\d+|\d+\s*out of\s*\d+|\d+\s*%/i;

const CASES: ReadonlyArray<readonly [string, AssessmentResult]> = [
  ['a strong interview', result('PROCEED', 91, [competency('sql', 'SQL', 5, 3, 'I rewrote the billing query with a window function.')])],
  ['a mixed interview', result('CONSIDER', 64, [competency('sql', 'SQL', 2, 3, 'I tuned the slowest report by adding an index.')])],
  ['a weak interview', result('DO_NOT_PROGRESS', 22, [competency('sql', 'SQL', 1, 3, 'I have used SELECT statements a few times.')])],
  ['an interview grading could not score', result('SCORING_UNAVAILABLE', null, [competency('sql', 'SQL', null, 3, '')])],
];

describe('the email never carries a score or a decision', () => {
  it.each(CASES)('for %s', (_label, assessment) => {
    const { message } = render({ content: buildEvidenceFeedback({ result: assessment, profile: PROFILE }) });
    expect(message.text.replace(/"[^"]*"/g, '""')).not.toMatch(DECISION_WORDS);
  });
});
