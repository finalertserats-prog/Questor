import type { Capability } from './capabilities.js';

/**
 * HR-Box's "Needs you" queue: the things only a person can move on, gathered
 * from every candidate's page into one list. This file is the part that is
 * pure — what each kind is, who may act on it, what its one action is, and the
 * order the queue reads in — so those rules are tested without a database.
 */

export const NEEDS_YOU_KINDS = [
  'human_request',
  'accommodation',
  'review',
  'feedback_held',
  'invitation_expiring',
  'stalled',
  'catalog_proposals',
  'demo_request',
] as const;
export type NeedsYouKind = (typeof NEEDS_YOU_KINDS)[number];

/** The candidate has not started the interview: the invitation link is still the way in. */
export const NOT_STARTED_STATES: readonly string[] = ['INVITED', 'ACCEPTED'];

/**
 * A candidate waiting on a person right now: they asked to talk to someone, or
 * their interview is paused on an adjustment they asked for. Everything else
 * waits on the team's own time.
 */
const URGENT_KINDS: ReadonlySet<NeedsYouKind> = new Set(['human_request', 'accommodation']);

export function isUrgent(kind: NeedsYouKind): boolean {
  return URGENT_KINDS.has(kind);
}

/**
 * Who may act on each kind. A row is only listed for someone whose account can
 * do its action — the server would refuse anyone else — so a hiring manager's
 * queue holds reviews and a recruiter's holds invitations, and nobody is shown
 * work they cannot do. `operator` and `platformOperator` are the deployment's
 * own roles (middleware/operator.ts, middleware/platformOperator.ts), not an
 * organisation role.
 */
export type NeedsYouGate =
  | { readonly capability: Capability }
  | { readonly operator: 'operator' | 'platformOperator' };

export const KIND_GATE: Readonly<Record<NeedsYouKind, NeedsYouGate>> = {
  // Anyone who may see the candidate can pick up the phone.
  human_request: { capability: 'candidate:read' },
  // Reopening a paused interview is POST /interviews/:id/reopen.
  accommodation: { capability: 'interview:invite' },
  review: { capability: 'assessment:review' },
  // Sending or keeping a held letter is POST /assessments/:id/feedback-email/*.
  feedback_held: { capability: 'assessment:review' },
  // Resending is POST /interviews/:id/resend.
  invitation_expiring: { capability: 'interview:invite' },
  // Retake and reopen are both interview:invite.
  stalled: { capability: 'interview:invite' },
  catalog_proposals: { operator: 'platformOperator' },
  demo_request: { operator: 'operator' },
};

export interface GateContext {
  readonly capabilities: readonly string[];
  readonly operator: boolean;
  readonly platformOperator: boolean;
}

export function mayActOn(kind: NeedsYouKind, ctx: GateContext): boolean {
  const gate = KIND_GATE[kind];
  if ('capability' in gate) return ctx.capabilities.includes(gate.capability);
  return gate.operator === 'operator' ? ctx.operator : ctx.platformOperator;
}

export interface ActionTarget {
  readonly sessionId?: string | null;
  readonly assessmentId?: string | null;
  readonly candidateId?: string | null;
}

/**
 * The one thing a row offers, and where it goes: the page where the person
 * acts. A demo re-access request is decided from the operator's email (its
 * link carries the decision credential), so it has no page to open.
 */
export function actionFor(kind: NeedsYouKind, target: ActionTarget): { readonly label: string; readonly to: string | null } {
  const interview = target.sessionId ? `/interviews/${target.sessionId}` : null;
  const assessment = target.assessmentId ? `/assessments/${target.assessmentId}` : interview;
  switch (kind) {
    case 'human_request':
      return { label: 'Get in touch', to: target.candidateId ? `/candidates/${target.candidateId}` : interview };
    case 'accommodation':
      return { label: 'Read the request', to: interview };
    case 'review':
      return { label: 'Review', to: assessment };
    case 'feedback_held':
      return { label: 'Read and decide', to: assessment };
    case 'invitation_expiring':
      return { label: 'Resend invitation', to: interview };
    case 'stalled':
      return { label: 'Decide next step', to: interview };
    case 'catalog_proposals':
      return { label: 'Review proposals', to: '/catalog-review' };
    case 'demo_request':
      return { label: 'Decide from the email', to: null };
  }
}

/** How a kind is named where the web's own copy is not available (the daily summary email). */
export const KIND_LABEL: Readonly<Record<NeedsYouKind, string>> = {
  human_request: 'Asked to talk to a person',
  accommodation: 'Asked for an adjustment',
  review: 'Review ready',
  feedback_held: 'Feedback email held for you',
  invitation_expiring: 'Invitation closes soon',
  stalled: 'Interview stopped part-way',
  catalog_proposals: 'Catalog proposals waiting',
  demo_request: 'Demo access requested again',
};

export interface Orderable {
  readonly kind: NeedsYouKind;
  readonly since: string;
  readonly id: string;
}

/**
 * Urgent first, then whatever has waited longest. The id breaks ties so two
 * rows from the same instant always come out in the same order.
 */
export function compareNeedsYou(a: Orderable, b: Orderable): number {
  const urgency = Number(isUrgent(b.kind)) - Number(isUrgent(a.kind));
  if (urgency !== 0) return urgency;
  const age = a.since.localeCompare(b.since);
  return age !== 0 ? age : a.id.localeCompare(b.id);
}

/** Two letters for a colleague's avatar; "?" when there is no name. */
export function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  const first = words[0][0] ?? '';
  const last = words.length > 1 ? words[words.length - 1][0] ?? '' : '';
  return `${first}${last}`.toUpperCase();
}
