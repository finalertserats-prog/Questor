import { Icon } from '../Icon';
import { formatDateTime } from '../dateFormat';
import { isVerdict, verdictLabel, verdictMark } from './verdictVocabulary';
import { levelText } from './differencesModel';
import { ReviewOrderingLine, type OrderingView } from './AssessmentPart';

/**
 * Part 2, once a verdict has been recorded: what the reviewer decided, in
 * their words, with the levels they changed and when it was recorded.
 *
 * It replaces a sentence that used to sit where the form had been ("Reviewed
 * already: Proceed, 23 Sep…"), which said the outcome and lost everything
 * that made it a human judgement — the reasoning, the levels, the ordering.
 * A record of human oversight that keeps only the answer is not a record of
 * oversight.
 */

export interface RecordedReviewProps {
  readonly verdict: string;
  readonly reason: string;
  readonly comments: string;
  readonly completedAt: string | null;
  readonly reviewerName: string;
  readonly ordering: OrderingView | null | undefined;
  readonly overrides: readonly { readonly competencyId: string; readonly name: string; readonly from: number | null; readonly to: number | null }[];
  readonly competencyCount: number;
}

export function RecordedReview(props: RecordedReviewProps) {
  const known = isVerdict(props.verdict);
  const mark = known ? verdictMark(props.verdict) : null;

  return (
    <>
      <ReviewOrderingLine ordering={props.ordering} />
      <section className="verdict is-solo" data-testid="recorded-review">
        <div className="v-you">
          <p className="v-micro">{props.reviewerName} &middot; recorded {formatDateTime(props.completedAt)}</p>
          <p className={`v-word${mark ? ` is-${mark.tone}` : ''}`} data-testid="recorded-verdict">
            {mark && <Icon name={mark.icon} size={22} />}
            {known ? verdictLabel(props.verdict) : 'No usable verdict'}
          </p>
          {props.reason && (
            <p className="rr-words" data-testid="recorded-reason">{props.reason}</p>
          )}
          {props.comments && <p className="rr-words muted">{props.comments}</p>}

          <p className="v-micro">
            Levels changed &middot; {props.overrides.length} of {props.competencyCount}
          </p>
          <p className="rr-levels" data-testid="recorded-overrides">
            {props.overrides.length === 0
              ? 'Every level was left as the AI had it, which is recorded as agreement.'
              : props.overrides
                .map((o) => `${o.name} ${levelText(o.from)} → ${levelText(o.to)}`)
                .join(' · ')}
          </p>
          <p className="v-conseq-note">
            This is the verdict the team acts on. Nothing in the console replaces one.
          </p>
        </div>
      </section>
    </>
  );
}
