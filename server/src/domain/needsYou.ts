import type { Capability } from './capabilities.js';

/**
 * HR-Box's "Needs you" queue: the things only a person can move on, gathered
 * from every candidate's page into one list. This file is the part that is
 * pure — what each kind is, who may act on it, what its one action is, and the
 * order the queue reads in — so those rules are tested without a database.
 */

export const NEEDS_YOU_KINDS = [
  // First, because it is the only kind with a deadline measured in minutes.
  // It appears when the round is nearly due and takes itself out again when
  // the round is over (services/needsYouRows.ts) — deliberately NOT a row for
  // every round the viewer is seated on. A round booked for next Tuesday is a
  // commitment, not an action; putting one in the queue would make it a
  // calendar, and a row nobody can clear for six days teaches people to stop
  // reading the list it sits in.
  'round_starting',
  'human_request',
  'accommodation',
  'review',
  'feedback_held',
  'invitation_expiring',
  'stalled',
  'identity_code_stuck',
  'round_not_recordable',
  'catalog_proposals',
  'demo_request',
] as const;
export type NeedsYouKind = (typeof NEEDS_YOU_KINDS)[number];

/** The candidate has not started the interview: the invitation link is still the way in. */
export const NOT_STARTED_STATES: readonly string[] = ['INVITED', 'ACCEPTED'];

/**
 * A candidate waiting on a person right now: they asked to talk to someone,
 * their interview is paused on an adjustment they asked for, or they are about
 * to be sitting in a room waiting for the interviewer this row belongs to.
 * Everything else waits on the team's own time.
 */
const URGENT_KINDS: ReadonlySet<NeedsYouKind> = new Set(['human_request', 'accommodation', 'round_starting']);

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
  /**
   * Any one of these is enough. Needed where the same row reaches two lanes
   * that share no capability by design: the hiring team works in
   * `candidate:read`, the subject-matter expert in `sme:assigned_read`, and
   * the whole point of keeping those apart (domain/capabilities.ts) is that
   * neither implies the other.
   */
  | { readonly anyCapability: readonly Capability[] }
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
  // Every human round is recorded, so a round somebody has not agreed to be
  // recorded in cannot go ahead at all (domain/observedRound.ts). That is a
  // blocker on a named candidate, not a preference, and the two ways out —
  // rebooking the round or taking the candidate out of the stage — both need
  // `interview:schedule`. Gated on it so the row is only ever shown to
  // somebody who can act on it.
  round_not_recordable: { capability: 'interview:schedule' },
  catalog_proposals: { operator: 'platformOperator' },
  demo_request: { operator: 'operator' },
  // Both lanes a seated interviewer can be in: a colleague who works in
  // candidate scope, or an expert whose only surface is /api/sme. The
  // capability decides whether this KIND of row can reach them at all; which
  // rounds they see is object scope, and there it is their own seat
  // (services/needsYouRows.ts) — never every round on a candidate they can
  // read. A colleague who is not in the room has nothing to join, and the
  // round is already on the candidate's page and in "Coming up".
  round_starting: { anyCapability: ['candidate:read', 'sme:assigned_read'] },
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
  if ('anyCapability' in gate) return gate.anyCapability.some((c) => ctx.capabilities.includes(c));
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
  /** The meeting a round about to start is held in, when it has one. */
  readonly meetingUrl?: string | null;
  /**
   * The reader reaches candidates through /api/sme rather than the hiring
   * team's pages. Their row has to point at the surface their role can open:
   * an expert sent to /candidates/:id lands on a 404 they cannot read as
   * anything but "the link is broken".
   */
  readonly expertLane?: boolean;
}

/**
 * The one thing a row offers, and where it goes: the page where the person
 * acts. A demo re-access request is decided from the operator's email (its
 * link carries the decision credential), so it has no page to open.
 *
 * `canAct` is false for someone the row is shown to who cannot do its work
 * (KIND_ACTION_GATE). The label then says what they CAN do, so the queue never
 * offers a button the server would refuse.
 *
 * `external` marks the one destination that is not a Questor page: the meeting
 * a round is held in, which belongs to Google or Microsoft. Every consumer
 * treats `to` as a path and builds a URL from it (the digest email prefixes the
 * origin, the queue renders a router link), so a provider URL has to be flagged
 * rather than left to be recognised.
 */
export interface NeedsYouAction {
  readonly label: string;
  readonly to: string | null;
  readonly external?: boolean;
}

export function actionFor(kind: NeedsYouKind, target: ActionTarget, canAct: boolean = true): NeedsYouAction {
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
    case 'round_not_recordable':
      // The pipeline, on the candidate's own page: rebooking the round and
      // moving the candidate on are both done there, and the round's own
      // sentence about why it cannot go ahead is beside them.
      return { label: 'Decide what happens next', to: target.candidateId ? `/candidates/${target.candidateId}` : interview };
    case 'catalog_proposals':
      return { label: 'Review proposals', to: '/catalog-review' };
    case 'demo_request':
      return { label: 'Decide from the email', to: null };
    // Joining, because this row exists only while joining is the thing to do.
    //
    // Not "Confirm": nothing in the product records an interviewer accepting a
    // round, and a button whose press is not stored is worse than no button.
    // When the round has no meeting link yet the honest offer is the candidate
    // instead — the one page that answers "who am I seeing, and against what" —
    // and the label says so rather than promising a room that does not exist.
    case 'round_starting':
      return target.meetingUrl
        ? { label: 'Join', to: target.meetingUrl, external: true }
        : { label: 'Get ready', to: candidatePage(target) };
  }
}

function candidatePage(target: ActionTarget): string | null {
  if (!target.candidateId) return null;
  return target.expertLane ? `/sme/candidates/${target.candidateId}` : `/candidates/${target.candidateId}`;
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
  round_not_recordable: 'Interview round cannot go ahead',
  catalog_proposals: 'Catalog proposals waiting',
  demo_request: 'Demo access requested again',
  round_starting: 'An interview you are conducting starts now',
};

export interface Orderable {
  readonly kind: NeedsYouKind;
  readonly since: string;
  readonly id: string;
}

/**
 * Urgent first, then whatever has waited longest. The id breaks ties so two
 * rows from the same instant always come out in the same order.
 *
 * `round_starting` needs no case of its own, and that is deliberate. Its
 * `since` is when the round starts rather than when a wait began, which is the
 * same shape: the round that should already have begun sorts above the one
 * still a few minutes off, exactly as the longest wait sorts above a shorter
 * one. A special case would have said this again in code that could later
 * disagree with it.
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
