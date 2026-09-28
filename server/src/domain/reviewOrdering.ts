/**
 * Whether a human review was recorded before or after the AI's reading was
 * visible to that reviewer.
 *
 * This is the fact that makes the record mean something. A verdict written
 * before the machine's is an independent second opinion; the same verdict
 * written after it may be a countersignature. The two look identical on the
 * page — same words, same reviewer, same timestamp — so the ordering has to be
 * stored at the moment the review is written, not inferred later from an audit
 * trail that may have been pruned or from a policy that has since changed.
 *
 * Three states, not two. `unknown` is honest about reviews recorded before the
 * column existed: claiming either ordering for them would be inventing
 * evidence about human oversight, which is exactly the thing this record is
 * supposed to protect.
 */

export type ReviewOrdering = 'blind_first' | 'ai_first' | 'unknown';

export interface OrderingView {
  readonly kind: ReviewOrdering;
  /** The short label beside the review. */
  readonly label: string;
  /** The sentence that says what the label means. */
  readonly detail: string;
}

const VIEWS: Readonly<Record<ReviewOrdering, OrderingView>> = {
  blind_first: {
    kind: 'blind_first',
    label: 'Recorded before the AI\'s reading was visible',
    detail: 'The reviewer judged from the transcript and the evidence; the AI\'s recommendation, scores and '
      + 'levels were only unlocked afterwards. That ordering is what makes this an independent second opinion.',
  },
  ai_first: {
    kind: 'ai_first',
    label: 'Recorded after the AI\'s reading was visible',
    detail: 'The AI\'s recommendation and scores were on screen before this verdict was written. That is '
      + 'allowed and ordinary — it is recorded so the reader knows which of the two readings came first.',
  },
  unknown: {
    kind: 'unknown',
    label: 'Ordering not recorded',
    detail: 'This review predates the record of whether the AI\'s reading was visible first, so neither '
      + 'ordering is claimed for it.',
  },
};

/** `null` is a review written before the ordering was stored — never a guess. */
export function reviewOrdering(aiVisibleBefore: boolean | null | undefined): ReviewOrdering {
  if (aiVisibleBefore === true) return 'ai_first';
  if (aiVisibleBefore === false) return 'blind_first';
  return 'unknown';
}

export function orderingView(kind: ReviewOrdering): OrderingView {
  return VIEWS[kind];
}
