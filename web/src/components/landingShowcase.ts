import type { IconName } from './Icon';

/**
 * The content and behaviour behind the sign-in page showcase.
 *
 * Kept out of the component so the parts that can be wrong — the order of the
 * hiring workflow, the claims made about the product, when the highlight moves
 * and when it must not — are checkable without a DOM. Every claim below is
 * something the server actually implements; see the notes on each feature.
 */

export interface ShowcaseStep {
  readonly key: string;
  readonly icon: IconName;
  readonly title: string;
  readonly detail: string;
}

/** Numbered because the order is real: each step needs the one before it. */
export const SHOWCASE_STEPS: readonly ShowcaseStep[] = [
  {
    key: 'scorecard',
    icon: 'job',
    title: 'Job description to scorecard',
    detail: 'Paste the JD. Questor drafts weighted criteria; a person approves them before anyone is measured against them.',
  },
  {
    key: 'onboard',
    icon: 'onboard',
    title: 'Onboard the candidate profile',
    detail: 'Add the candidate and parse their resume into a structured profile.',
  },
  {
    key: 'fit',
    icon: 'funnel',
    // Not called an AI score: server/src/engines/fitScoring.ts is a transparent
    // rule engine, and it excludes protected signals by name (fitScoring.ts:7-10).
    title: 'Profile summary and job fit',
    // Deliberately not "approved scorecard" or "every point traced to evidence":
    // fit scoring runs against the latest scorecard, approved or not, and some
    // of its components (outcome overlap, trajectory) are judgements about the
    // profile rather than quotes from it.
    detail: 'Scored against the role’s scorecard, with the reasons shown — never a name, age or address.',
  },
  {
    key: 'ai-interview',
    icon: 'interviews',
    title: 'The AI interview round',
    // The interviewers are introduced once, here, before anything relies on them.
    detail: 'A structured first round run by one of Questor’s five AI interviewers, in Questor’s own browser room — consent taken and the AI disclosed before it starts.',
  },
  {
    key: 'human-rounds',
    icon: 'schedule',
    title: 'Human rounds around it',
    // No claim that the AI attends a human round: the silent-observer field is a
    // schema flag only, and the interviewer's notes are the evidence there
    // (server/src/routes/pipelines.ts:295-296).
    detail: 'Later rounds are planned around the AI one, each with its interviewers and notes kept on the record.',
  },
  {
    key: 'decision',
    icon: 'scale',
    title: 'Evidence-backed decision',
    detail: 'Ratings quote the moment in the transcript that supports them, and a person makes the final call.',
  },
];

/** Long enough to read a step, short enough that the sequence reads as one motion. */
export const STEP_INTERVAL_MS = 4500;

export interface ShowcaseState {
  readonly step: number;
  readonly paused: boolean;
}

export type ShowcaseEvent =
  | { type: 'tick' }
  | { type: 'select'; step: number }
  | { type: 'pause' }
  | { type: 'resume' };

/**
 * Reduced motion starts paused rather than starting elsewhere: the sequence is
 * simply the first step, held, and every step stays reachable by hand.
 */
export function initialShowcaseState(reducedMotion: boolean): ShowcaseState {
  return { step: 0, paused: reducedMotion };
}

export function showcaseReducer(
  state: ShowcaseState,
  event: ShowcaseEvent,
  stepCount: number = SHOWCASE_STEPS.length,
): ShowcaseState {
  switch (event.type) {
    case 'tick':
      // A paused sequence includes the reduced-motion case, which never advances.
      if (state.paused) return state;
      return { step: (state.step + 1) % stepCount, paused: false };
    case 'select':
      if (!Number.isInteger(event.step) || event.step < 0 || event.step >= stepCount) return state;
      if (state.step === event.step && state.paused) return state;
      return { step: event.step, paused: true };
    case 'pause':
      return state.paused ? state : { ...state, paused: true };
    case 'resume':
      return state.paused ? { ...state, paused: false } : state;
  }
}

