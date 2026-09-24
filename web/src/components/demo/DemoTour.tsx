import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { api } from '../../api/client';
import { useAuth } from '../../auth';
import { Icon } from '../Icon';
import { useTour } from '../tourContext';
import { tourMotion, type Rect } from '../tourModel';
import { DEMO_BEATS, NARRATION_MANIFEST_URL, narrationUrl, type DemoBeat } from './demoScript';
import {
  ANCHOR_WAIT_MS, DEMO_TOUR_FINISHED_EVENT, LOADING_TOUR, READY_TOUR, beatAnnouncement, capsSentence, captionDurationMs, demoKeyAction,
  demoProgress, hasNarration, interviewChoices, isRunning, nextBeat, offeredBeats, pauseDemoTour, previousBeat, rememberTourSeen,
  resolveRoute, resumeDemoTour, skipDemoTour, startDemoTour, tourAlreadySeen, waitsForChoice,
  type DemoStatus, type DemoTourFinishedDetail, type DemoTourState, type NarrationManifest,
} from './demoTourModel';
import { endDemo, openSampleInterview } from './endDemo';

const SPOTLIGHT_PADDING = 6;
const ANCHOR_POLL_MS = 100;
// A smooth scroll to the element takes this long to come to rest; the line waits for it.
const SCROLL_SETTLE_MS = 450;
const FOCUS_SETTLE_MS = 50;
const REDUCED_MOTION = '(prefers-reduced-motion: reduce)';
const PUBLIC_PREFIXES = ['/o/', '/signup'];

