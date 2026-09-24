import type { Prisma } from '@prisma/client';
import { parseJson, prisma } from '../db.js';
import type { AuthClaims } from './auth.js';
import { HttpError } from '../middleware/index.js';
import { logAudit } from './audit.js';
import { candidateScope } from './access.js';
import { OPT_IN_YES } from './candidateFeedback.js';
import { feedbackHold, holdReasonTexts, trustSignals, type FeedbackHold, type TrustSignals } from './feedbackHoldModel.js';

/**
 * Held feedback emails: reading the signals when an assessment is stored,
 * showing why a letter waits, keeping it held, and listing what waits — the
 * list is the query a hiring-team inbox reads (GET /api/dashboard/held-feedback).
 * Releasing a held letter is "Send feedback now" (services/autoFeedback.ts).
 */

/** Written for every reconnect by the interview engine (recordRejoin). */
const REJOIN_ACTION = 'interview.rejoined';

/** Whether this interview's letter must wait for a person, from what is on record right now. */
export async function holdFor(sessionId: string, assessmentId: string): Promise<FeedbackHold | null> {
  const [assessment, turns, reconnects] = await Promise.all([
    prisma.assessmentVersion.findUniqueOrThrow({ where: { id: assessmentId }, select: { recommendation: true, confidence: true } }),
    prisma.turn.findMany({ where: { sessionId }, orderBy: { index: 'asc' }, select: { speaker: true, text: true } }),
    prisma.auditEvent.count({ where: { entityType: 'InterviewSession', entityId: sessionId, action: REJOIN_ACTION } }),
  ]);
  return feedbackHold(trustSignals(assessment, turns, reconnects));
}

export function holdJsonOf(hold: FeedbackHold): string {
  return JSON.stringify({ reasons: hold.reasons, signals: hold.signals });
}

interface StoredHold { reasons: string[]; signals: TrustSignals | null }

function readHold(holdJson: string): StoredHold {
  const raw = parseJson<unknown>(holdJson, {});
  const parsed: { reasons?: unknown; signals?: unknown } = raw && typeof raw === 'object' ? raw : {};
  const reasons = Array.isArray(parsed.reasons) ? parsed.reasons.filter((r): r is string => typeof r === 'string') : [];
  const signals = parsed.signals && typeof parsed.signals === 'object' ? parsed.signals as TrustSignals : null;
  return { reasons, signals };
}

export interface HoldView {
  readonly reasons: string[];
  /** One plain sentence per reason, for the hiring team. */
  readonly reasonTexts: string[];
  readonly heldAt: Date | null;
  readonly keptAt: Date | null;
  readonly keptByUserId: string | null;
}

/** Why a letter was held, or null for one that never was. Kept on a released letter as the record. */
export function holdView(row: { holdJson: string; heldAt: Date | null; holdKeptAt: Date | null; holdKeptByUserId: string | null }): HoldView | null {
  if (!row.holdJson) return null;
  const { reasons, signals } = readHold(row.holdJson);
  return {
    reasons,
    reasonTexts: signals ? holdReasonTexts(reasons, signals) : [],
    heldAt: row.heldAt, keptAt: row.holdKeptAt, keptByUserId: row.holdKeptByUserId,
  };
}

/**
 * "Keep holding": a person has looked and decided the letter should not go.
 * It stays unsent, stops asking for attention, and can still be released later.
 */
export async function keepFeedbackHeld(opts: { sessionId: string; userId: string; tenantId: string; now?: Date }): Promise<void> {
  const now = opts.now ?? new Date();
  const row = await prisma.candidateFeedbackEmail.findUnique({ where: { sessionId: opts.sessionId }, select: { id: true, status: true, holdJson: true } });
  // Conditional on HELD and not yet kept, so a release that got there first
  // is not undone and the first person to decide stays on the record.
  const { count } = row
    ? await prisma.candidateFeedbackEmail.updateMany({
      where: { id: row.id, status: 'HELD', holdKeptAt: null },
      data: { holdKeptByUserId: opts.userId, holdKeptAt: now },
    })
    : { count: 0 };
  if (!row || count !== 1) throw new HttpError(409, 'This feedback email is not waiting for a decision: it has been sent, or someone has already chosen to keep it held.');
  await logAudit({
    tenantId: opts.tenantId, actorType: 'user', actorId: opts.userId,
    action: 'feedback.email.hold_kept', entityType: 'InterviewSession', entityId: opts.sessionId,
    after: { reasons: readHold(row.holdJson).reasons, keptAt: now },
  });
}

