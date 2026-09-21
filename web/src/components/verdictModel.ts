/**
 * The verdict to show for an interview in a table: the reviewer's once a person
 * has given one, else the AI's. The AI recommendation alone contradicted the
 * journey board on the same page after a reviewer overruled it.
 *
 * While the blind-review policy still holds the viewer back, neither is shown:
 * a colleague's verdict would bias an independent review as much as the AI's.
 */
export interface VerdictSource {
  /** Left out, with blindReviewPending set, while your independent review comes first. */
  readonly recommendation?: string | null;
  /** The completed review's verdict; null before a review, absent on an older server. */
  readonly humanRecommendation?: string | null;
  readonly blindReviewPending?: boolean;
}

export interface Verdict {
  readonly value: string | null;
  readonly source: 'human' | 'ai' | 'pending' | null;
  /** Bracketed marker shown after the badge, so who decided is never a colour. */
  readonly marker: string;
}

export function verdictOf(row: VerdictSource | null | undefined): Verdict {
  if (row?.blindReviewPending) return { value: null, source: 'pending', marker: '' };
  if (row?.humanRecommendation) return { value: row.humanRecommendation, source: 'human', marker: '[ reviewer ]' };
  if (row?.recommendation) return { value: row.recommendation, source: 'ai', marker: '[ AI ]' };
  return { value: null, source: null, marker: '' };
}
