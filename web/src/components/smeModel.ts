/**
 * The subject-matter expert's decisions, kept free of React so they can be unit
 * tested in the node environment this workspace uses (web/tests/smeModel.test.ts).
 *
 * The vocabulary is duplicated from server/src/domain/smeRecommendation.ts
 * rather than shared, because the two workspaces share no code. There is
 * exactly one copy on each side, and they must move together — the same
 * arrangement passwordModel.ts has with the password policy.
 */

export const SME_RECOMMENDATIONS = ['proceed', 'do_not_proceed'] as const;

export type SmeRecommendation = (typeof SME_RECOMMENDATIONS)[number];

const LABELS: Readonly<Record<SmeRecommendation, string>> = {
  proceed: 'Proceed',
  do_not_proceed: 'Do not proceed',
};

export function isSmeRecommendation(value: string): value is SmeRecommendation {
  return (SME_RECOMMENDATIONS as readonly string[]).includes(value);
}

/** The recommendation in words; the stored value unchanged when it is from a newer server. */
export function smeRecommendationLabel(value: string): string {
  return isSmeRecommendation(value) ? LABELS[value] : value;
}

/**
 * The sentence that goes beside every recommendation, on every surface.
 *
 * Said rather than implied. A hiring manager looking at a page that says
 * "Proceed" in the same typeface the reviewer's verdict uses will reasonably
 * assume the system has acted on it, and that is the one thing that must never
 * be assumed here.
 */
export const SME_ADVISORY_NOTE = 'A recommendation. It moves nobody on its own — the decision stays with you.';

export const SME_FEEDBACK_MIN = 20;
export const SME_FEEDBACK_MAX = 5000;

/**
 * One sentence naming what is wrong with a recommendation, or null.
 *
 * The floor on the reasoning is the point of the form. An expert's verdict
 * alone is the least useful half of what they were asked for: the hiring team
 * can already see a score, and what they cannot get anywhere else is why a
 * person disagreed with it.
 */
export function smeReviewProblem(recommendation: string, feedback: string): string | null {
  if (!isSmeRecommendation(recommendation)) return 'Choose whether you would proceed with this candidate.';
  const written = feedback.trim();
  if (written.length < SME_FEEDBACK_MIN) return 'Say why, in a sentence or two. The reasoning is the part the hiring team cannot get anywhere else.';
  if (written.length > SME_FEEDBACK_MAX) return 'That is longer than this form can take. Please shorten it.';
  return null;
}

/**
 * Where a signed-in person's "home" is.
 *
 * An expert has no dashboard, no pipeline and no candidate list, so landing
 * them on `/` would mean a page that fires three requests it already knows will
 * be refused and then shows them nothing. Their worklist is their home.
 */
export function homePathForRole(role: string): string {
  return role === 'sme' ? '/sme' : '/';
}

/** Whether this role's whole surface is the expert one. */
export function isSmeRole(role: string): boolean {
  return role === 'sme';
}

export interface AwaitingSme {
  readonly userId: string;
  readonly name: string;
}

/**
 * What to say about the experts who were asked and have not answered.
 *
 * Empty when nobody is outstanding, so the caller renders nothing rather than
 * an empty row: "asked, nothing back yet" and "nobody was asked" are different
 * states, and the second one has nothing to say.
 */
export function awaitingSummary(awaiting: readonly AwaitingSme[]): string {
  if (awaiting.length === 0) return '';
  const names = awaiting.map((sme) => sme.name);
  if (names.length === 1) return `${names[0]} has been asked and has not answered yet.`;
  if (names.length === 2) return `${names[0]} and ${names[1]} have been asked and have not answered yet.`;
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]} have been asked and have not answered yet.`;
}

/** A round the expert is in the room for, as /api/sme returns it. */
export interface SeatedRound {
  readonly id: string;
  readonly scheduledAt: string;
  /** The zone the round was booked in; null for a booking that carried none. */
  readonly scheduledTimeZone: string | null;
  readonly durationMinutes: number;
  readonly meetingUrl: string | null;
}

/**
 * Whether the clock on screen is the round's own or a stand-in.
 *
 * A round booked through the older offset-only API stores no zone, and every
 * reader then falls back to the organisation's. For an expert in another
 * country that is a wrong time presented as a right one, so the page says which
 * of the two it is showing rather than leaving them to notice.
 */
export function roundZoneNote(round: SeatedRound): string {
  return round.scheduledTimeZone ? '' : 'Booked without a time zone, so this is your organisation’s clock.';
}

/** Whether a round is still ahead: what the page is offering to do with it. */
export function roundIsAhead(round: SeatedRound, now: number): boolean {
  return Date.parse(round.scheduledAt) > now;
}
