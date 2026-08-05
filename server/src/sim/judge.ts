/**
 * The blind judge.
 *
 * Scores one transcript at a time rather than comparing two side by side. A
 * pairwise judge is more sensitive, but it inherits position bias and it collapses
 * the moment one lane fails — and in a sweep, one lane failing is routine.
 * Independent absolute scores also give the thing this harness exists to produce:
 * a number that can be tracked across runs as the engine changes.
 *
 * Blinding is done properly or it is not worth doing. The persona name, model
 * self-identification and the consent disclosure are all removed, because each
 * one tells the judge which lane it is reading before it reaches a question.
 */
import { BANDS, bandById, bandDistance, type BandId } from './bands.js';
import { callPeerJson, type PeerId } from './peers.js';
import type { JudgeVerdict, SimTranscript } from './types.js';

/** Tells that identify a lane rather than describe an interview. */
const IDENTIFYING_TERMS: RegExp[] = [
  /\bschranders\b/gi,
  /\bquestor\b/gi,
  /\bclaude\b/gi,
  /\bgemini\b/gi,
  /\bcodex\b/gi,
  /\bchatgpt\b/gi,
  /\bgpt-?[0-9.]*\b/gi,
  /\banthropic\b/gi,
  /\bopenai\b/gi,
  /\bantigravity\b/gi,
];

function scrub(text: string): string {
  return IDENTIFYING_TERMS.reduce((t, re) => t.replace(re, 'the interviewer'), text);
}

/**
 * Render a transcript for judging, with everything that identifies its lane
 * removed.
 *
 * The disclosure turn goes because only Lane A produces one: a consent script
 * about voice transcription is a signature, not a question, and judging it as
 * part of the interview would reward or punish a lane for machinery the other
 * lane does not have. The candidate's acknowledgement goes with it, since
 * "yes, I can hear you clearly" is an answer to a question that is no longer
 * there.
 */
/**
 * How much of each candidate answer the judge sees.
 *
 * Answers are excerpted and questions are not, because the judge is scoring the
 * interviewer: "judge the questions, not the answers". An excerpt is still
 * enough to tell whether the next question engaged with what was said.
 *
 * It is also a hard constraint. A peer prompt is passed as a process argument,
 * Windows caps that near 32,767 characters, and a full 40-turn transcript sails
 * past it — which killed every judge call in a sweep and produced a report with
 * no numbers in it. Bounding here is what keeps the prompt under the ceiling
 * that {@link MAX_PROMPT_CHARS} enforces.
 */
export const MAX_ANSWER_EXCERPT_CHARS = 600;

export function anonymiseTranscript(t: SimTranscript, opts: { maxAnswerChars?: number } = {}): string {
  const maxAnswer = opts.maxAnswerChars ?? MAX_ANSWER_EXCERPT_CHARS;
  const lines: string[] = [];
  let skipNextCandidate = false;

  for (const turn of t.turns) {
    if (turn.kind === 'disclosure') {
      skipNextCandidate = true;
      continue;
    }
    if (skipNextCandidate && turn.speaker === 'candidate') {
      skipNextCandidate = false;
      continue;
    }
    skipNextCandidate = false;

    const isCandidate = turn.speaker === 'candidate';
    const scrubbed = scrub(turn.text);
    // Marked when cut, so the judge knows it is reading an excerpt and does not
    // score the candidate down for an answer that merely stops.
    const body = isCandidate && scrubbed.length > maxAnswer
      ? `${scrubbed.slice(0, maxAnswer)} […answer truncated for review]`
      : scrubbed;
    lines.push(`${isCandidate ? 'CANDIDATE' : 'INTERVIEWER'}: ${body}`);
  }
  return lines.join('\n\n');
}

/**
 * Turn "how many bands off was the pitch" into a 0-10 score.
 *
 * Computed here rather than asked of the judge, so the headline metric is
 * arithmetic on the judge's observation instead of the judge's opinion of its
 * own observation. One band out is a real miss but a recoverable one; three is
 * a different interview than the one the candidate turned up for.
 */
export function calibrationFromDistance(distance: number): number {
  return Math.max(0, 10 - Math.abs(distance) * 3.5);
}

const BAND_IDS = new Set<string>(BANDS.map((b) => b.id));

function clampScore(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(10, Math.round(n * 10) / 10));
}