export interface HeldFeedbackItem {
  readonly sessionId: string;
  readonly assessmentId: string;
  readonly heldAt: string | null;
  readonly kept: boolean;
  readonly reasons: string[];
  readonly reasonTexts: string[];
  readonly candidate: { readonly id: string; readonly name: string };
  readonly role: { readonly id: string; readonly title: string };
}

/**
 * Letters the opt-in promise still allows.
 *
 * Where the candidate was asked, we told them "we only send feedback if you say
 * yes" — so only a recorded yes gets through, and a held letter for anyone else
 * can never be sent and is not a decision worth waking the hiring team for.
 * Whether they were asked is the row's own `optInAsked`, written when the letter
 * was prepared, not the tenant's switch as it stands now: reading the switch
 * here made yesterday's letters change category when an admin touched a setting.
 * The same rule as feedbackEligibility, expressed as a query
 * (services/autoFeedbackModel.ts).
 */
export function optInAllowsSendingWhere(): Prisma.CandidateFeedbackEmailWhereInput {
  const saidYes: Prisma.CandidateFeedbackEmailWhereInput = { session: { feedbackOptIn: { is: { choice: OPT_IN_YES } } } };
  // Never asked, by the row's own record of it, and never emailed the question
  // since: nothing was promised, so the letter is still a live decision.
  const neverAsked: Prisma.CandidateFeedbackEmailWhereInput = {
    optInAsked: false,
    session: { feedbackOptIn: { is: null }, feedbackOptInRequest: { is: null } },
  };
  return { OR: [saidYes, neverAsked] };
}

/**
 * Awaiting a decision: held, nobody has chosen to keep it so, and it is a
 * letter that could still go. A held letter for a candidate who never answered
 * the opt-in question can never be sent, so it is not a decision anyone has to
 * make and it does not belong in the HR-Box queue or the daily digest.
 */
export function awaitingDecisionWhere(
  tenantId: string,
  candidate: Prisma.CandidateWhereInput,
): Prisma.CandidateFeedbackEmailWhereInput {
  return { tenantId, candidate, status: 'HELD', holdKeptAt: null, ...optInAllowsSendingWhere() };
}

export const HELD_LIST_LIMIT = 50;

/**
 * Held letters this user may see, newest first. Object-scoped like every
 * candidate list, so nobody learns of a candidate their lists would hide.
 */
export async function listHeldFeedback(auth: AuthClaims, opts: { includeKept?: boolean } = {}): Promise<{ total: number; items: HeldFeedbackItem[] }> {
  const candidate = await candidateScope(auth) as Prisma.CandidateWhereInput;
  const where: Prisma.CandidateFeedbackEmailWhereInput = opts.includeKept
    ? { tenantId: auth.tenantId, candidate, status: 'HELD' }
    : awaitingDecisionWhere(auth.tenantId, candidate);
  const [total, rows] = await Promise.all([
    prisma.candidateFeedbackEmail.count({ where }),
    prisma.candidateFeedbackEmail.findMany({
      where, orderBy: [{ heldAt: 'desc' }, { id: 'desc' }], take: HELD_LIST_LIMIT,
      select: {
        sessionId: true, assessmentId: true, holdJson: true, heldAt: true, holdKeptAt: true, holdKeptByUserId: true,
        candidate: { select: { id: true, fullName: true } },
        session: { select: { role: { select: { id: true, title: true } } } },
      },
    }),
  ]);
  const items = rows.map((r) => {
    const view = holdView(r);
    return {
      sessionId: r.sessionId, assessmentId: r.assessmentId,
      heldAt: r.heldAt?.toISOString() ?? null, kept: r.holdKeptAt !== null,
      reasons: view?.reasons ?? [], reasonTexts: view?.reasonTexts ?? [],
      candidate: { id: r.candidate.id, name: r.candidate.fullName },
      role: { id: r.session.role.id, title: r.session.role.title },
    };
  });
  return { total, items };
}
