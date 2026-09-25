import { VERDICT_LABELS, type Verdict } from './verdictVocabulary';

/**
 * What the assessment page says about a verdict before the reviewer commits
 * to it, and what it says afterwards about what happened.
 *
 * Every sentence here is built from facts the server sent — the stage plan,
 * where the candidate stands, and the consequence the server computed through
 * the same function its submit acts by (domain/verdictConsequence.ts). The
 * page does no arithmetic of its own on the journey, because a page that works
 * out the consequence separately is a page that can promise something the
 * submit will not do.
 *
 * Free of React so each sentence is tested on its own
 * (web/tests/verdictFlowModel.test.ts).
 */

/** GET /api/assessments/:id → journey.consequences[n]. */
export interface ConsequenceView {
  readonly verdict: Verdict;
  readonly fromStageKey: string;
  readonly fromStageLabel: string;
  readonly toStageKey: string;
  readonly toStageLabel: string;
  readonly moves: boolean;
  /** The stored decision the journey would end with, or null when it stays open. */
  readonly closes: string | null;
  readonly alreadyDecided: boolean;
}

/** GET /api/assessments/:id → journey. Absent on an older server. */
export interface JourneyView {
  readonly pipelineId: string;
  readonly currentStageKey: string;
  readonly currentStageLabel: string;
  readonly status: string;
  readonly decision: string | null;
  readonly consequences: readonly ConsequenceView[];
  readonly letterWaiting: boolean;
}

export function consequenceFor(journey: JourneyView | null | undefined, verdict: Verdict): ConsequenceView | null {
  return journey?.consequences?.find((c) => c.verdict === verdict) ?? null;
}

export interface ConsequenceCopy {
  /** What pressing the primary button will do, as a question. */
  readonly sentence: string;
  /** The primary button. It names the act, never "Submit". */
  readonly act: string;
  /**
   * Whether "Just record it" means anything different here. It only does when
   * the verdict itself would decide the round; Consider decides nothing, so
   * offering the choice would be offering the same thing twice.
   */
  readonly offersRecordOnly: boolean;
  /** What "Just record it" leaves undone, when it is offered. */
  readonly recordOnlyNote: string;
}

const RECORD = 'Record the verdict';

/**
 * A reviewed interview is an assessed one whatever the verdict says, so a
 * move the reviewer is about to cause is not something "Just record it" can
 * prevent. Saying so is the difference between an honest secondary action and
 * one that quietly does less than its label claims.
 */
function recordOnlyNote(c: ConsequenceView): string {
  const base = 'Writes your verdict and leaves the decision on the round unrecorded.';
  return c.moves ? `${base} The interview still counts as assessed, so ${c.toStageLabel} is where they land either way.` : base;
}

export function consequenceCopy(o: {
  readonly verdict: Verdict;
  readonly consequence: ConsequenceView | null;
  readonly candidate: string;
  readonly letterWaiting: boolean;
}): ConsequenceCopy {
  const word = VERDICT_LABELS[o.verdict];
  const who = o.candidate.trim() || 'this candidate';
  const c = o.consequence;

  // No pipeline for this role: the review still records, and the page says so
  // rather than promising a move it cannot describe.
  if (!c) {
    return {
      sentence: `${word}: record your verdict for ${who}. They have no journey for this role, so nothing else moves.`,
      act: RECORD, offersRecordOnly: false, recordOnlyNote: '',
    };
  }

  if (c.alreadyDecided) {
    return {
      sentence: `${word}: ${who}'s journey has already ended. Your verdict is recorded against the assessment; nothing moves.`,
      act: RECORD, offersRecordOnly: false, recordOnlyNote: '',
    };
  }

  // An email cannot be unsent, so a letter that this review releases is named
  // before the reviewer presses anything, not reported afterwards.
  const letter = o.letterWaiting ? ` The candidate's feedback letter is waiting and goes out with this.` : '';

  if (c.closes) {
    return {
      sentence: `${word}: end ${who}'s journey at ${c.toStageLabel}?${letter}`,
      act: `End the journey at ${c.toStageLabel}`,
      offersRecordOnly: true,
      recordOnlyNote: recordOnlyNote(c),
    };
  }

  if (c.moves) {
    return {
      sentence: `${word}: move ${who} to ${c.toStageLabel} and record the AI round?${letter}`,
      act: `Advance to ${c.toStageLabel}`,
      offersRecordOnly: o.verdict !== 'CONSIDER',
      recordOnlyNote: recordOnlyNote(c),
    };
  }

  return {
    sentence: `${word}: ${who} stays at ${c.toStageLabel}, where the human rounds are. Record the AI round?${letter}`,
    act: RECORD,
    offersRecordOnly: o.verdict !== 'CONSIDER',
    recordOnlyNote: recordOnlyNote(c),
  };
}

// ---------------------------------------------------------------------------
// What happened, once it has
// ---------------------------------------------------------------------------

/** POST /api/assessments/:id/review → journey. Null when there was no pipeline. */
export interface JourneyMove {
  readonly fromStageLabel: string;
  readonly toStageLabel: string;
  readonly moves: boolean;
  readonly closes: string | null;
}

