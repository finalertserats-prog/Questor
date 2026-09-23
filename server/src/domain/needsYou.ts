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
  'identity_code_stuck',
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
 * Who a row of each kind is shown to. Nobody is shown work they have no
 * business seeing; `operator` and `platformOperator` are the deployment's own
 * roles (middleware/operator.ts, middleware/platformOperator.ts), not an
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
  // Seen by everyone who may read the assessment, signed off by fewer; see
  // KIND_ACTION_GATE.
  review: { capability: 'assessment:read' },
  // Sending or keeping a held letter is POST /assessments/:id/feedback-email/*.
  feedback_held: { capability: 'assessment:review' },
  // Resending is POST /interviews/:id/resend.
  invitation_expiring: { capability: 'interview:invite' },
  // Retake and reopen are both interview:invite.
  stalled: { capability: 'interview:invite' },
  identity_code_stuck: { capability: 'interview:invite' },
  catalog_proposals: { operator: 'platformOperator' },
  demo_request: { operator: 'operator' },
};

/**
 * Where doing a row's work is narrower than seeing it. Unlisted kinds are the
 * ordinary case: whoever is shown the row may do its action.
 *
 * A finished assessment is the one thing the recruiter who ran the interview
 * has to know about and cannot sign off. Gating the row on
 * `assessment:review` left them with no sign at all that the interview was
 * done — the very thing they are waiting on — so the row is shown to everyone
 * holding `assessment:read`, and what it offers changes instead: the person
 * who can record a verdict is asked to review, the person who cannot is
 * offered the assessment to read. Never a button the server would refuse.
 */
export const KIND_ACTION_GATE: Readonly<Partial<Record<NeedsYouKind, NeedsYouGate>>> = {
  review: { capability: 'assessment:review' },
};

export interface GateContext {
  readonly capabilities: readonly string[];
  readonly operator: boolean;
  readonly platformOperator: boolean;
}

function passes(gate: NeedsYouGate, ctx: GateContext): boolean {
  if ('capability' in gate) return ctx.capabilities.includes(gate.capability);
  return gate.operator === 'operator' ? ctx.operator : ctx.platformOperator;
}

/** Whether a row of this kind belongs in this person's queue at all. */
export function maySee(kind: NeedsYouKind, ctx: GateContext): boolean {
  return passes(KIND_GATE[kind], ctx);
}

/** Whether they may do the row's work, which for some kinds is a narrower set. */
export function mayActOn(kind: NeedsYouKind, ctx: GateContext): boolean {
  return passes(KIND_ACTION_GATE[kind] ?? KIND_GATE[kind], ctx);
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
 *
 * `canAct` is false for someone the row is shown to who cannot do its work
 * (KIND_ACTION_GATE). The label then says what they CAN do, so the queue never
 * offers a button the server would refuse.
 */
export function actionFor(kind: NeedsYouKind, target: ActionTarget, canAct: boolean = true): { readonly label: string; readonly to: string | null } {
  const interview = target.sessionId ? `/interviews/${target.sessionId}` : null;
  const assessment = target.assessmentId ? `/assessments/${target.assessmentId}` : interview;
  switch (kind) {
    case 'human_request':
      return { label: 'Get in touch', to: target.candidateId ? `/candidates/${target.candidateId}` : interview };
    case 'accommodation':
      return { label: 'Read the request', to: interview };
    case 'review':
      return canAct ? { label: 'Review', to: assessment } : { label: 'Open the assessment', to: assessment };
    case 'feedback_held':
      return { label: 'Read and decide', to: assessment };
    case 'invitation_expiring':
      return { label: 'Resend invitation', to: interview };
    case 'stalled':
      return { label: 'Decide next step', to: interview };
    case 'identity_code_stuck':
      return { label: 'Check the address', to: interview };
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
  identity_code_stuck: 'Could not send an identity code',
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
