import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api, ApiError } from '../api/client';
import { Banner } from '../components/ui';
import { LoadingNote } from '../components/Skeleton';
import { CandidateObserverConsent } from '../components/ObserverPanels';
import type { CandidateConsentView } from '../components/observerModel';

/**
 * The candidate's entry gate for a human interview round, opened from a link
 * they are sent before it.
 *
 * This is the same shape as the AI round's consent step in pages/Portal.tsx and
 * for the same reason: the candidate reads what happens to their voice and
 * agrees BEFORE the interview, not during it. The difference is the
 * consequence. Declining the AI round's microphone means typing the answers
 * instead; declining here means the round does not go ahead, because every
 * human round is recorded and one that is not produces no evidence. That is
 * said on the page before the press, never discovered after it.
 *
 * Opening the page records nothing: a link scanner or a preview fetch must not
 * be taken as agreement. Only the buttons change anything. The page keeps
 * itself current so "recording" is always true when it says so, and the stop
 * button is always one press away.
 */

const REFRESH_MS = 5000;

export function ObserverConsent() {
  const { token = '' } = useParams();
  const base = `/observer-consent/${encodeURIComponent(token)}`;
  const [view, setView] = useState<CandidateConsentView | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    let timer: number | undefined;
    const load = async () => {
      try {
        const next = await api.get<CandidateConsentView>(base);
        if (!active) return;
        setView(next);
        setError('');
        if (next.status === 'DECLINED' || next.status === 'ENDED') return;
      } catch (err: unknown) {
        if (!active) return;
        if (err instanceof ApiError && err.status === 404) {
          setError('This link does not work. It may have been copied incompletely; ask the interviewer to share it again.');
          return;
        }
        setError('We could not reach Questor. This page will keep trying.');
      }
      timer = window.setTimeout(() => { void load(); }, REFRESH_MS);
    };
    void load();
    return () => { active = false; window.clearTimeout(timer); };
  }, [base]);

  const act = useCallback(async (path: 'consent' | 'decline' | 'stop') => {
    setBusy(true);
    try {
      setView(await api.post<CandidateConsentView>(`${base}/${path}`, {}));
      setError('');
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'That did not work. Please try again.');
    } finally {
      setBusy(false);
    }
  }, [base]);

  return (
    <div className="center-screen">
      <h1 className="visually-hidden">Interview observer consent</h1>
      {error && <Banner kind="error">{error}</Banner>}
      {!view && !error && <LoadingNote />}
      {view && (
        <CandidateObserverConsent
          view={view}
          busy={busy}
          onConsent={() => void act('consent')}
          onDecline={() => void act('decline')}
          onStop={() => void act('stop')}
        />
      )}
    </div>
  );
}
