import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api, ApiError } from '../api/client';
import { BrandLogo } from '../components/BrandLogo';
import { Icon } from '../components/Icon';
import { TierBadge } from '../components/TierBadge';
import { LoadingNote } from '../components/Skeleton';
import {
  VERIFY_COPY, VERIFY_DOWNLOAD_FAILED, VERIFY_DOWNLOAD_LABEL, VERIFY_EXPLANATION, VERIFY_NO_ACCOUNT_NEEDED,
  VERIFY_RETRY_LABEL, certificateDownloadPath, certificateFallbackFilename, verifyPhaseFor,
  type VerifiedRecord, type VerifyPhase,
} from '../components/verifyModel';

/**
 * `questor.app/v/<token>` — the address printed on the face of every
 * certificate Questor issues, and, until this lane, the only one that led
 * nowhere: the router sent it to the front page.
 *
 * WHO IS READING. Not a Questor user, and usually not a candidate either. An
 * employer holding a piece of paper somebody handed them in an interview,
 * asking two questions in this order: is this real, and is it about the person
 * sitting opposite. So the page answers the first in its heading and the
 * second in the largest thing on it, and offers the document itself beneath.
 *
 * WHAT IT DOES NOT SAY. The organisation, the scores, the evidence rows and
 * the reviewer are all absent, and the owner declined the evidence rows when
 * they were offered. The footnote from the certificate is here in full,
 * because an employer will read a credential as a reference unless it says
 * otherwise, and that sentence is the product's whole position on what a
 * certificate is.
 *
 * Built like the other candidate-facing pages: no shell, no navigation, no way
 * into Questor from here. There is nothing for this reader to sign in to.
 */

export function Verify() {
  const { token } = useParams();
  const [phase, setPhase] = useState<VerifyPhase>('loading');
  const [record, setRecord] = useState<VerifiedRecord | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState('');
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setPhase('loading');
    api.get<VerifiedRecord>(`/v/${token}`)
      .then((res) => { if (!cancelled) { setRecord(res); setPhase('verified'); } })
      .catch((err: unknown) => {
        if (cancelled) return;
        setRecord(null);
        // The code as well as the status: only Questor's own 503 means the
        // record is being migrated, and a proxy's 503 during a deploy must not
        // be reported to an employer as a fact about their certificate.
        const failure = err instanceof ApiError ? err : null;
        setPhase(verifyPhaseFor(failure?.status ?? 0, failure?.code));
      });
    return () => { cancelled = true; };
  }, [token, attempt]);

  useNoIndex();

  const download = useCallback(async () => {
    if (!record || !token) return;
    setDownloading(true);
    setDownloadError('');
    try {
      await api.download(certificateDownloadPath(token), certificateFallbackFilename(record.tier));
    } catch {
      // Named rather than swallowed. A button that does nothing at all reads as
      // a broken page, and the reader presses it again — which, when the reason
      // was a rate limit, is the one thing that makes it worse.
      setDownloadError(VERIFY_DOWNLOAD_FAILED);
    } finally {
      setDownloading(false);
    }
  }, [record, token]);

  if (phase === 'loading') {
    return (
      <main className="verify-shell">
        <div className="verify-card"><LoadingNote /></div>
      </main>
    );
  }

  if (phase !== 'verified' || !record) {
    const copy = VERIFY_COPY[phase === 'verified' ? 'failed' : phase];
    return (
      <main className="verify-shell">
        <div className="verify-card verify-card-quiet">
          <BrandLogo variant="lockup" size={26} />
          <h1 className="verify-title">{copy.title}</h1>
          <p className="muted">{copy.body}</p>
          {/* Only where trying again can change the answer. A link Questor has
              no record of will have no record of it a second time, and a button
              that cannot help is a button that wastes somebody's afternoon. */}
          {phase !== 'unknown' && (
            <button type="button" className="btn secondary" onClick={() => setAttempt((n) => n + 1)}>
              {VERIFY_RETRY_LABEL}
            </button>
          )}
        </div>
      </main>
    );
  }

  return (
    <main className="verify-shell">
      <div className="verify-card">
        <BrandLogo variant="lockup" size={26} />

        {/* The heading is the verdict, not the name. An employer's first
            question is whether the paper is real, and a screen reader landing
            on a person's name has been told nothing yet. */}
        <h1 className="verify-title verify-verdict">
          <Icon name="check" size={22} />
          {VERIFY_COPY.verified.title}
        </h1>

        <p className="verify-name">{record.candidateName}</p>

        <div className="verify-claim">
          <TierBadge tier={record.tier} size={118} label={`${record.claim.tier} badge`} />
          <p className="verify-claim-line">
            {record.claim.lead}
            <strong>{record.claim.tier}</strong>
            {record.claim.middle}
            <strong>{record.claim.role}</strong>
            <span className="verify-mark" aria-hidden="true">*</span>
          </p>
        </div>

        <dl className="verify-facts">
          <div>
            <dt>Role</dt>
            <dd>{record.roleTitle}</dd>
          </div>
          <div>
            <dt>Issued</dt>
            {/* The words are the certificate's own rendering of the date, so
                the page and the paper read alike; the instant beside them is
                for anything that needs to reason about it. */}
            <dd><time dateTime={record.issuedAt}>{record.issuedOn}</time></dd>
          </div>
        </dl>

        <div className="verify-actions">
          <button type="button" className="btn" onClick={() => void download()} disabled={downloading}>
            <Icon name="export" size={16} />
            {downloading ? 'Preparing…' : VERIFY_DOWNLOAD_LABEL}
          </button>
          <span className="small muted">{VERIFY_NO_ACCOUNT_NEEDED}</span>
        </div>
        {downloadError && <p className="verify-failure" role="alert">{downloadError}</p>}

        <p className="verify-footnote">{record.footnote}</p>
        <p className="verify-explanation small muted">{VERIFY_EXPLANATION}</p>
      </div>
    </main>
  );
}

/**
 * Keep this page out of search results, and keep its address out of anybody
 * else's logs.
 *
 * Set from the page rather than in `index.html`, because index.html is every
 * page: a site-wide `noindex` would take the marketing pages with it. Removed
 * again on the way out, or the next route the reader opens inherits it.
 *
 * This is the third of three lines, and the only one that survives a crawler
 * which executes JavaScript and ignores robots.txt. `public/robots.txt`
 * disallows `/v/` for the ones that read it, and the API sets `X-Robots-Tag`
 * on its own answers. A person's name, and the role they were assessed for,
 * indexed and searchable for ever, is not something anybody agreed to.
 *
 * `referrer` is the other half. The token is in the address bar, so every
 * request this page makes out would otherwise carry the verification record of
 * a named person in a Referer header.
 */
function useNoIndex(): void {
  useEffect(() => {
    const tags = [
      meta('robots', 'noindex, nofollow, noarchive, noimageindex'),
      meta('referrer', 'no-referrer'),
    ];
    for (const tag of tags) document.head.appendChild(tag);
    return () => { for (const tag of tags) tag.remove(); };
  }, []);
}

function meta(name: string, content: string): HTMLMetaElement {
  const tag = document.createElement('meta');
  tag.setAttribute('name', name);
  tag.setAttribute('content', content);
  return tag;
}
