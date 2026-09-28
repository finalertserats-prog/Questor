import type { IconName } from './Icon';

/**
 * What every status chip in the console says, in one place: a readable label,
 * a tone (which colour family), and an icon. The icon is what keeps states
 * separable for anyone who cannot tell the colours apart — it replaces the
 * shape marker the plain badge draws.
 */
export type StatusTone = 'pass' | 'hold' | 'stop' | 'info' | 'neutral';

export interface StatusMeta {
  readonly label: string;
  readonly tone: StatusTone;
  readonly icon: IconName;
}

type StatusTable = Readonly<Record<string, readonly [StatusTone, IconName, string?]>>;

// The tone groupings are the ones the previous stateBadge used, so no
// interview changes colour; only states it left to fall through are named.
const INTERVIEW: StatusTable = {
  PROVISIONED: ['info', 'draft'],
  INVITED: ['hold', 'mail'],
  ACCEPTED: ['pass', 'check'],
  READY_CHECK: ['info', 'mic', 'Ready check'],
  WAITING: ['info', 'hourglass'],
  CONNECTING: ['info', 'refresh'],
  DISCLOSURE: ['info', 'about'],
  CONSENTED: ['hold', 'check'],
  WARMUP: ['hold', 'play', 'Warm-up'],
  ASSESSING: ['hold', 'interviews'],
  CANDIDATE_QUESTIONS: ['hold', 'question'],
  CLOSING: ['info', 'hourglass'],
  PROCESSING: ['hold', 'hourglass'],
  REVIEW_READY: ['pass', 'evidence'],
  HUMAN_REVIEWED: ['pass', 'check-circle'],
  CLOSED: ['pass', 'lock'],
  RESCHEDULE_REQUIRED: ['info', 'schedule'],
  NO_SHOW: ['stop', 'user-x', 'No-show'],
  CANDIDATE_WITHDREW: ['stop', 'sign-out'],
  TECHNICAL_FAILURE: ['stop', 'alert'],
  POLICY_STOP: ['stop', 'stop'],
  MANUAL_HANDOFF: ['info', 'handoff'],
  CANCELLED: ['stop', 'x-circle'],
  INCOMPLETE: ['stop', 'pause'],
};

const PIPELINE: StatusTable = {
  ACTIVE: ['info', 'play'],
  DECIDED: ['neutral', 'check-circle'],
};

const DECISION: StatusTable = {
  APPROVED: ['pass', 'check-circle'],
  REJECTED: ['stop', 'x-circle', 'Not progressing'],
  WITHDRAWN: ['neutral', 'sign-out'],
};

const ROUND: StatusTable = {
  SCHEDULED: ['info', 'schedule'],
  COMPLETED: ['pass', 'check-circle'],
  CANCELLED: ['stop', 'x-circle'],
};

// A role's lifecycle. Archived is neutral and locked: it is finished with,
// not waiting on anyone, so it must not share the draft's amber.
const ROLE: StatusTable = {
  draft: ['hold', 'draft'],
  approved: ['pass', 'check-circle'],
  archived: ['neutral', 'lock'],
};

// Catalog refresh proposals. Superseded is neutral: nothing was wrong with it,
// the catalog simply got the title another way first.
const PROPOSAL: StatusTable = {
  pending: ['hold', 'hourglass'],
  approved: ['pass', 'check-circle'],
  rejected: ['stop', 'x-circle'],
  superseded: ['neutral', 'lock', 'Already in catalog'],
};

const REFRESH_RUN: StatusTable = {
  running: ['info', 'refresh'],
  completed: ['pass', 'check-circle'],
  failed: ['stop', 'alert'],
};

const RECOMMENDATION: StatusTable = {
  PROCEED: ['pass', 'check-circle'],
  CONSIDER: ['hold', 'question'],
  DO_NOT_PROGRESS: ['stop', 'x-circle'],
  // Grading never produced a score — the provider was down. Neutral on
  // purpose: it says something about the instrument, not about the candidate,
  // and must never read as a pass or a fail.
  SCORING_UNAVAILABLE: ['neutral', 'alert', 'Scoring unavailable'],
};

/** "CANDIDATE_QUESTIONS" -> "Candidate questions". */
export function humanise(value: string): string {
  const words = value.replace(/_/g, ' ').trim().toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function lookup(table: StatusTable, value: string): StatusMeta {
  // A blank status would render a chip with no text, which has no accessible
  // name — a screen reader announces nothing where a status should be. Say
  // that the status is unknown instead of saying nothing at all.
  if (!value || !value.trim()) return { label: 'Unknown', tone: 'neutral', icon: 'about' };
  const entry = table[value];
  if (!entry) return { label: humanise(value), tone: 'neutral', icon: 'about' };
  const [tone, icon, label] = entry;
  return { label: label ?? humanise(value), tone, icon };
}

export const interviewStatus = (state: string): StatusMeta => lookup(INTERVIEW, state);
export const pipelineStatus = (status: string): StatusMeta => lookup(PIPELINE, status);
export const decisionStatus = (decision: string): StatusMeta => lookup(DECISION, decision);
export const roundStatus = (status: string): StatusMeta => lookup(ROUND, status);
export const recommendationStatus = (rec: string): StatusMeta => lookup(RECOMMENDATION, rec);
export const roleStatus = (status: string): StatusMeta => lookup(ROLE, status);
export const proposalStatus = (status: string): StatusMeta => lookup(PROPOSAL, status);
export const refreshRunStatus = (status: string): StatusMeta => lookup(REFRESH_RUN, status);

export type BadgeKind = 'green' | 'amber' | 'red' | 'blue' | 'gray';

const TONE_KIND: Readonly<Record<StatusTone, BadgeKind>> = {
  pass: 'green', hold: 'amber', stop: 'red', info: 'blue', neutral: 'gray',
};

export const toneToBadgeKind = (tone: StatusTone): BadgeKind => TONE_KIND[tone];