export function validateVerdict(raw: unknown): JudgeVerdict {
  const r = raw as Record<string, unknown>;
  const band = typeof r?.pitchedBand === 'string' ? r.pitchedBand.trim().toLowerCase() : '';
  if (!BAND_IDS.has(band)) throw new Error(`pitchedBand must be one of ${[...BAND_IDS].join(', ')}, got "${String(r?.pitchedBand)}"`);

  return {
    pitchedBand: band as BandId,
    calibration: clampScore(r.calibration),
    engagement: clampScore(r.engagement),
    evidenceYield: clampScore(r.evidenceYield),
    fairness: clampScore(r.fairness),
    notes: Array.isArray(r.notes) ? r.notes.slice(0, 8).map((n) => String(n).slice(0, 400)) : [],
    misfitQuestions: Array.isArray(r.misfitQuestions) ? r.misfitQuestions.slice(0, 8).map((q) => String(q).slice(0, 400)) : [],
  };
}

/** The exact shape wanted back, shown up front and again at the end. */
const JUDGE_TEMPLATE = `{"pitchedBand":"emerging|developing|established|senior|principal|executive","calibration":0,"engagement":0,"evidenceYield":0,"fairness":0,"misfitQuestions":["quoted question that was wrong for the level"],"notes":["short observation quoting the transcript"]}`;

export interface JudgedTranscript {
  verdict: JudgeVerdict;
  /** Bands between where the questions were pitched and where the candidate is. */
  bandDistance: number;
  /** Arithmetic calibration, independent of the judge's own calibration score. */
  objectiveCalibration: number;
  judgedBy: PeerId;
}

/** Score one transcript, blind, against the candidate it was actually for. */
export async function judgeTranscript(opts: {
  transcript: SimTranscript;
  judge: PeerId;
  timeoutMs?: number;
}): Promise<JudgedTranscript> {
  const { transcript, judge } = opts;
  const trueBand = bandById(transcript.candidate.band);
  const body = anonymiseTranscript(transcript);

  const bandMenu = BANDS.map((b) => `- ${b.id}: ${b.label}, works at the ${b.abstraction} level. ${b.evidenceBar}`).join('\n');

  const prompt = [
    // The contract leads. Asked to "audit an interview" and given the format at
    // the end, peers wrote markdown reports with headings and no JSON at all —
    // four of six judgements in a baseline run were lost that way. Stating the
    // output shape before the task sets the frame the model works inside.
    'TASK: score an interview and return a single JSON object. Your entire reply must be that object.',
    'Do not write a report. Do not use markdown headings. Do not explain yourself outside the JSON.',
    '',
    JUDGE_TEMPLATE,
    '',
    'Here is what to score. You did not conduct this interview and have no stake in it.',
    '',
    `Role interviewed for: ${transcript.role.title}`,
    `The candidate's CV:\n${transcript.candidate.resumeText.slice(0, 2000)}`,
    '',
    'Experience bands:',
    bandMenu,
    '',
    `Ground truth: this candidate is ${trueBand.id} (${trueBand.label}).`,
    `Questions at this level SHOULD cover: ${trueBand.askAbout.join('; ')}.`,
    `Questions at this level should NOT cover: ${trueBand.avoid.join('; ')}.`,
    '',
    'The interview:',
    body || '(the interview produced no usable turns)',
    '',
    'Assess it on four things, each 0-10:',
    '- calibration: were the QUESTIONS pitched at the level this candidate actually operates at? Judge the questions, not the answers.',
    '- engagement: did the interviewer engage with what the candidate actually said, or work through a form? Repeating the same question shape is the classic failure.',
    '- evidenceYield: did the interview surface concrete, checkable evidence a hiring manager could act on?',
    '- fairness: was it free of prohibited or irrelevant subject matter, and did it give the candidate a fair chance to show what they can do?',
    '',
    'Also report:',
    '- pitchedBand: which band the QUESTIONS were actually aimed at, whatever the candidate\'s real level is. This is the single most important field: answer it from the questions alone.',
    '- misfitQuestions: quote any question that was wrong for this candidate\'s level, too basic or too senior.',
    '- notes: short observations, each quoting the transcript.',
    '',
    'Be strict. An interview that is merely inoffensive is not a good one.',
    '',
    'Now output the JSON object and nothing else:',
    JUDGE_TEMPLATE,
  ].join('\n');

  const verdict = await callPeerJson(judge, prompt, {
    timeoutMs: opts.timeoutMs,
    validate: validateVerdict,
    responseTemplate: JUDGE_TEMPLATE,
    label: `judgeTranscript(${transcript.lane}/${transcript.candidate.band})`,
  });

  const distance = bandDistance(verdict.pitchedBand, transcript.candidate.band);
  return {
    verdict,
    bandDistance: distance,
    objectiveCalibration: calibrationFromDistance(distance),
    judgedBy: judge,
  };
}
