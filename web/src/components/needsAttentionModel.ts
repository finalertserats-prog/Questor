/**
 * The dashboard's "needs a person" list: an assessment waiting for review, an
 * interview paused on an accommodation request, a candidate who asked to talk
 * to someone, a feedback email held because the interview could not be relied
 * on. Each used to surface only on that candidate's own page.
 */

export type AttentionKind = 'review' | 'accommodation' | 'human_request' | 'feedback_held';

/** Per kind; a kind an older server does not report is simply absent. */
export type AttentionCounts = Readonly<Partial<Record<AttentionKind, number>>>;

export interface AttentionItem {
  readonly kind: AttentionKind;
  readonly at: string;
  readonly sessionId: string;
  readonly assessmentId: string | null;
  readonly candidate: { readonly id: string; readonly name: string };
  readonly role: { readonly id: string; readonly title: string };
}

export interface NeedsAttention {
  readonly counts: AttentionCounts;
  readonly items: readonly AttentionItem[];
}

const WHAT: Record<AttentionKind, string> = {
  review: 'Assessment to review',
  accommodation: 'Asked for an accommodation',
  human_request: 'Asked to talk to a person',
  feedback_held: 'Feedback email held for a decision',
};

/** What the row says, and where its link goes: to the page where the person acts. */
export function attentionRow(item: AttentionItem): { readonly what: string; readonly to: string; readonly linkText: string } {
  switch (item.kind) {
    case 'review':
      return { what: WHAT.review, to: item.assessmentId ? `/assessments/${item.assessmentId}` : `/interviews/${item.sessionId}`, linkText: 'Review' };
    case 'accommodation':
      return { what: WHAT.accommodation, to: `/interviews/${item.sessionId}`, linkText: 'Read request' };
    case 'human_request':
      return { what: WHAT.human_request, to: `/candidates/${item.candidate.id}`, linkText: 'Open candidate' };
    case 'feedback_held':
      return { what: WHAT.feedback_held, to: item.assessmentId ? `/assessments/${item.assessmentId}` : `/interviews/${item.sessionId}`, linkText: 'Decide' };
  }
}

/** "3 reviews · 1 accommodation request", for the section heading; empty when nothing waits. */
export function attentionSummary(counts: AttentionCounts | undefined): string {
  if (!counts) return '';
  const parts = [
    [counts.review ?? 0, 'review', 'reviews'],
    [counts.accommodation ?? 0, 'accommodation request', 'accommodation requests'],
    [counts.human_request ?? 0, 'request to talk', 'requests to talk'],
    [counts.feedback_held ?? 0, 'held feedback email', 'held feedback emails'],
  ] as const;
  return parts
    .filter(([n]) => n > 0)
    .map(([n, one, many]) => `${n} ${n === 1 ? one : many}`)
    .join(' · ');
}
