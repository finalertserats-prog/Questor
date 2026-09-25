import { prisma, parseJsonOptional } from '../db.js';
import type { CvAnchor, InterviewPlan } from '../domain/types.js';
import { assuranceLevelLabel, type AssuranceLevel } from '../domain/identityAssurance.js';
import { recordedIdentityCheck, tenantAssuranceLevel } from './identityAssurance.js';
import { identityCodeStatus } from './identityCode.js';

// The "Identity & integrity" panel on the review page. It reports what the
// checks found and nothing more: there is no verdict, no score, no action, and
// nothing here feeds the assessment. Signals never reject anyone; a person
// reads this and decides.

export type CodeState =
  /** The candidate entered the emailed code. */
  | 'confirmed'
  /** A code applied and was not entered (the interview may have gone ahead some other way). */
  | 'not_confirmed'
  /** The check could not run: this deployment does not deliver email. */
  | 'not_run'
  /** A demo sandbox candidate whose address the demo does not mail. */
  | 'not_run_demo'
  /** Agreed to before identity checks existed, so none was asked for. */
  | 'not_recorded';

export interface IdentityPanel {
  readonly level: { readonly id: AssuranceLevel; readonly label: string };
  readonly code: {
    readonly state: CodeState;
    readonly channel: 'email';
    readonly confirmedAt: string | null;
    readonly attempts: number;
    readonly wrongAttempts: number;
    readonly codesSent: number;
  };
  readonly cvFollowUps: {
    readonly items: ReadonlyArray<{ cvDetail: string; question: string; asked: boolean; answer: string | null }>;
  };
}

interface TurnRow { index: number; speaker: string; text: string; competencyId: string }

/** Each planned CV question, whether it was asked, and the answer that followed it. */
function pairCvFollowUps(anchors: readonly CvAnchor[], turns: readonly TurnRow[]) {
  return anchors.map((anchor) => {
    const askedAt = turns.findIndex((t) => t.speaker === 'agent' && t.text.includes(anchor.question));
    if (askedAt < 0) return { cvDetail: anchor.fact, question: anchor.question, asked: false, answer: null };
    // The answer is what the candidate said next, before the interviewer spoke again.
    const answers: string[] = [];
    for (const t of turns.slice(askedAt + 1)) {
      if (t.speaker === 'agent') break;
      if (t.speaker === 'candidate') answers.push(t.text);
    }
    return { cvDetail: anchor.fact, question: anchor.question, asked: true, answer: answers.length ? answers.join(' ') : null };
  });
}

export async function identityPanelFor(session: { id: string; tenantId: string; consentJson: string }): Promise<IdentityPanel> {
  const [status, level, planRow, turns] = await Promise.all([
    identityCodeStatus(session.id),
    tenantAssuranceLevel(session.tenantId),
    prisma.interviewPlanVersion.findUnique({ where: { sessionId: session.id }, select: { id: true, planJson: true } }),
    prisma.turn.findMany({ where: { sessionId: session.id }, orderBy: { index: 'asc' }, select: { index: true, speaker: true, text: true, competencyId: true } }),
  ]);
  const check = recordedIdentityCheck(session);
  const state: CodeState = !check
    ? 'not_recorded'
    : check.method === 'none'
      ? (check.reason === 'demo_address' ? 'not_run_demo' : 'not_run')
      : status.verifiedAt ? 'confirmed' : 'not_confirmed';
  const plan = planRow
    ? parseJsonOptional<Partial<InterviewPlan>>(planRow.planJson, {}, { model: 'InterviewPlanVersion', id: planRow.id, field: 'planJson' })
    : {};
  const anchors = plan.blocks?.find((b) => b.competencyId === '__resume_validation__')?.cvAnchors ?? [];
  const recordedLevel = check?.level ?? level;
  return {
    level: { id: recordedLevel, label: assuranceLevelLabel(recordedLevel) },
    code: {
      state, channel: 'email', confirmedAt: status.verifiedAt?.toISOString() ?? null,
      attempts: status.attempts, wrongAttempts: status.wrongAttempts, codesSent: status.codesSent,
    },
    cvFollowUps: { items: pairCvFollowUps(anchors, turns) },
  };
}
