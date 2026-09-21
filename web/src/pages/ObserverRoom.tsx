import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, ApiError } from '../api/client';
import { Banner } from '../components/ui';
import { Icon } from '../components/Icon';
import { PageHeader } from '../components/PageHeader';
import { Skeleton } from '../components/Skeleton';
import { POLL_DELAY_MS, nextPollDelay } from '../components/pollBackoff';
import { formatScheduled } from '../components/dateFormat';
import { useOrgTimeZone } from '../components/useOrgTimeZone';
import {
  CandidateLinkCard, InterviewerConsentCard, ObserverRoomControls, ObserverTranscript,
} from '../components/ObserverPanels';
import { roomPhase, stopSentence, type ObserverRoundView } from '../components/observerModel';
import { createObserverCapture, type ObserverCapture, type UploadOutcome } from '../observerCapture';
import { openChunkedMicrophone } from '../observerAudio';
import { createRecognizer } from '../speech';

/**
 * The AI observer room for a human interview round, and afterwards the round's
 * record: transcript plus evidence quotes by competency.
 *
 * The interviewer keeps this page open on the device they take the call on.
 * Questor never joins the meeting; it hears what this device hears, and only
 * after both people have agreed.
 */

const CHUNK_MS = 30_000;
// Phases in which the other party, or the other device, can still change
// something this page must show.
const LIVE_PHASES = new Set(['ask_interviewer', 'awaiting_candidate', 'ready', 'listening', 'stopped']);

