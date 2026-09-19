import { prisma } from '../db.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { getEmail } from '../providers/email/index.js';
import { brandedEmail, emailButton, escapeHtml } from '../providers/email/branding.js';
import { SOURCE_KEYS, type SourceKey } from './catalogRefreshState.js';

/**
 * Tell the platform owner a run left proposals waiting. Nothing enters the
 * shared catalog without their approval, so a run that queued work nobody
 * hears about is a run that did nothing.
 */

const KIND_LABELS: Record<string, string> = { new_role: 'New roles', new_alias: 'New alternative titles' };
const SOURCE_LABELS: Record<SourceKey, string> = { onet: 'O*NET', esco: 'ESCO', web: 'Web research' };

/** Operators first; the signup approver only when no operator list is set. */
export function catalogReviewRecipients(): string[] {
  const operators = config.platformOperatorEmails.map((e) => e.trim()).filter((e) => e.length > 0);
  if (operators.length > 0) return [...new Set(operators)];
  const approver = config.signupApproverEmail.trim();
  return approver ? [approver] : [];
}

function sourceOf(sourcesJson: string): SourceKey | null {
  try {
    const parsed: unknown = JSON.parse(sourcesJson);
    const first: unknown = Array.isArray(parsed) ? parsed[0] : null;
    const source = typeof first === 'object' && first !== null && 'source' in first ? first.source : null;
    return SOURCE_KEYS.find((key) => key === source) ?? null;
  } catch { return null; }
}

function tally<T extends string>(values: readonly T[]): Array<[T, number]> {
  const counts = values.reduce((acc, value) => acc.set(value, (acc.get(value) ?? 0) + 1), new Map<T, number>());
  return [...counts.entries()];
}

export interface RefreshSummary {
  readonly total: number;
  readonly byKind: ReadonlyArray<[string, number]>;
  readonly bySource: ReadonlyArray<[SourceKey, number]>;
}

export async function summarizeRun(runId: string): Promise<RefreshSummary> {
  const rows = await prisma.catalogProposal.findMany({ where: { runId, status: 'pending' }, select: { kind: true, sourcesJson: true } });
  return {
    total: rows.length,
    byKind: tally(rows.map((r) => r.kind)),
    bySource: tally(rows.map((r) => sourceOf(r.sourcesJson)).filter((s): s is SourceKey => s !== null)),
  };
}

function render(to: string, summary: RefreshSummary) {
  const link = `${config.webOrigin.replace(/\/+$/, '')}/catalog-review`;
  const lines = [
    ...summary.byKind.map(([kind, n]) => `${KIND_LABELS[kind] ?? kind}: ${n}`),
    ...summary.bySource.map(([source, n]) => `From ${SOURCE_LABELS[source]}: ${n}`),
  ];
  const noun = summary.total === 1 ? 'proposal' : 'proposals';
  return brandedEmail({
    to,
    subject: `Questor catalog refresh: ${summary.total} ${noun} to review`,
    text: [`The monthly catalog refresh found ${summary.total} ${noun} for the shared role catalog.`, '', ...lines, '', 'Nothing is added until you approve it.', `Review them: ${link}`].join('\n'),
    html: `<p>The monthly catalog refresh found <b>${summary.total}</b> ${noun} for the shared role catalog.</p>`
      + `<ul>${lines.map((line) => `<li>${escapeHtml(line)}</li>`).join('')}</ul>`
      + `<p>Nothing is added until you approve it.</p>${emailButton(link, 'Review catalog proposals')}`,
  });
}

export async function notifyOperators(runId: string): Promise<void> {
  const summary = await summarizeRun(runId);
  if (summary.total === 0) return;
  const recipients = catalogReviewRecipients();
  if (recipients.length === 0) {
    logger.warn({ runId, pending: summary.total }, 'Catalog refresh queued proposals but no PLATFORM_OPERATOR_EMAILS or SIGNUP_APPROVER_EMAIL is set to tell');
    return;
  }
  for (const to of recipients) {
    try {
      await getEmail().send(render(to, summary));
    } catch (err) {
      logger.error({ runId, err: err instanceof Error ? err.message : String(err) }, 'Could not send the catalog refresh summary');
    }
  }
}
