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
  CandidateLinkCard, EntryGateCard, ObserverRoomControls, ObserverTranscript, RoundBlockedCard,
} from '../components/ObserverPanels';
import { roomPhase, stopSentence, type ObserverRoundView } from '../components/observerModel';
import { createObserverCapture, type ObserverCapture, type UploadOutcome } from '../observerCapture';
import { openChunkedMicrophone } from '../observerAudio';
import { createRecognizer } from '../speech';

/**
 * The AI observer room for a human interview round, and afterwards the round's
 * record: transcript plus evidence quotes by competency.
 *
 * Everyone in the call keeps this page open on the device they are taking it
 * on — whoever is conducting, and HR if they joined. Questor never joins the
 * meeting; it hears what these devices hear.
 *
 * NOBODY PRESSES RECORD. Capture starts when this page is admitted to the room
 * and stops when it leaves. Admission needs an agreement from everyone whose
 * voice is captured, which is why there is a gate card here and no start
 * button anywhere (domain/observedRound.ts on the server).
 *
 * There is no tile for the observer, and there is not going to be one: the AI
 * is not a participant in the conversation. The notice on the gate is the
 * disclosure, and the status line says whether capture is running.
 */

const CHUNK_MS = 30_000;
// Phases in which somebody else, or another device, can still change something
// this page must show.
const LIVE_PHASES = new Set(['gate', 'awaiting_others', 'listening', 'stopped']);

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
  // Whether this device has already been admitted. State rather than a ref so
  // the effect below re-runs when it changes, and so a failed join is not
  // retried on every poll.
  const [entered, setEntered] = useState(false);
  // Optional, and kept here rather than in the control so a half-written reason
  // survives a poll re-render while the person is still typing it.
  const [reason, setReason] = useState('');

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
    /**
     * Proof this tab is still capturing — and the round's chance to tell it to
     * stop.
     *
     * OUTSIDE the successful-read branch on purpose. The beat is the authority
     * and the read is a courtesy: a device whose polls are failing still holds
     * an open microphone, and that is exactly the device that most needs to be
     * told the round has been withdrawn from. Tying the beat to a successful
     * GET meant a tab that could not read could not be stopped either.
     */
    const beat = async () => {
      if (!captureRef.current) return;
      try {
        const answer = await api.post<{ capture?: string }>(`${base}/heartbeat`, {});
        if (answer.capture === 'stop') await stopCapture(false);
      } catch {
        // A failed beat is not a reason to stop capturing: the round may be
        // running perfectly and the network may be having a moment. The server
        // notices the silence on its own (`captureLiveness`).
      }
    };

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
      await beat();
      timer = window.setTimeout(() => { void poll(); }, delay);
    };
    void poll();
    return () => { active = false; window.clearTimeout(timer); };
  }, [base, stopCapture]);

  // Leaving the page is a stop, never a silent background recording.
  useEffect(() => () => { void stopCapture(false); }, [stopCapture]);

  const act = useCallback(async (
    path: string, before?: () => Promise<void>, body: Record<string, unknown> = {},
  ): Promise<boolean> => {
    setBusy(true);
    setError('');
    try {
      await before?.();
      setView(await api.post<ObserverRoundView>(`${base}/${path}`, body));
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

  /**
   * Join the room, which is what starts capture on this device.
   *
   * The microphone is opened only after the server has admitted this person and
   * answered LISTENING. Opening it first and asking afterwards would put audio
   * in a buffer before anybody had checked whether everyone had agreed, which
   * is the shape of the mistake this whole design exists to avoid.
   */
  const join = useCallback(async () => {
    if (!view || !(await act('join'))) return;
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

  /**
   * Joining is automatic once the server says this person may enter: the round
   * is already running for everybody else, and a second press to enter a room
   * you have just agreed to enter is a press that means nothing.
   *
   * Driven by the server's `mayEnter` rather than by the phase. Asking to join
   * while somebody has still to agree is refused — correctly — and the poll
   * would then put a refusal banner on screen every few seconds in front of a
   * person who has done nothing wrong and is simply waiting.
   */
  const mayEnter = view?.gate?.mayEnter === true;
  useEffect(() => {
    if (mayEnter && !entered) { setEntered(true); void join(); }
    // `join` changes with every poll; re-running on it would re-enter the room.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mayEnter, entered]);

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
  const gate = view.gate;
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
      {/*
        The two silent failures, said to the only person who can put either
        right, and only while the round is still running.

        Loud on purpose. Neither of these breaks anything visibly: a closed tab
        and a headset both leave a round that looks observed, and the second
        leaves a transcript that looks like evidence while containing one side
        of the conversation. Each names its own remedy, because a general
        warning about "capture problems" is one nobody acts on.
      */}
      {view.capture.alarm?.warning && (
        <div data-testid="observer-not-hearing"><Banner kind="error">{view.capture.alarm.warning}</Banner></div>
      )}
      {view.capture.hearing?.warning && (
        <div data-testid="observer-one-sided"><Banner kind="error">{view.capture.hearing.warning}</Banner></div>
      )}

      {phase === 'unavailable' && (
        <Banner kind="info">This round has no AI observer. It runs, and is recorded, as normal.</Banner>
      )}
      {phase === 'gate' && gate && view.you.party !== 'candidate' && (
        <EntryGateCard
          gate={gate}
          party={view.you.party}
          busy={busy}
          onConsent={() => void act('consent')}
          onDecline={() => void act('decline', undefined, { reason })}
        />
      )}
      {phase === 'awaiting_others' && observation?.candidateLink && observation.awaiting.includes('candidate') && (
        <CandidateLinkCard link={observation.candidateLink} onCopy={() => void navigator.clipboard?.writeText(observation.candidateLink ?? '')} />
      )}
      {observation && (phase === 'listening' || phase === 'awaiting_others' || phase === 'stopped') && (
        <ObserverRoomControls
          phase={phase}
          awaiting={observation.awaiting}
          busy={busy}
          stopSentence={stopSentence(observation)}
          degradedMessage={degraded || (observation.captureStatus === 'DEGRADED' ? 'Part of the round could not be transcribed; the transcript marks the gaps.' : undefined)}
          reason={reason}
          onReasonChange={setReason}
          onStop={() => void act('stop', () => stopCapture(false), { reason })}
          onEnd={() => void act('end', () => stopCapture(true))}
        />
      )}
      {/* The whole point of surfacing this here: the person who opened the room
          at the scheduled time learns why it is empty, and what to do, without
          having to ask anybody. */}
      {observation?.blocked && <RoundBlockedCard block={observation.blocked} />}
      {observation && (phase === 'ended' || observation.transcript.length > 0) && <ObserverTranscript observation={observation} />}
      {phase === 'ended' && observation?.quotes.status === 'UNAVAILABLE' && (
        <button type="button" className="btn secondary" disabled={busy} onClick={() => void act('quotes')}>
          <Icon name="refresh" size={16} />Try extracting quotes again
        </button>
      )}
    </div>
  );
}
