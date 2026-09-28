import { useEffect, useState } from 'react';
import { api } from '../api/client';

export interface CandidateTimeZone {
  /** The zone HR recorded for this candidate; null when nobody has. */
  readonly timeZone: string | null;
  /** The zone that stands in for it. */
  readonly orgTimeZone: string | null;
  /** `undefined` while it loads, so the picker does not pre-fill from a guess. */
  readonly loaded: boolean;
}

const UNLOADED: CandidateTimeZone = { timeZone: null, orgTimeZone: null, loaded: false };

/**
 * Where the candidate is, for the scheduler.
 *
 * Their zone is what a new booking should default to — HR knows where they
 * are; the browser asking only knows where the recruiter is. A failed read is
 * treated exactly like "not set", because both mean the same thing here: this
 * booking is about to use somebody else's clock, and the person doing the
 * booking should be told so.
 */
export function useCandidateTimeZone(candidateId: string | null | undefined): CandidateTimeZone {
  const [state, setState] = useState<CandidateTimeZone>(UNLOADED);
  useEffect(() => {
    if (!candidateId) { setState(UNLOADED); return; }
    let cancelled = false;
    setState(UNLOADED);
    api.get<{ timeZone: string | null; orgTimeZone: string }>(`/candidates/${candidateId}/time-zone`)
      .then((resp) => { if (!cancelled) setState({ timeZone: resp.timeZone, orgTimeZone: resp.orgTimeZone, loaded: true }); })
      .catch(() => { if (!cancelled) setState({ timeZone: null, orgTimeZone: null, loaded: true }); });
    return () => { cancelled = true; };
  }, [candidateId]);
  return state;
}
