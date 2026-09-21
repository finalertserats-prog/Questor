/**
 * The dashboard's "needs a person" list: an assessment waiting for review, an
 * interview paused on an accommodation request, a candidate who asked to talk
 * to someone. Each used to surface only on that candidate's own page.
 */

export type AttentionKind = 'review' | 'accommodation' | 'human_request';

export interface AttentionItem {
  readonly kind: AttentionKind;
  readonly at: string;
  readonly sessionId: string;
  readonly assessmentId: string | null;
  readonly candidate: { readonly id: string; readonly name: string };
  readonly role: { readonly id: string; readonly title: string };
}

export interface NeedsAttention {
  readonly counts: Readonly<Record<AttentionKind, number>>;
  readonly items: readonly AttentionItem[];
}

const WHAT: Record<AttentionKind, string> = {
  review: 'Assessment to review',
  accommodation: 'Asked for an accommodation',
  human_request: 'Asked to talk to a person',
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
  }
}

/** "3 reviews · 1 accommodation request", for the section heading; empty when nothing waits. */
export function attentionSummary(counts: Readonly<Record<AttentionKind, number>> | undefined): string {
  if (!counts) return '';
  const parts = [
    [counts.review, 'review', 'reviews'],
    [counts.accommodation, 'accommodation request', 'accommodation requests'],
    [counts.human_request, 'request to talk', 'requests to talk'],
  ] as const;
  return parts
    .filter(([n]) => n > 0)
    .map(([n, one, many]) => `${n} ${n === 1 ? one : many}`)
    .join(' · ');
}
