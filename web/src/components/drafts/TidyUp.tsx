import { Icon } from '../Icon';
import { tidyDiff, type DiffSegment } from './tidyDiff';
import type { FieldTidy } from './useFieldDraft';

/**
 * "Tidy up what I wrote": the one AI action offered on a field that holds a
 * person's own judgement.
 *
 * It is allowed there — where a fresh draft is not — because it cannot
 * originate anything. There is nothing to tidy until the person has written
 * their own words, and what comes back is those words with the grammar fixed
 * and the shorthand expanded. The before-and-after is not decoration: the
 * person is approving a rewrite of their own record, and they can only do
 * that if they can see exactly what changed.
 *
 * Changes are marked by a sign, a rule and weight — never by a coloured fill,
 * which would not survive printing, high contrast, or being read aloud.
 */

const SIGN: Readonly<Record<DiffSegment['kind'], string>> = {
  same: '',
  removed: '−',
  added: '+',
};

function Marked({ segments }: { readonly segments: readonly DiffSegment[] }) {
  return (
    <p className="tidy-text">
      {segments.map((seg, i) => (
        seg.kind === 'same'
          ? <span key={i}>{seg.text}</span>
          : (
            <span key={i} className={`tidy-${seg.kind}`}>
              <span className="sr-only">{seg.kind === 'added' ? ' added: ' : ' removed: '}</span>
              <span aria-hidden="true" className="tidy-sign">{SIGN[seg.kind]}</span>
              {seg.text}
            </span>
          )
      ))}
    </p>
  );
}

export function TidyUp({ tidy, value }: { readonly tidy: FieldTidy; readonly value: string }) {
  if (!tidy.allowed) return null;

  if (tidy.state.phase === 'ready') {
    const diff = tidyDiff(value, tidy.state.text);
    return (
      <div className="tidy" role="group" aria-label="Before and after tidying" data-testid="tidy-panel">
        <p className="sug-h"><span className="sug-label"><Icon name="sparkle" size={13} />Your words, tidied</span></p>
        {!diff.detailed && (
          <p className="sug-foot">Too long to mark word by word — read both versions.</p>
        )}
        <div className="tidy-cols">
          <div className="tidy-col">
            <p className="tidy-micro">Yours</p>
            <Marked segments={diff.before} />
          </div>
          <div className="tidy-col is-after">
            <p className="tidy-micro">Tidied</p>
            <Marked segments={diff.after} />
          </div>
        </div>
        <p className="sug-acts">
          <button type="button" className="btn sm" onClick={tidy.keep} data-testid="tidy-keep">Keep the tidied version</button>
          <button type="button" className="btn secondary sm" onClick={tidy.discard} data-testid="tidy-discard">Keep mine</button>
          <span className="sug-foot">Recorded as AI-assisted either way. Nothing is added to what you wrote.</span>
        </p>
      </div>
    );
  }

  if (tidy.state.phase === 'working') {
    return <p className="sug-quiet" data-testid="tidy-working"><Icon name="hourglass" size={14} />Tidying…</p>;
  }

  if (tidy.state.phase === 'nothing') {
    return (
      <p className="sug-quiet" data-testid="tidy-nothing">
        Nothing to tidy — it reads well as it is.
      </p>
    );
  }

  if (!tidy.offered) return null;

  return (
    <p className="sug-acts">
      <button type="button" className="btn secondary sm" onClick={tidy.run} data-testid="tidy-run">
        <Icon name="sparkle" size={14} />Tidy up what I wrote
      </button>
      <span className="sug-foot">Rewrites your words. Adds no judgement.</span>
    </p>
  );
}
