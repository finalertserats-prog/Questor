import { createHash, randomBytes } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '../db.js';
import { logger } from '../logger.js';
import { HttpError } from '../middleware/index.js';
import { detectInjection } from '../engines/policyEngine.js';
import { screenInjection } from '../library/linter.js';
import { endReasonLabel, stageLabel, type DemoMode } from '../domain/demoInterview.js';

/**
 * What a visitor said about the demo, from the form to the owner's console.
 *
 * TWO THINGS SHAPE THIS FILE.
 *
 * 1. THE TEXT IS A STRANGER'S. It is screened for prompt injection on the way
 *    in, exactly as organisation text typed at signup is, stored as text,
 *    rendered as text, and never placed in a model prompt. Nothing downstream
 *    summarises it, groups it or drafts a reply to it: an injection payload
 *    that reaches no model cannot instruct one.
 *
 * 2. THE FORM OUTLIVES THE SESSION. "End demo" clears the session cookie, so a
 *    feedback form that authenticated as the visitor would be asking a signed
 *    out browser to prove who it was. The row therefore carries a ticket of
 *    its own, minted while they are still signed in, stored hashed, single
 *    use. It is also what lets someone come back to a tab they left open.
 */

/** A day is plenty to say what you thought, and short enough to be forgotten. */
export const TICKET_TTL_MS = 24 * 60 * 60_000;

export const MAX_FEEDBACK_CHARS = 4_000;