/** Safe on the server and in tests, where `matchMedia` may not exist. */
export function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
    : false;
}

export interface ShowcaseFeature {
  readonly key: string;
  readonly icon: IconName;
  readonly title: string;
  readonly detail: string;
}

/**
 * What the product actually holds, beyond the sequence above. Each line was
 * checked against the route that implements it, named in the comment beside it.
 * Nothing here describes an intention: the meeting connectors, for instance, can
 * be configured and tested but cannot create a meeting, so interviews run in the
 * hosted room and the page says nothing about any vendor's call.
 */
export const SHOWCASE_FEATURES: readonly ShowcaseFeature[] = [
  {
    key: 'org-link',
    icon: 'admin',
    // server/src/routes/orgs.ts:19; auth.ts:10-27 (wrong-org answers as wrong password).
    title: 'Your organisation’s own link',
    // Not "a guessed link reveals nothing": GET /api/orgs/:slug answers with the
    // organisation's name, so only the credentials claim is made here.
    detail: 'Everyone signs in at your address, and the wrong organisation answers exactly like a wrong password.',
  },
  {
    key: 'consent',
    icon: 'check-circle',
    // server/src/routes/portal.ts:214-272; the human alternative at portal.ts:219-244.
    title: 'Consent before the AI round',
    detail: 'The candidate is told what is transcribed and kept, and may ask for a human instead.',
  },
  {
    key: 'observe',
    icon: 'eye',
    // server/src/routes/interviews.ts:565-592 — four conditions, checked server-side.
    title: 'Observation they knew about',
    detail: 'HR can follow the AI round live only where the candidate heard that notice and went on.',
  },
  {
    key: 'evidence',
    icon: 'evidence',
    // server/src/engines/evaluator.ts:13-40 — scores from transcript spans only.
    title: 'It admits what it cannot see',
    detail: 'A competency the transcript does not support is marked unevidenced, not guessed at.',
  },
  {
    key: 'blind',
    icon: 'scale',
    // server/src/routes/assessments.ts:48-85, 279-299 (skipping is reasoned and audited).
    title: 'Independent-first review',
    detail: 'The reviewer records their own verdict before Questor’s is revealed; skipping it is logged.',
  },
  {
    key: 'feedback',
    icon: 'contact',
    // server/src/routes/assessments.ts:128-198 — human-approved, then immutable.
    title: 'Written feedback for candidates',
    detail: 'Drafted, approved by a person after review, then sent — and fixed in place once it has gone.',
  },
  {
    key: 'scoped',
    icon: 'candidates',
    // server/src/services/access.ts; roles.ts:128-132 answers 404, never 403.
    title: 'Scoped to what is yours',
    detail: 'Recruiters see the requisitions and candidates assigned to them. The rest is not there.',
  },
  {
    key: 'audit',
    icon: 'audit',
    // server/src/routes/admin.ts:62-108; capabilities.ts:47 (an auditor reads only this).
    title: 'An audit trail that holds',
    detail: 'Consent, observation, decisions and erasures are recorded, and the record itself is impersonal.',
  },
  {
    key: 'retention',
    icon: 'clock',
    // server/src/services/dataRights.ts; admin.ts:261-360; candidates.ts:175-185.
    title: 'Retention and erasure',
    detail: 'Set how long sessions are kept, hold what you must, erase a candidate with a reason recorded.',
  },
  {
    key: 'connectors',
    icon: 'settings',
    // server/src/routes/connectors.ts: shared providers are read from the
    // server's configuration only. The one exception is each organisation's
    // own ATS key (services/atsConnections.ts), which is sealed under the
    // server secret and never sent back.
    title: 'Connectors that keep keys out of reach',
    detail: 'Email, speech and model providers are set in your server’s configuration. Your ATS key is entered once by your administrator, stored encrypted, and never shown again.',
  },
];