/** The element a beat points at — and only if it is actually laid out: a hidden tab panel's element is not on the page. */
function anchorElement(anchor: string | undefined): HTMLElement | null {
  if (anchor === undefined) return null;
  const candidates = document.querySelectorAll<HTMLElement>(`[data-tour="${anchor}"]`);
  for (const element of candidates) if (element.getClientRects().length > 0) return element;
  return null;
}

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => {
    try { return window.matchMedia(REDUCED_MOTION).matches; } catch { return false; }
  });
  useEffect(() => {
    let query: MediaQueryList;
    try { query = window.matchMedia(REDUCED_MOTION); } catch { return undefined; }
    const onChange = (event: MediaQueryListEvent) => setReduced(event.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);
  return reduced;
}

const sameRect = (a: Rect | null, b: Rect | null) =>
  a === b || (a !== null && b !== null && a.top === b.top && a.left === b.left && a.width === b.width && a.height === b.height);

function sessionStore(): Storage | null {
  try { return window.sessionStorage; } catch { return null; }
}

/** One beat's clock: the narration file when there is one, the scripted seconds when there is not. */
interface Clock {
  audio: HTMLAudioElement | null;
  timer: number | undefined;
  remainingMs: number;
  startedAt: number;
}

/**
 * The guided demo: the story from demoScript.ts, told over the real
 * application. Each beat navigates to its screen, waits for the element it
 * spotlights, and runs for the length of its narration — or its caption's
 * scripted seconds when no audio is present. The spotlight and scrim are the
 * product tour's; the player is a bar docked to the bottom of the viewport.
 *
 * Mounted above both shells (the app's and the public pages'), because two
 * beats play over the organisation's sign-in page and the account request.
 */
export function DemoTour() {
  const { tenant, user } = useAuth();
  const { startRequest } = useTour();
  const location = useLocation();
  const navigate = useNavigate();
  const reducedMotion = usePrefersReducedMotion();
  const titleId = useId();
  const captionId = useId();

  const [status, setStatus] = useState<DemoStatus | null>(null);
  const [manifest, setManifest] = useState<NarrationManifest | null>(null);
  const [state, setState] = useState<DemoTourState>(LOADING_TOUR);
  const [showStart, setShowStart] = useState(false);
  const [targetRect, setTargetRect] = useState<Rect | null>(null);
  const [confirmEnd, setConfirmEnd] = useState(false);
  const [interviewError, setInterviewError] = useState('');

  const playerRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const clockRef = useRef<Clock>({ audio: null, timer: undefined, remainingMs: 0, startedAt: 0 });
  // Bumped on every beat change, so a wait that finishes late finds it is stale.
  const runRef = useRef(0);
  const handledRequestRef = useRef(0);
  const stateRef = useRef(state);
  stateRef.current = state;

  const offered = useMemo(() => (status ? offeredBeats(DEMO_BEATS, status) : []), [status]);
  const running = isRunning(state);
  const beat: DemoBeat | null = running ? offered[state.index] ?? null : null;
  const motion = tourMotion(reducedMotion);
  const progress = demoProgress(state, offered.length);
  const beatRef = useRef<DemoBeat | null>(null);
  beatRef.current = beat;
  const tourRef = useRef<HTMLDivElement>(null);

  // ---- the sandbox and the narration ------------------------------------
  useEffect(() => {
    if (!tenant?.isDemo || !user) return undefined;
    let cancelled = false;
    void (async () => {
      const [loaded, files] = await Promise.all([
        api.get<DemoStatus>('/demo/status').catch(() => null),
        fetch(NARRATION_MANIFEST_URL).then((r) => (r.ok ? r.json() as Promise<NarrationManifest> : null)).catch(() => null),
      ]);
      if (cancelled || !loaded) return;
      setStatus(loaded);
      setManifest(files);
      setState(READY_TOUR);
      setShowStart(!tourAlreadySeen(sessionStore()));
    })();
    return () => { cancelled = true; };
  }, [tenant?.isDemo, user]);

  // ---- the clock ----------------------------------------------------------
  const stopClock = useCallback(() => {
    const clock = clockRef.current;
    if (clock.audio) { clock.audio.pause(); clock.audio.onended = null; clock.audio.onerror = null; }
    window.clearTimeout(clock.timer);
    clockRef.current = { audio: null, timer: undefined, remainingMs: 0, startedAt: 0 };
  }, []);

  const advance = useCallback(() => {
    stopClock();
    setState((current) => nextBeat(current, offered.length));
  }, [stopClock, offered.length]);

  // The end of a beat's narration: on to the next — except on a card that
  // asks the visitor to choose, which stays until they have.
  const onClockEnd = useCallback(() => {
    const current = beatRef.current;
    if (current && waitsForChoice(current)) { stopClock(); return; }
    advance();
  }, [advance, stopClock]);

  const runTimer = useCallback((ms: number) => {
    const clock = clockRef.current;
    clock.remainingMs = ms;
    clock.startedAt = Date.now();
    clock.timer = window.setTimeout(onClockEnd, ms);
  }, [onClockEnd]);

  // The narration file when there is one; otherwise the caption for its
  // scripted seconds. A file that will not play (blocked, missing) falls back
  // to the caption too — the visitor never waits on silence.
  // A replay while paused starts a fresh clock; the pause effect must then
  // not resume the old one on top of it.
  const clockRestartedRef = useRef(false);
  const startClock = useCallback((current: DemoBeat) => {
    stopClock();
    clockRestartedRef.current = true;
    if (!hasNarration(manifest, current.id)) { runTimer(captionDurationMs(current)); return; }
    const audio = new Audio(narrationUrl(current.id));
    clockRef.current.audio = audio;
    audio.onended = onClockEnd;
    audio.onerror = () => { clockRef.current.audio = null; runTimer(captionDurationMs(current)); };
    audio.play().catch(() => { clockRef.current.audio = null; runTimer(captionDurationMs(current)); });
  }, [stopClock, runTimer, onClockEnd, manifest]);

  const pauseClock = useCallback(() => {
    const clock = clockRef.current;
    if (clock.audio) { clock.audio.pause(); return; }
    window.clearTimeout(clock.timer);
    clock.remainingMs = Math.max(0, clock.remainingMs - (Date.now() - clock.startedAt));
  }, []);

  const resumeClock = useCallback(() => {
    const clock = clockRef.current;
    if (clock.audio) { clock.audio.play().catch(() => advance()); return; }
    runTimer(clock.remainingMs);
  }, [runTimer, advance]);

  // ---- each beat: go there, find the element, then run ---------------------
  const beatKey = beat ? `${state.index}:${beat.id}` : null;
  useEffect(() => {
    if (!beat || !status) return undefined;
    const run = ++runRef.current;
    setTargetRect(null);
    setConfirmEnd(false);
    const route = resolveRoute(beat, status);
    if (`${location.pathname}${location.search}` !== route) navigate(route);
    let poll: number | undefined;
    const waitedSince = Date.now();
    const settle = () => {
      if (runRef.current !== run) return;
      if (beat.anchor === undefined) { startClock(beat); return; }
      const element = anchorElement(beat.anchor);
      if (element) {
        element.scrollIntoView({ block: 'center', inline: 'nearest', behavior: motion.scrollBehavior });
        // The line begins once the page has come to rest on the element.
        poll = window.setTimeout(() => { if (runRef.current === run) startClock(beat); }, motion.animate ? SCROLL_SETTLE_MS : 0);
        return;
      }
      // The page changed and its element is gone: the beat skips rather than
      // points at nothing (the anchor test fails the build; this is the guard
      // in front of a visitor).
      if (Date.now() - waitedSince > ANCHOR_WAIT_MS) { advance(); return; }
      poll = window.setTimeout(settle, ANCHOR_POLL_MS);
    };
    settle();
    return () => { window.clearTimeout(poll); };
    // The route is read at the moment the beat begins; later location changes must not restart it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [beatKey, status]);

  // Pausing stops the clock where it is; resuming picks it up there — but
  // only for the beat that was paused. Stepping on from a pause starts the
  // next beat's own clock, and a resume applied to it would run a zero-length
  // timer and skip it outright.
  const pausedIndexRef = useRef<number | null>(null);
  useEffect(() => {
    if (state.phase === 'paused' && pausedIndexRef.current === null) { pausedIndexRef.current = state.index; pauseClock(); }
    if (state.phase === 'playing' && pausedIndexRef.current !== null) {
      const resumes = pausedIndexRef.current === state.index && !clockRestartedRef.current;
      pausedIndexRef.current = null;
      if (resumes) resumeClock();
    }
    clockRestartedRef.current = false;
  }, [state.phase, state.index, pauseClock, resumeClock]);

  // ---- the spotlight, measured continuously while a beat is on screen -----
  const measure = useCallback(() => {
    if (!beat?.anchor) return;
    const box = anchorElement(beat.anchor)?.getBoundingClientRect();
    const next: Rect | null = box ? { top: box.top, left: box.left, width: box.width, height: box.height } : null;
    setTargetRect((current) => (sameRect(current, next) ? current : next));
  }, [beat]);

  useLayoutEffect(() => { measure(); }, [measure]);

  useEffect(() => {
    if (!beat?.anchor) return undefined;
    let frame = 0;
    const tick = () => { measure(); frame = requestAnimationFrame(tick); };
    frame = requestAnimationFrame(tick);
    window.addEventListener('scroll', measure, true);
    window.addEventListener('resize', measure);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('scroll', measure, true);
      window.removeEventListener('resize', measure);
    };
  }, [beat, measure]);

  // ---- starting, by the card or by "Take the tour" -------------------------
  const begin = useCallback(() => {
    rememberTourSeen(sessionStore());
    setShowStart(false);
    setInterviewError('');
    setState(startDemoTour(offered.length));
  }, [offered.length]);

  useEffect(() => {
    if (startRequest === handledRequestRef.current) return;
    handledRequestRef.current = startRequest;
    if (state.phase === 'loading') return;
    begin();
  }, [startRequest, state.phase, begin]);

  // ---- the keys: capture phase, so the page beneath never sees them --------
  useEffect(() => {
    if (!running) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      const action = demoKeyAction(event.key);
      if (!action) return;
      event.preventDefault();
      event.stopPropagation();
      if (action === 'skip-tour') setState((current) => skipDemoTour(current));
      else if (action === 'next') advance();
      else if (action === 'back') { stopClock(); setState((current) => previousBeat(current)); }
      else if (action === 'replay') { if (beat) startClock(beat); setState((current) => resumeDemoTour(current)); }
      else setState((current) => (current.phase === 'paused' ? resumeDemoTour(current) : pauseDemoTour(current)));
    };
    const onFocusIn = (event: FocusEvent) => {
      const inside = [playerRef.current, cardRef.current].some((box) => box && event.target instanceof Node && box.contains(event.target));
      if (!inside) playerRef.current?.focus();
    };
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('focusin', onFocusIn);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('focusin', onFocusIn);
    };
  }, [running, advance, stopClock, startClock, beat]);

  // The page behind is modal to assistive technology as well as to the
  // pointer: everything beside the tour's own nodes is inert while it runs.
  useEffect(() => {
    if (!beat) return undefined;
    const parent = tourRef.current?.parentElement;
    if (!parent) return undefined;
    const others = Array.from(parent.children).filter((el) => !el.hasAttribute('data-demo-tour'));
    for (const el of others) el.setAttribute('inert', '');
    return () => { for (const el of others) el.removeAttribute('inert'); };
  }, [beat]);

  // Focus the player for every beat, once the page has settled.
  useEffect(() => {
    if (!beat) return undefined;
    const focusPlayer = () => playerRef.current?.focus({ preventScroll: true });
    const timer = window.setTimeout(focusPlayer, FOCUS_SETTLE_MS);
    return () => window.clearTimeout(timer);
  }, [beat]);

  // Tab wraps over the card's and the player's controls together.
  const onTrapKeyDown = (event: React.KeyboardEvent) => {
    if (event.key !== 'Tab') return;
    const controls = [cardRef.current, playerRef.current].flatMap((box) => Array.from(box?.querySelectorAll<HTMLElement>('button:not([disabled])') ?? []));
    if (controls.length === 0) return;
    const first = controls[0];
    const last = controls[controls.length - 1];
    const active = document.activeElement;
    if (event.shiftKey && (active === first || active === playerRef.current)) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && active === last) { event.preventDefault(); first.focus(); }
  };

  // ---- the end, by either door ---------------------------------------------
  const choiceRef = useRef<DemoTourFinishedDetail['choice']>(null);
  useEffect(() => {
    if (state.phase !== 'ended') return;
    stopClock();
    setTargetRect(null);
    const detail: DemoTourFinishedDetail = { ending: state.ending ?? 'finished', choice: choiceRef.current };
    choiceRef.current = null;
    const event = new CustomEvent<DemoTourFinishedDetail>(DEMO_TOUR_FINISHED_EVENT, { detail, cancelable: true });
    const handled = !window.dispatchEvent(event);
    if (PUBLIC_PREFIXES.some((prefix) => location.pathname.startsWith(prefix))) navigate('/');
    if (!handled && detail.choice === 'new-role') navigate('/roles/new');
    if (!handled && detail.choice === 'candidate') {
      openSampleInterview().catch((err: unknown) => setInterviewError(err instanceof Error ? err.message : 'The sample interview could not be opened.'));
    }
    setState(READY_TOUR);
  }, [state, stopClock, navigate, location.pathname]);

  useEffect(() => () => stopClock(), [stopClock]);

  const finishWith = (choice: DemoTourFinishedDetail['choice']) => {
    choiceRef.current = choice;
    setState((current) => ({ phase: 'ended', index: current.index, ending: 'finished' }));
  };

  if (!tenant?.isDemo || !user || !status) return null;

  const announcement = beat ? `${beatAnnouncement(beat, progress)} ${beat.caption}` : '';
  const isLast = running && state.index === offered.length - 1;
  const paused = state.phase === 'paused';

  const endControls = confirmEnd ? (
    <>
      <span className="small">End the demo and sign out?</span>
      <button type="button" className="btn sm secondary" onClick={() => void endDemo()}>Yes, end demo</button>
      <button type="button" className="btn sm ghost" onClick={() => setConfirmEnd(false)}>Keep going</button>
    </>
  ) : (
    <button type="button" className="btn sm secondary demo-end" onClick={() => setConfirmEnd(true)}>End demo</button>
  );

  return (
    <>
      <div className="visually-hidden" aria-live="polite" aria-atomic="true" data-demo-tour="live">{announcement}</div>

      {state.phase === 'ready' && showStart && (
        <div className="tour" onKeyDown={onTrapKeyDown} data-demo-tour="start">
          <div className="demo-scrim" aria-hidden="true" />
          <div ref={cardRef} className="demo-card" role="dialog" aria-modal="true" aria-labelledby={titleId} data-testid="demo-start-card">
            <div className="demo-card-kicker">Questor demo</div>
            <h2 id={titleId}>Hello{status.visitor.firstName ? `, ${status.visitor.firstName}` : ''}.</h2>
            <p>This is a five-minute story of one hire in Questor, told over the real product. Nothing plays until you press Start. Captions stay on throughout; you can pause, replay a line, or skip ahead at any time.</p>
            <div className="demo-card-actions">
              <button type="button" className="btn" autoFocus onClick={begin} data-testid="demo-start">Start the story</button>
              <button type="button" className="btn secondary" onClick={() => { rememberTourSeen(sessionStore()); setShowStart(false); }}>Skip — explore Questor instead</button>
              <button type="button" className="btn ghost" onClick={() => void endDemo()}>End demo</button>
            </div>
          </div>
        </div>
      )}

      {beat && (
        <div ref={tourRef} className={motion.animate ? 'tour is-animated' : 'tour'} onKeyDown={onTrapKeyDown} data-testid="demo-tour" data-demo-tour="run" data-beat={beat.id}>
          <div className="demo-scrim" aria-hidden="true" />
          {beat.anchor && targetRect && (
            <div
              className="tour-spotlight"
              aria-hidden="true"
              data-testid="demo-spotlight"
              style={{ top: targetRect.top - SPOTLIGHT_PADDING, left: targetRect.left - SPOTLIGHT_PADDING, width: targetRect.width + SPOTLIGHT_PADDING * 2, height: targetRect.height + SPOTLIGHT_PADDING * 2 }}
            />
          )}

          {beat.card === 'welcome' && (
            <div ref={cardRef} className="demo-card" role="dialog" aria-modal="true" aria-labelledby={`${titleId}-card`} data-testid="demo-card">
              <div className="demo-card-kicker">{progress.current} of {progress.total}</div>
              <h2 id={`${titleId}-card`}>One hire, start to finish</h2>
              <p>A role. A candidate. An interview. The evidence. A decision.</p>
            </div>
          )}

          {beat.card === 'explore' && (
            <div ref={cardRef} className="demo-card" role="dialog" aria-modal="true" aria-labelledby={`${titleId}-card`} data-testid="demo-card">
              <div className="demo-card-kicker">{progress.current} of {progress.total}</div>
              <h2 id={`${titleId}-card`}>Now it&rsquo;s yours</h2>
              <p>Open anything. Or paste a job description of your own under <strong>New role</strong> and watch Questor draft its scorecard.</p>
              <div className="demo-card-actions">
                <button type="button" className="btn" onClick={() => finishWith('new-role')}><Icon name="job-description" size={15} />New role</button>
                <button type="button" className="btn secondary" onClick={() => finishWith('explore')}>Explore</button>
              </div>
              <p className="demo-card-fine">{capsSentence(status.caps)} Sample data only; the sandbox is deleted afterwards.</p>
            </div>
          )}

          {beat.card === 'interview' && (
            <div ref={cardRef} className="demo-card" role="dialog" aria-modal="true" aria-labelledby={`${titleId}-card`} data-testid="demo-card">
              <div className="demo-card-kicker">The interview</div>
              <h2 id={`${titleId}-card`}>Sit in on one</h2>
              <div className="demo-card-actions is-stacked">
                {interviewChoices(status.modes).map((choice) => (
                  choice === 'candidate'
                    ? <button key={choice} type="button" className="btn" onClick={() => finishWith('candidate')}><Icon name="ai-interview" size={15} />Take the interview as the candidate &mdash; about 15 minutes</button>
                    : <button key={choice} type="button" className="btn secondary" onClick={() => finishWith('observer')}><Icon name="eye" size={15} />Watch an interview from the hiring team&rsquo;s side</button>
                ))}
                <button type="button" className="btn ghost" onClick={() => finishWith('explore')}>Explore first</button>
              </div>
            </div>
          )}

          <div
            ref={playerRef}
            className="demo-player"
            role="region"
            aria-label="Demo narration"
            tabIndex={-1}
            data-testid="demo-player"
          >
            <div className="demo-progress" aria-hidden="true"><i style={{ width: `${progress.percent}%` }} /></div>
            <div className="demo-player-inner">
              <div className="demo-count">
                {progress.current} / {progress.total}
                <small>{beat.title}</small>
              </div>
              <p id={captionId} className="demo-caption" data-testid="demo-caption">{beat.caption}</p>
              <div className="demo-controls">
                <button type="button" className="btn sm" onClick={() => setState((current) => (paused ? resumeDemoTour(current) : pauseDemoTour(current)))} aria-pressed={paused}>
                  <Icon name={paused ? 'play' : 'pause'} size={14} />{paused ? 'Resume' : 'Pause'}<kbd>Space</kbd>
                </button>
                <button type="button" className="btn sm secondary" onClick={() => { startClock(beat); setState((current) => resumeDemoTour(current)); }}>
                  <Icon name="refresh" size={14} />Replay<kbd>R</kbd>
                </button>
                <button type="button" className="btn sm ghost" onClick={() => { stopClock(); setState((current) => previousBeat(current)); }} disabled={state.index === 0}>
                  <Icon name="arrow-left" size={14} />Back<kbd>&larr;</kbd>
                </button>
                <button type="button" className="btn sm ghost" onClick={advance} data-testid="demo-next">
                  {isLast ? <><Icon name="check" size={14} />Finish</> : <>Skip beat<Icon name="arrow-right" size={14} /></>}<kbd>&rarr;</kbd>
                </button>
                <button type="button" className="btn sm ghost" onClick={() => setState((current) => skipDemoTour(current))} data-testid="demo-skip-tour">
                  <Icon name="close" size={14} />Skip the tour<kbd>Esc</kbd>
                </button>
                {endControls}
              </div>
            </div>
          </div>
        </div>
      )}

      {interviewError && <div className="visually-hidden" role="alert">{interviewError}</div>}
    </>
  );
}
