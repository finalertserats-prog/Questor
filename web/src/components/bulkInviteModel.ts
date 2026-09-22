/**
 * Inviting the people a bulk import added, through the existing
 * POST /api/interviews/bulk-invite. That endpoint invites a candidate's
 * latest interview, so someone with none gets one set up first (POST
 * /api/interviews, as Set up interview does on their page). Portal links in
 * the responses are never kept or shown here: they are bearer credentials.
 */

export interface InviteTarget {
  readonly candidateId: string;
  readonly interview: { readonly id: string; readonly state: string } | null;
}

export interface Skip {
  readonly candidateId: string;
  readonly reason: string;
}

export interface InvitePlan {
  /** No interview yet: set one up, then invite. */
  readonly setUp: string[];
  /** Everyone sent to bulk-invite, in order. */
  readonly invite: string[];
  readonly skipped: Skip[];
}

const INVITABLE = new Set(['PROVISIONED', 'RESCHEDULE_REQUIRED']);

export function invitePlan(targets: readonly InviteTarget[]): InvitePlan {
  return targets.reduce<InvitePlan>((plan, t) => {
    if (!t.interview) return { ...plan, setUp: [...plan.setUp, t.candidateId], invite: [...plan.invite, t.candidateId] };
    if (INVITABLE.has(t.interview.state)) return { ...plan, invite: [...plan.invite, t.candidateId] };
    const reason = t.interview.state === 'INVITED' ? 'already invited' : 'interview already under way or done';
    return { ...plan, skipped: [...plan.skipped, { candidateId: t.candidateId, reason }] };
  }, { setUp: [], invite: [], skipped: [] });
}

/** One row of the bulk-invite answer; only what this page reads. */
export interface BulkInviteResult {
  readonly candidateId?: string;
  readonly success: boolean;
  readonly invitation?: { readonly delivered?: boolean };
  readonly error?: string;
}

export type InviteKind = 'invited' | 'link_only' | 'skipped' | 'failed';

export interface InviteOutcome {
  readonly kind: InviteKind;
  readonly text: string;
}

export function inviteOutcomes(
  results: readonly BulkInviteResult[],
  skipped: readonly Skip[],
  setUpFailures: readonly { readonly candidateId: string; readonly error: string }[],
): Map<string, InviteOutcome> {
  const fromInvite = results.filter((r) => r.candidateId).map((r): [string, InviteOutcome] => {
    if (!r.success) return [r.candidateId!, { kind: 'failed', text: r.error || 'Invitation failed' }];
    return r.invitation?.delivered
      ? [r.candidateId!, { kind: 'invited', text: 'Invited' }]
      : [r.candidateId!, { kind: 'link_only', text: 'Link created, but no email was sent. Open the interview to copy the link.' }];
  });
  return new Map<string, InviteOutcome>([
    ...skipped.map((s): [string, InviteOutcome] => [s.candidateId, { kind: 'skipped', text: `Skipped: ${s.reason}` }]),
    ...setUpFailures.map((f): [string, InviteOutcome] => [f.candidateId, { kind: 'failed', text: f.error }]),
    ...fromInvite,
  ]);
}

/** "38 invited, 2 skipped: already invited". */
export function inviteSummary(outcomes: ReadonlyMap<string, InviteOutcome>): string {
  const all = [...outcomes.values()];
  const count = (kind: InviteKind) => all.filter((o) => o.kind === kind).length;
  const skipReasons = [...new Set(all.filter((o) => o.kind === 'skipped').map((o) => o.text.replace(/^Skipped: /, '')))];
  return [
    `${count('invited')} invited`,
    count('link_only') ? `${count('link_only')} ${count('link_only') === 1 ? 'link' : 'links'} created but not emailed` : '',
    count('skipped') ? `${count('skipped')} skipped: ${skipReasons.join('; ')}` : '',
    count('failed') ? `${count('failed')} failed` : '',
  ].filter(Boolean).join(', ');
}
