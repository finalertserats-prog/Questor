import { describe, it, expect } from 'vitest';
import { renderAutoFeedbackEmail, TALK_LINK_PLACEHOLDER } from '../src/providers/email/autoFeedbackEmail.js';
import { GENERIC_FEEDBACK, buildEvidenceFeedback, type FeedbackContent } from '../src/services/feedbackContentModel.js';
import type { AssessmentResult, CompetencyScore } from '../src/domain/types.js';

const CONTENT: FeedbackContent = {
  strengths: [
    'You explained how you rewrote the billing query step by step, which made your reasoning easy to follow.',
    'You were specific about the pipeline you owned: "I made recovery idempotent so a rerun was always safe".',
  ],
  develop: [
    'When you talked about working with stakeholders, there was room to say more about how you kept them involved.',
    'On testing, walking through how you decide what to test first would show more of your approach.',
  ],
  suggestions: ['Before your next interview, prepare one example of bringing a sceptical stakeholder along with a change.'],
};

function render(over: Partial<Parameters<typeof renderAutoFeedbackEmail>[0]> = {}) {
  return renderAutoFeedbackEmail({
    to: 'priya.sharma@example.com', candidateName: 'Dr. Priya Sharma', roleTitle: 'Data Engineer',
    companyName: 'Acme Analytics', content: CONTENT, talkUrl: null, ...over,
  });
}

describe('the automatic feedback email', () => {
  it('thanks the candidate for the interview in the subject', () => {
    expect(render().message.subject).toBe('Thank you for your interview for Data Engineer at Acme Analytics');
  });

  it('greets the candidate by first name', () => {
    expect(render().message.text.startsWith('Hi Priya,\n')).toBe(true);
  });

  it('is signed by the company hiring team', () => {
    expect(render().message.text).toContain('Best regards,\nThe Acme Analytics hiring team');
  });

  it('carries the company name and "sent on behalf of" in the HTML', () => {
    expect(render().message.html).toContain('Sent on behalf of Acme Analytics.');
  });

  it('writes every point in the plain-text body as well as the HTML', () => {
    const { text, html } = render().message;
    const escaped = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    for (const point of [...CONTENT.strengths, ...CONTENT.develop, ...CONTENT.suggestions]) {
      expect(text).toContain(point);
      expect(html).toContain(escaped(point));
    }
  });

  it('escapes whatever a point contains before it reaches the HTML', () => {
    const hostile = { ...CONTENT, strengths: ['You said "<script>alert(1)</script>" in a clear way.', CONTENT.strengths[1]] };
    expect(render({ content: hostile }).message.html).not.toContain('<script>');
  });

  it('keeps a newline in the role title out of the subject', () => {
    expect(render({ roleTitle: 'Data\nEngineer' }).message.subject).not.toMatch(/\n/);
  });

  it('does not mention AI anywhere', () => {
    const { text, html } = render().message;
    expect(`${text}\n${html}`).not.toMatch(/\bAI\b|artificial intelligence|automated/i);
  });

  it('offers to speak to a person when a link was issued', () => {
    expect(render({ talkUrl: 'https://questor.example/talk-to-a-person/abc' }).message.text)
      .toContain('https://questor.example/talk-to-a-person/abc');
  });

  it('never stores the working link in the record of what was sent', () => {
    const { storedText } = render({ talkUrl: 'https://questor.example/talk-to-a-person/abc' });
    expect(storedText).not.toContain('/talk-to-a-person/abc');
  });

  it('marks where the link was in the record of what was sent', () => {
    expect(render({ talkUrl: 'https://questor.example/talk-to-a-person/abc' }).storedText).toContain(TALK_LINK_PLACEHOLDER);
  });

  it('records exactly the plain-text body when there was no link', () => {
    const rendered = render();
    expect(rendered.storedText).toBe(rendered.message.text);
  });

  it('leaves the offer out entirely when no link could be issued', () => {
    expect(render().message.text).not.toMatch(/speak to a person/i);
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

// Whatever the assessment concluded, the email reads the same way: no number,
// no verdict. Quotes are the candidate's own words and are allowed to contain
// anything the checks elsewhere let through, so they are stripped first.
const DECISION_WORDS = /\b(score[sd]?|scoring|level|rating|rated|recommend\w*|pass(ed)?|fail(ed)?|rank\w*|hire[sd]?|offer|reject\w*|unsuccessful|shortlist\w*|next round|decision|decided|weight\w*|threshold|other candidates|PROCEED|CONSIDER|DO_NOT_PROGRESS|SCORING_UNAVAILABLE)\b|\d+\s*\/\s*\d+|\d+\s*out of\s*\d+|\d+\s*%/i;

const CASES: ReadonlyArray<readonly [string, AssessmentResult]> = [
  ['a strong interview', result('PROCEED', 91, [
    competency('sql', 'SQL', 5, 3, 'I rewrote the billing query with a window function.'),
    competency('pipes', 'Data pipelines', 4, 3, 'I made the loads idempotent so reruns were safe.'),
  ])],
  ['a mixed interview', result('CONSIDER', 64, [
    competency('sql', 'SQL', 4, 3, 'I tuned the slowest report by adding the right index.'),
    competency('stake', 'Stakeholder management', 2, 3, 'I sent the report and moved on to the next task.'),
  ])],
  ['a weak interview', result('DO_NOT_PROGRESS', 22, [
    competency('sql', 'SQL', 1, 3, 'I have used SELECT statements a few times.'),
    competency('test', 'Testing', 1, 3, 'Someone else usually tested my work.'),
  ])],
  ['an interview grading could not score', result('SCORING_UNAVAILABLE', null, [
    competency('sql', 'SQL', null, 3, ''),
  ])],
];

describe('the email never carries a score or a decision', () => {
  it.each(CASES)('for %s', (_label, assessment) => {
    const { message } = render({ content: buildEvidenceFeedback(assessment) });
    const withoutQuotes = message.text.replace(/"[^"]*"/g, '""');
    expect(withoutQuotes).not.toMatch(DECISION_WORDS);
  });

  it('nor in the generic wording', () => {
    expect(render({ content: GENERIC_FEEDBACK }).message.text).not.toMatch(DECISION_WORDS);
  });
});