function hashTicket(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export interface FeedbackTicket {
  readonly token: string;
  readonly expiresAt: Date;
}

/**
 * Mint (or re-hand) the ticket for this demo's feedback.
 *
 * One unsubmitted row per sitting: asking twice from two tabs gives the same
 * row a new token rather than two rows, so the owner never sees one visitor's
 * single opinion listed twice.
 */
export async function issueFeedbackTicket(input: {
  tenantId: string;
  demoGrantId: string | null;
  runId: string | null;
  mode: DemoMode | 'none';
  stage: string;
  now?: Date;
}): Promise<FeedbackTicket> {
  const now = input.now ?? new Date();
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(now.getTime() + TICKET_TTL_MS);
  const openKey = `${input.tenantId}:${input.demoGrantId ?? 'none'}`;

  // Update-first, then create, and let the unique key settle the race.
  //
  // "Find an open row, else create one" is read-then-write however carefully it
  // is guarded: two End demo presses both find nothing and both create, and
  // the owner reads one visitor's single opinion as two. `openKey` is unique
  // and null once answered, so the database decides.
  const updated = await prisma.demoFeedback.updateMany({
    where: { openKey, submittedAt: null },
    data: { ticketHash: hashTicket(token), ticketExpiresAt: expiresAt, runId: input.runId, mode: input.mode, stage: input.stage },
  });
  if (updated.count === 1) return { token, expiresAt };

  try {
    await prisma.demoFeedback.create({
      data: {
        tenantId: input.tenantId,
        demoGrantId: input.demoGrantId,
        runId: input.runId,
        mode: input.mode,
        stage: input.stage,
        openKey,
        ticketHash: hashTicket(token),
        ticketExpiresAt: expiresAt,
      },
    });
    return { token, expiresAt };
  } catch (err) {
    // A racing press created it first. Take its row over rather than making a
    // second one; the caller gets a working ticket either way.
    if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002')) throw err;
    const retried = await prisma.demoFeedback.updateMany({
      where: { openKey, submittedAt: null },
      data: { ticketHash: hashTicket(token), ticketExpiresAt: expiresAt, runId: input.runId, mode: input.mode, stage: input.stage },
    });
    if (retried.count !== 1) throw new HttpError(409, 'Could not open the feedback form just now.');
    return { token, expiresAt };
  }
}

export interface FeedbackScreening {
  readonly flagged: boolean;
  readonly matched: readonly string[];
}

/**
 * Screen a stranger's free text, with both of the screens this codebase has.
 *
 * `detectInjection` is what organisation text typed at signup goes through;
 * `screenInjection` is the question library's stricter pass, which also
 * catches markup, control tokens and zero-width characters. Feedback gets both
 * because it is the only free text in the product written by someone with no
 * account, no organisation and no reason to be careful.
 *
 * FLAGGING IS NOT REFUSING. The visitor's words are kept exactly as typed and
 * shown to the owner with the flag beside them. Rejecting the text would lose
 * the one thing the form exists to collect, and would tell an attacker which
 * payloads get through; the safety comes from the text never reaching a model,
 * not from it never reaching the database.
 */
export function screenFeedback(body: string): FeedbackScreening {
  const injection = detectInjection(body);
  const library = screenInjection(body);
  const matched = [...new Set([...injection.matched, ...library.matched])];
  return { flagged: injection.injection || !library.clean, matched };
}

export interface SubmittedFeedback {
  readonly id: string;
  readonly flagged: boolean;
}

export async function submitFeedback(input: {
  token: string;
  body: string;
  source: 'typed' | 'spoken';
  now?: Date;
}): Promise<SubmittedFeedback> {
  const now = input.now ?? new Date();
  const row = await prisma.demoFeedback.findUnique({
    where: { ticketHash: hashTicket(input.token) },
    select: { id: true, submittedAt: true, ticketExpiresAt: true, tenantId: true, runId: true },
  });
  // One answer for a bad token, a spent one and an expired one: the form must
  // not become a way to learn which demos exist.
  if (!input.token || !row || row.submittedAt || row.ticketExpiresAt.getTime() <= now.getTime()) {
    throw new HttpError(410, 'This feedback link is no longer open.', 'ticket_spent');
  }

  const body = input.body.trim().slice(0, MAX_FEEDBACK_CHARS);
  if (body.length === 0) throw new HttpError(400, 'Please write something first.');
  const screening = screenFeedback(body);

  // The guard names the TOKEN, not just the row. Reading by ticketHash and
  // then updating by id alone let an older link spend the row after a second
  // tab had reissued it — the ticket the visitor is holding would be the one
  // that failed.
  const saved = await prisma.demoFeedback.updateMany({
    where: { id: row.id, submittedAt: null, ticketHash: hashTicket(input.token), ticketExpiresAt: { gt: now } },
    data: {
      body,
      source: input.source,
      injectionFlagged: screening.flagged,
      injectionMatched: JSON.stringify(screening.matched),
      submittedAt: now,
      // Releases the unique open slot. Answered rows are all null here, and a
      // null collides with nothing, so they accumulate freely.
      openKey: null,
    },
  });
  if (saved.count !== 1) throw new HttpError(410, 'This feedback link is no longer open.', 'ticket_spent');

  if (screening.flagged) {
    logger.warn({ id: row.id, matched: screening.matched }, 'Demo feedback carries prompt-injection patterns; stored as text and kept away from every model');
  }
  if (row.runId) {
    const { noteStageForRun } = await import('./demoInterviewRun.js');
    await noteStageForRun(row.runId, 'gave_feedback');
  }
  return { id: row.id, flagged: screening.flagged };
}

export interface OwnerFeedbackRow {
  readonly id: string;
  readonly requestedBy: { readonly name: string; readonly email: string; readonly company: string } | null;
  readonly requestedAt: string | null;
  readonly demoTakenAt: string;
  readonly mode: string;
  readonly modeLabel: string;
  readonly stage: string;
  readonly stageLabel: string;
  readonly endReason: string | null;
  readonly endReasonLabel: string | null;
  readonly minutesInInterview: number | null;
  readonly source: string;
  readonly body: string;
  readonly injectionFlagged: boolean;
  readonly injectionMatched: readonly string[];
  /** When this row and the sandbox behind it are deleted. */
  readonly purgesAt: string | null;
}

const MODE_LABELS: Record<string, string> = {
  candidate: 'Was the candidate',
  observer: 'Watched one happen',
  none: 'Did not start an interview',
};

/**
 * Every piece of feedback a visitor has actually sent, newest first.
 *
 * Read ONLY by the platform owner. It joins the demo grant (who asked for the
 * demo, and when) to the sitting (which mode, how far they got, how it ended)
 * to the words, because any one of those alone is not usable: "the timing felt
 * rushed" means one thing from somebody who sat the interview and another from
 * somebody who watched one.
 */
export async function listDemoFeedback(limit = 100): Promise<OwnerFeedbackRow[]> {
  const rows = await prisma.demoFeedback.findMany({
    where: { submittedAt: { not: null } },
    orderBy: { submittedAt: 'desc' },
    take: Math.min(Math.max(limit, 1), 200),
    select: {
      id: true, mode: true, stage: true, body: true, source: true, submittedAt: true,
      injectionFlagged: true, injectionMatched: true, demoGrantId: true, runId: true, tenantId: true,
    },
  });

  const grantIds = [...new Set(rows.map((r) => r.demoGrantId).filter((id): id is string => !!id))];
  const grants = grantIds.length
    ? await prisma.demoGrant.findMany({ where: { id: { in: grantIds } }, select: { id: true, name: true, email: true, company: true, createdAt: true } })
    : [];
  const byGrant = new Map(grants.map((g) => [g.id, g]));

  const runIds = [...new Set(rows.map((r) => r.runId).filter((id): id is string => !!id))];
  const runs = runIds.length
    ? await prisma.demoInterviewRun.findMany({ where: { id: { in: runIds } }, select: { id: true, startedAt: true, endedAt: true, endReason: true } })
    : [];
  const byRun = new Map(runs.map((r) => [r.id, r]));

  const tenantIds = [...new Set(rows.map((r) => r.tenantId))];
  const tenants = await prisma.tenant.findMany({ where: { id: { in: tenantIds } }, select: { id: true, demoExpiresAt: true } });
  const byTenant = new Map(tenants.map((t) => [t.id, t]));

  return rows.map((row) => {
    const grant = row.demoGrantId ? byGrant.get(row.demoGrantId) : undefined;
    const run = row.runId ? byRun.get(row.runId) : undefined;
    // A purged grant keeps the row but not the person: showing the anonymised
    // stand-in as if it were an address would be worse than showing nothing.
    const identified = grant && !grant.email.startsWith('anon:') ? grant : undefined;
    const minutes = run?.endedAt ? Math.round((run.endedAt.getTime() - run.startedAt.getTime()) / 60_000) : null;
    return {
      id: row.id,
      requestedBy: identified ? { name: identified.name, email: identified.email, company: identified.company } : null,
      requestedAt: grant?.createdAt.toISOString() ?? null,
      demoTakenAt: (row.submittedAt ?? new Date(0)).toISOString(),
      mode: row.mode,
      modeLabel: MODE_LABELS[row.mode] ?? 'Unknown',
      stage: row.stage,
      stageLabel: stageLabel(row.stage),
      endReason: run?.endReason ?? null,
      endReasonLabel: run?.endReason ? endReasonLabel(run.endReason) : null,
      minutesInInterview: minutes,
      source: row.source,
      body: row.body,
      injectionFlagged: row.injectionFlagged,
      injectionMatched: safeMatched(row.injectionMatched),
      purgesAt: byTenant.get(row.tenantId)?.demoExpiresAt?.toISOString() ?? null,
    };
  });
}

function safeMatched(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}