/** The confirmation, in the past tense, for the shared toast. */
export function outcomeSentence(o: {
  readonly verdict: Verdict;
  readonly move: JourneyMove | null;
  readonly candidate: string;
}): string {
  const word = VERDICT_LABELS[o.verdict];
  const who = o.candidate.trim() || 'the candidate';
  if (!o.move) return `${word} recorded for ${who}.`;
  if (o.move.closes) return `${word} recorded. ${who}'s journey ended at ${o.move.toStageLabel}.`;
  if (o.move.moves) return `${word} recorded. ${who} moved from ${o.move.fromStageLabel} to ${o.move.toStageLabel}.`;
  return `${word} recorded. ${who} stays at ${o.move.toStageLabel}.`;
}

// ---------------------------------------------------------------------------
// The export, offered where the verdict was recorded
// ---------------------------------------------------------------------------

export interface ExportOffer {
  readonly available: boolean;
  readonly because: string | null;
}

/**
 * Why the export is not on offer, in words — including who to ask. Hiding the
 * action entirely was the old behaviour, and it left a recruiter believing the
 * product could not do it at all.
 */
export function exportRefusalSentence(offer: ExportOffer | null | undefined): string {
  if (!offer || offer.available) return '';
  if (offer.because === 'no_capability') return 'Only a hiring manager or an admin can export this to your ATS.';
  if (offer.because === 'not_scored') return 'There is no score to export: grading did not complete for this interview.';
  return 'This cannot be exported to your ATS yet.';
}

// ---------------------------------------------------------------------------
// Skills and their evidence
// ---------------------------------------------------------------------------

/** mm:ss into the interview, or null when the source recorded no time. */
export function stamp(ms: number | null | undefined): string | null {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return null;
  const seconds = Math.floor(ms / 1000);
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

export interface EvidenceChipView {
  readonly key: string;
  readonly turnId: string;
  /** mm:ss, or an em dash when the turn carried no time. */
  readonly stamp: string;
  readonly quote: string;
}

export function evidenceChips(
  evidence: readonly { turnId: string; startMs: number; quote: string }[] | null | undefined,
): EvidenceChipView[] {
  return (evidence ?? [])
    .filter((e) => typeof e.turnId === 'string' && e.turnId !== '')
    .map((e, index) => ({ key: `${e.turnId}-${index}`, turnId: e.turnId, stamp: stamp(e.startMs) ?? '—', quote: e.quote }));
}

export interface CaveatSource {
  readonly competencies?: readonly { readonly name: string; readonly notEnoughEvidence: boolean }[] | null;
  readonly limitations?: readonly string[] | null;
}

/**
 * The one line of doubt that belongs beside a recommendation.
 *
 * A recommendation with no caveat reads as a measurement. Where the interview
 * did not reach a competency, saying which one is more use to a reviewer than
 * any prose about confidence — it tells them exactly what they have to decide
 * for themselves. Empty when there is genuinely nothing to qualify; the page
 * then shows nothing rather than inventing reassurance.
 */
export function caveatSentence(result: CaveatSource | null | undefined): string {
  const thin = (result?.competencies ?? []).filter((c) => c.notEnoughEvidence).map((c) => c.name);
  if (thin.length === 1) return `Thin evidence on ${thin[0]} — the interview barely reached it, so weigh that yourself.`;
  if (thin.length > 1) {
    const named = thin.slice(0, 3).join(', ');
    const rest = thin.length > 3 ? `, and ${thin.length - 3} more` : '';
    return `Thin evidence on ${named}${rest} — weigh those yourself.`;
  }
  const limitation = (result?.limitations ?? []).find((l) => typeof l === 'string' && l.trim() !== '');
  return limitation ? limitation.trim() : '';
}

/** Confidence as a row of five ticks, so it is a shape before it is a percentage. */
export function confidenceTicks(confidence: number | null | undefined, ticks = 5): boolean[] {
  const value = typeof confidence === 'number' && Number.isFinite(confidence) ? Math.min(Math.max(confidence, 0), 1) : 0;
  const filled = Math.round(value * ticks);
  return Array.from({ length: ticks }, (_, i) => i < filled);
}

/** "High confidence" and friends — the word beside the ticks. */
export function confidenceWord(confidence: number | null | undefined): string {
  if (typeof confidence !== 'number' || !Number.isFinite(confidence)) return 'Confidence not recorded';
  if (confidence >= 0.75) return 'High confidence';
  if (confidence >= 0.5) return 'Moderate confidence';
  return 'Low confidence';
}

export type MeterCell = 'full' | 'half' | 'empty';

/**
 * The level as a row of cells. Marked with weight rather than a tinted fill,
 * and it never rounds up: 2.5 out of 5 shows two full cells and a half, not
 * three, because a level read as higher than it was is the one error a
 * scorecard must not make.
 */
export function meterCells(level: number | null | undefined, max = 5): MeterCell[] {
  const value = typeof level === 'number' && Number.isFinite(level) ? Math.min(Math.max(level, 0), max) : 0;
  return Array.from({ length: max }, (_, i) => {
    if (value >= i + 1) return 'full';
    return value > i ? 'half' : 'empty';
  });
}

/** "3/5", or what the absence of a level actually means. */
export function levelText(level: number | null | undefined, notEnoughEvidence: boolean, max = 5): string {
  if (notEnoughEvidence) return 'Not enough evidence';
  return typeof level === 'number' && Number.isFinite(level) ? `${level}/${max}` : 'Not graded';
}
