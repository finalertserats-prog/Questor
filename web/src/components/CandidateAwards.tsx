import { useState } from 'react';
import { Icon } from './Icon';
import { TierBadge } from './TierBadge';
import { formatDate } from './dateFormat';
import { api, ApiError } from '../api/client';
import { awardRows, type AwardResponseRow, type AwardRowView } from './candidateAwardsModel';

/**
 * Badges and certificates, one row per tier.
 *
 * An earned row carries the metal, what happened, the date and its exports. An
 * unearned one carries a dashed placeholder, the reason, and no buttons at
 * all — because the badge is struck at the moment of promotion, so there is
 * nothing to export and a greyed-out button would suggest otherwise.
 *
 * Sending anything to a candidate is an admin action and lives behind this
 * panel, never on a row.
 */

export interface CandidateAwardsProps {
  readonly awards: readonly AwardResponseRow[];
  readonly candidateName: string;
}

export function CandidateAwards({ awards, candidateName }: CandidateAwardsProps) {
  const rows = awardRows(awards, candidateName);
  const [failure, setFailure] = useState('');

  if (rows.length === 0) {
    return (
      <section className="card award-panel">
        <h2 className="card-title"><Icon name="evidence" />Badges and certificates</h2>
        <p className="muted small">
          Nothing has been earned yet. A tier is struck when the candidate is moved on from it.
        </p>
      </section>
    );
  }

  return (
    <section className="card award-panel" data-tour="candidate-awards">
      <h2 className="card-title"><Icon name="evidence" />Badges and certificates</h2>
      <p className="muted small">
        A tier is earned on the way out of it — Silver when the candidate moves to Gold, Gold when
        they move to Diamond. Diamond has no certificate; the journey is its record.
      </p>
      {failure && <p className="award-failure" role="alert">{failure}</p>}
      <ol className="award-rows">
        {rows.map((row) => (
          <AwardRow key={row.tier} row={row} onFailure={setFailure} />
        ))}
      </ol>
    </section>
  );
}

function AwardRow({ row, onFailure }: { row: AwardRowView; onFailure: (message: string) => void }) {
  const [busy, setBusy] = useState('');

  async function save(kind: 'badge' | 'certificate', path: string, filename: string) {
    setBusy(kind);
    onFailure('');
    try {
      await api.download(path, filename);
    } catch (err: unknown) {
      // Named rather than swallowed: a button that does nothing at all reads as
      // a broken page, and the person then presses it again.
      onFailure(err instanceof ApiError ? err.message : 'That file could not be prepared. Try again in a moment.');
    } finally {
      setBusy('');
    }
  }

  if (!row.earned) {
    return (
      <li className="award-row award-row-pending">
        {/* A dashed outline where the metal would be: the shape of the thing
            that is not there yet, rather than a faded badge that reads as one. */}
        <span className="award-placeholder" aria-hidden="true" />
        <span className="award-what">{row.label}</span>
        <span className="award-when">—</span>
        <span className="award-actions"><span className="award-reason">{row.reason}</span></span>
      </li>
    );
  }

  return (
    <li className="award-row">
      <TierBadge tier={row.tier} size={36} />
      <span className="award-what">
        <b>{row.label}</b>
        {row.description ? ` — ${row.description}` : ''}
        {row.internal && <span className="award-mark"> · internal</span>}
      </span>
      <span className="award-when">{formatDate(row.awardedAt)}</span>
      <span className="award-actions">
        {row.badgePath && (
          <button
            type="button" className="award-action" disabled={busy !== ''}
            onClick={() => void save('badge', row.badgePath as string, `${row.fileStem}-badge.svg`)}
          >
            {busy === 'badge' ? 'Preparing…' : 'Badge'}
          </button>
        )}
        {/* Diamond records what an employer decided, which is theirs to
            announce, so it offers no certificate. */}
        {row.certificatePath && (
          <button
            type="button" className="award-action" disabled={busy !== ''}
            onClick={() => void save('certificate', row.certificatePath as string, `${row.fileStem}-certificate.pdf`)}
          >
            {busy === 'certificate' ? 'Preparing…' : 'Certificate'}
          </button>
        )}
      </span>
    </li>
  );
}
