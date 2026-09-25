import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { api } from '../../api/client';
import { useAuth } from '../../auth';
import { useTour } from '../tourContext';
import { TourOverlay } from '../TourOverlay';
import { IDLE_TOUR, startTour, tourHasEnded, type AnchorPresence, type TourState } from '../tourModel';
import { DEMO_BEATS } from './demoScript';
import { demoSteps, rememberTourSeen, tourAlreadySeen, type DemoStatus } from './demoTourModel';
import { endDemo } from './endDemo';

const PUBLIC_PREFIXES = ['/o/', '/signup'];

// Every offered beat counts. Its element cannot be asked for before its screen
// is reached; the overlay skips a beat whose screen never produces it.
const everyBeat: AnchorPresence = () => true;

function sessionStore(): Storage | null {
  try { return window.sessionStorage; } catch { return null; }
}

/**
 * The guided demo for a visitor: the story in demoScript.ts, shown by the
 * product tour's own overlay — a card beside each element, read and stepped
 * through at the visitor's pace. This decides when it runs and where its
 * ending leads.
 *
 * Mounted above both shells (the app's and the public pages'), because two
 * beats are shown over the organisation's sign-in page and the account request.
 */
export function DemoTour() {
  const { tenant, user } = useAuth();
  const { startRequest } = useTour();
  const location = useLocation();
  const navigate = useNavigate();

  const [status, setStatus] = useState<DemoStatus | null>(null);
  const [state, setState] = useState<TourState>(IDLE_TOUR);
  const [confirmEnd, setConfirmEnd] = useState(false);
  const autoStartedRef = useRef(false);
  const handledRequestRef = useRef(0);
  const choiceRef = useRef<string | null>(null);

  const steps = useMemo(() => (status ? demoSteps(DEMO_BEATS, status) : []), [status]);

  useEffect(() => {
    if (!tenant?.isDemo || !user) return undefined;
    let cancelled = false;
    api.get<DemoStatus>('/demo/status').then((loaded) => { if (!cancelled) setStatus(loaded); }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [tenant?.isDemo, user]);

  const begin = useCallback(() => {
    rememberTourSeen(sessionStore());
    setState(startTour(steps, everyBeat));
  }, [steps]);

  // Once the sandbox has answered, the story begins by itself — once per
  // browser session, so a reload while exploring does not restart it.
  useEffect(() => {
    if (autoStartedRef.current || steps.length === 0) return;
    autoStartedRef.current = true;
    if (!tourAlreadySeen(sessionStore())) begin();
  }, [steps, begin]);

  // "Replay the story" on the demo bar. A request made before the sandbox
  // has answered is kept until it has.
  useEffect(() => {
    if (startRequest === handledRequestRef.current || steps.length === 0) return;
    handledRequestRef.current = startRequest;
    begin();
  }, [startRequest, steps, begin]);

  useEffect(() => setConfirmEnd(false), [state.index]);

  // The end, by either door: back from the public pages, then wherever the
  // visitor's choice on a closing card leads.
  useEffect(() => {
    if (!tourHasEnded(state)) return;
    const choice = choiceRef.current;
    choiceRef.current = null;
    if (PUBLIC_PREFIXES.some((prefix) => location.pathname.startsWith(prefix))) navigate('/');
    if (choice === 'new-role') navigate('/roles/new');
    // Both interview choices go through the demo-interview lane's own start,
    // which is the only thing that plans the sitting for fifteen minutes,
    // claims its model allowance and records the run. The mode the visitor
    // picked here is carried in the address so they are not asked twice.
    if (choice === 'candidate' || choice === 'observer') navigate(`/demo/interview?start=${choice}`);
    setState(IDLE_TOUR);
  }, [state, navigate, location.pathname]);

  if (!tenant?.isDemo || !user || !status) return null;

  // Ending is the demo bar's own control too (components/demo/endDemo.ts);
  // here because the bar is not on the public pages, and a visitor needs the
  // way out wherever the story has taken them.
  const footer = confirmEnd ? (
    <>
      <span className="small">End the demo and sign out?</span>
      <button type="button" className="btn sm secondary" onClick={() => void endDemo()}>Yes, end demo</button>
      <button type="button" className="btn sm ghost" onClick={() => setConfirmEnd(false)}>Keep going</button>
    </>
  ) : (
    <button type="button" className="btn sm ghost tour-end" onClick={() => setConfirmEnd(true)} data-testid="demo-end">End demo</button>
  );

  return (
    <TourOverlay
      steps={steps}
      state={state}
      setState={setState}
      present={everyBeat}
      onChoice={(choice) => { choiceRef.current = choice.id; }}
      footer={footer}
    />
  );
}