export function ObserverRoom() {
  const { roundId = '' } = useParams();
  const base = `/observer/rounds/${encodeURIComponent(roundId)}`;
  const [view, setView] = useState<ObserverRoundView | null>(null);
  const orgZone = useOrgTimeZone();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [degraded, setDegraded] = useState('');
  const [captureProblem, setCaptureProblem] = useState('');
  const captureRef = useRef<ObserverCapture | null>(null);
  const captureStartedAt = useRef(0);

  const stopCapture = useCallback(async (flush: boolean) => {
    const capture = captureRef.current;
    captureRef.current = null;
    await capture?.stop({ flush });
  }, []);

  // Poll while something can still change: the candidate answering or
  // stopping, or quotes being extracted after the round.
  useEffect(() => {
    let active = true;
    let timer: number | undefined;
    let delay = POLL_DELAY_MS;
    const poll = async () => {
      const requestedAt = Date.now();
      try {
        const next = await api.get<ObserverRoundView>(base);
        if (!active) return;
        setView(next);
        setError('');
        delay = POLL_DELAY_MS;
        // The candidate stopped it from their link: stop this device too. Only
        // on an answer asked for after capture began; an older one predates
        // "listening" and would stop a capture that is entitled to run.
        const stale = requestedAt < captureStartedAt.current;
        if (captureRef.current && !stale && next.observation?.status !== 'LISTENING') void stopCapture(false);
        const phase = roomPhase(next);
        const quotesPending = next.observation?.quotes.status === 'PENDING' && phase === 'ended';
        if (!LIVE_PHASES.has(phase) && !quotesPending) return;
      } catch (err: unknown) {
        if (!active) return;
        setError(err instanceof Error ? err.message : 'Could not load the observer.');
        delay = nextPollDelay(delay);
      }
      timer = window.setTimeout(() => { void poll(); }, delay);
    };
    void poll();
    return () => { active = false; window.clearTimeout(timer); };
  }, [base, stopCapture]);

  // Leaving the page is a stop, never a silent background recording.
  useEffect(() => () => { void stopCapture(false); }, [stopCapture]);

  const act = useCallback(async (path: string, before?: () => Promise<void>): Promise<boolean> => {
    setBusy(true);
    setError('');
    try {
      await before?.();
      setView(await api.post<ObserverRoundView>(`${base}/${path}`, {}));
      return true;
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'That did not work. Try again.');
      return false;
    } finally {
      setBusy(false);
    }
  }, [base]);

  const upload = useCallback(async (send: () => Promise<{ captured: boolean }>): Promise<UploadOutcome> => {
    try {
      return (await send()).captured ? 'ok' : 'gap';
    } catch (err: unknown) {
      return err instanceof ApiError && err.status === 409 ? 'refused' : 'gap';
    }
  }, []);

  const start = useCallback(async () => {
    // Capture begins only once the server has agreed it is listening.
    if (!view || !(await act('start'))) return;
    captureStartedAt.current = Date.now();
    const capture = createObserverCapture({
      mode: view.capture.mode,
      chunkMs: CHUNK_MS,
      now: () => Date.now(),
      schedule: (fn, ms) => { const t = window.setTimeout(fn, ms); return () => window.clearTimeout(t); },
      openMicrophone: openChunkedMicrophone,
      createRecognizer: (handlers) => createRecognizer(handlers),
      sendAudio: (blob, offsetMs, durationMs) => upload(() => {
        const form = new FormData();
        form.append('offsetMs', String(offsetMs));
        form.append('durationMs', String(durationMs));
        form.append('audio', blob, 'chunk.webm');
        return api.postForm<{ captured: boolean }>(`${base}/segments`, form);
      }),
      sendText: (text, offsetMs, durationMs) => upload(() => api.post<{ captured: boolean }>(`${base}/segments`, { text, offsetMs, durationMs })),
      reportGap: async (offsetMs, durationMs, reason) => { await api.post(`${base}/capture-gap`, { offsetMs, durationMs, reason }); },
      onState: (state) => {
        if (state.kind === 'degraded') setDegraded(state.message);
        if (state.kind === 'stopped' && state.reason === 'unavailable') {
          setCaptureProblem('This device could not capture audio (no microphone access, or no speech recognition in this browser). Nothing is being transcribed; stop the observer or end the round.');
        }
      },
    });
    captureRef.current = capture;
    await capture.start();
  }, [act, base, upload, view]);

  if (!view) {
    return (
      <div className="page">
        <PageHeader icon="eye" title="AI observer" />
        {error ? <Banner kind="error">{error}</Banner> : <Skeleton lines={4} />}
      </div>
    );
  }

  const phase = roomPhase(view);
  const observation = view.observation;
  return (
    <div className="page observer-room">
      <PageHeader
        icon="eye"
        title={`AI observer · ${view.round.stageKey}`}
        subtitle={`Round scheduled ${formatScheduled(view.round.scheduledAt, view.round.scheduledTimeZone, orgZone)}`}
        actions={<Link className="btn ghost" to={`/candidates/${view.round.candidateId}`}><Icon name="arrow-left" size={16} />Back to candidate</Link>}
      />
      {error && <Banner kind="error">{error}</Banner>}
      {captureProblem && <Banner kind="error">{captureProblem}</Banner>}

      {phase === 'unavailable' && (
        <Banner kind="info">This round has no AI observer. It runs, and is recorded, as normal.</Banner>
      )}
      {phase === 'ask_interviewer' && (
        <InterviewerConsentCard notice={view.notice} busy={busy} onConsent={() => void act('consent')} onDecline={() => void act('decline')} />
      )}
      {phase === 'awaiting_candidate' && observation?.candidateLink && (
        <CandidateLinkCard link={observation.candidateLink} onCopy={() => void navigator.clipboard?.writeText(observation.candidateLink ?? '')} />
      )}
      {observation && phase !== 'ended' && phase !== 'declined' && phase !== 'unavailable' && (
        <ObserverRoomControls
          phase={phase}
          isInterviewer={observation.isInterviewer}
          busy={busy}
          stopSentence={stopSentence(observation)}
          degradedMessage={degraded || (observation.captureStatus === 'DEGRADED' ? 'Part of the round could not be transcribed; the transcript marks the gaps.' : undefined)}
          onStart={() => void start()}
          onStop={() => void act('stop', () => stopCapture(false))}
          onEnd={() => void act('end', () => stopCapture(true))}
        />
      )}
      {phase === 'declined' && observation && <Banner kind="info">{stopSentence(observation)}</Banner>}
      {observation && (phase === 'ended' || observation.transcript.length > 0) && <ObserverTranscript observation={observation} />}
      {phase === 'ended' && observation?.quotes.status === 'UNAVAILABLE' && (
        <button type="button" className="btn secondary" disabled={busy} onClick={() => void act('quotes')}>
          <Icon name="refresh" size={16} />Try extracting quotes again
        </button>
      )}
    </div>
  );
}
