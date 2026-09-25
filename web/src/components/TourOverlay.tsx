import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type Dispatch, type ReactNode, type SetStateAction } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Icon } from './Icon';
import {
  finishTour,
  giveUpStep,
  isFirstStep,
  isLastStep,
  keyAction,
  needsDrawer,
  nextStep,
  placeTourCard,
  previousStep,
  shouldGiveUp,
  skipTour,
  stepAnnouncement,
  stepPosition,
  tourMotion,
  type AnchorPresence,
  type AnchorSighting,
  type CardPlacement,
  type Rect,
  type TourChoice,
  type TourState,
  type TourStep,
  type TourTravel,
} from './tourModel';

const SPOTLIGHT_PADDING = 6;
const REDUCED_MOTION = '(prefers-reduced-motion: reduce)';
// Long enough for the drawer to have opened or closed and the page behind it
// to have stopped being inert, short enough not to be noticed.
const FOCUS_SETTLE_MS = 50;
const DRAWER_SETTLE_MS = 250;
// Whether a step's element is worth waiting for any longer, and which way the
// reader is then carried, are tourModel's (shouldGiveUp, giveUpStep). This is
// only how often we look.
const ANCHOR_POLL_MS = 100;

/** The element a step points at — and only if it is laid out: a hidden tab panel's element is not on the page. */
export function anchorElement(anchor: string | undefined): HTMLElement | null {
  if (anchor === undefined) return null;
  const candidates = document.querySelectorAll<HTMLElement>(`[data-tour="${anchor}"]`);
  for (const element of candidates) if (element.getClientRects().length > 0) return element;
  return null;
}

export const anchorPresent: AnchorPresence = (anchor) => anchor === undefined || anchorElement(anchor) !== null;

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => {
    try {
      return window.matchMedia(REDUCED_MOTION).matches;
    } catch {
      return false;
    }
  });
  useEffect(() => {
    let query: MediaQueryList;
    try {
      query = window.matchMedia(REDUCED_MOTION);
    } catch {
      return undefined;
    }
    const onChange = (event: MediaQueryListEvent) => setReduced(event.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);
  return reduced;
}

const sameRect = (a: Rect | null, b: Rect | null) =>
  a === b || (a !== null && b !== null && a.top === b.top && a.left === b.left && a.width === b.width && a.height === b.height);

const samePlacement = (a: CardPlacement, b: CardPlacement) => a.top === b.top && a.left === b.left && a.placement === b.placement;

interface TourOverlayProps {
  readonly steps: readonly TourStep[];
  readonly state: TourState;
  readonly setState: Dispatch<SetStateAction<TourState>>;
  /** Which steps count as showable: for the product tour, those whose element is on the page. */
  readonly present: AnchorPresence;
  /** Below the sidebar breakpoint, where the sidebar is a drawer. */
  readonly isNarrow?: boolean;
  /** Opens or closes that drawer, for steps that point into it. */
  readonly setDrawerOpen?: (open: boolean) => void;
  /** A choice on the card was taken; the tour then ends. */
  readonly onChoice?: (choice: TourChoice) => void;
  /** Under the card's own controls, kept apart from them by a rule: the demo's way out. */
  readonly footer?: ReactNode;
}

/**
 * A guided tour's presentation: a spotlight on one element at a time with a
 * coach-mark card beside it, carrying a title, a sentence, where the reader is
 * and Back, Next and Skip. The reader moves at their own pace; nothing here
 * advances on its own.
 *
 * Which steps exist and how they progress is decided in tourModel; who starts
 * the tour and what happens when it ends is the caller's (ProductTour for a
 * signed-in user, demo/DemoTour for a visitor). This component measures the
 * page, draws, and keeps keyboard focus inside. A step that names a screen is
 * taken there first, and its card waits for the element to arrive.
 */
export function TourOverlay({ steps, state, setState, present, isNarrow = false, setDrawerOpen, onChoice, footer }: TourOverlayProps) {
  const location = useLocation();
  const navigate = useNavigate();
  const reducedMotion = usePrefersReducedMotion();
  const titleId = useId();
  const bodyId = useId();

  const [targetRect, setTargetRect] = useState<Rect | null>(null);
  const [card, setCard] = useState<CardPlacement>({ top: 0, left: 0, placement: 'center' });
  // The step's element is on the page (a centred step needs none). This governs
  // the SPOTLIGHT only. The card renders either way — see the invariant on the
  // render below: a scrim is never drawn without a way out on top of it.
  const [found, setFound] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);
  // Which way the reader is travelling, so a step that cannot be shown is given
  // up in the direction they were going. Skipping always forwards meant Back
  // onto an unshowable step bounced them straight forwards again, with no way
  // past it: the end of a tour became a one-way door.
  const travelRef = useRef<TourTravel>(1);
  // Read as a step begins, so the change of address it causes does not
  // restart it (navigate itself takes a new identity on every move).
  const hereRef = useRef('');
  hereRef.current = `${location.pathname}${location.search}`;
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;

  const running = state.status === 'running';
  const step = running ? steps[state.index] ?? null : null;
  const motion = tourMotion(reducedMotion);

  // Each step: go to its screen if it names one, open or close the phone
  // drawer as it needs, then find its element and bring it into view.
  // Measuring happens continuously below, so a drawer still sliding in or a
  // page still scrolling is caught up with.
  useEffect(() => {
    if (!step) return undefined;
    setFound(step.anchor === undefined);
    if (step.route !== undefined && hereRef.current !== step.route) navigateRef.current(step.route);
    setDrawerOpen?.(needsDrawer(step, isNarrow));
    const anchor = step.anchor;
    if (anchor === undefined) return undefined;
    const since = Date.now();
    let poll: number | undefined;
    const look = () => {
      const element = anchorElement(anchor);
      if (element) {
        element.scrollIntoView({ block: 'center', inline: 'nearest', behavior: motion.scrollBehavior });
        setFound(true);
        return;
      }
      // Not there. Whether that is "not yet" or "not at all" is the model's
      // call, on what can be seen right now — `anchor` is false because the
      // case above already returned. When it is "not at all", the step is
      // given up carrying on the way the reader was already going.
      const seen: AnchorSighting = {
        anchor: false,
        settledBy: step.anchorSettledBy !== undefined && anchorElement(step.anchorSettledBy) !== null,
        waitedMs: Date.now() - since,
      };
      if (shouldGiveUp(step, seen)) {
        setState((current) => giveUpStep(current, steps, travelRef.current, present));
        return;
      }
      poll = window.setTimeout(look, ANCHOR_POLL_MS);
    };
    look();
    return () => window.clearTimeout(poll);
  }, [step, steps, present, isNarrow, setDrawerOpen, motion.scrollBehavior, setState]);

  // Focus the card for every step. Synchronously, so it holds even where
  // animation frames are throttled (a background tab); and once more a moment
  // later, since the drawer focuses its own close button as it opens and the
  // focus trap below only guards against focus leaving afterwards.
  useEffect(() => {
    // Not gated on `found`: the card is there from the first frame of a step,
    // so focus is too, and the reader can always Tab to a way out.
    if (!step) return undefined;
    // The card is fixed to the viewport; focusing it must not cut short the
    // page's own scroll towards the element.
    const focusCard = () => cardRef.current?.focus({ preventScroll: true });
    focusCard();
    const timer = window.setTimeout(focusCard, FOCUS_SETTLE_MS);
    return () => window.clearTimeout(timer);
  }, [step, found]);

  // Where the element and the card are. State only changes when a number
  // actually moves, so calling this often is cheap.
  const measure = useCallback(() => {
    if (!step) return;
    const element = anchorElement(step.anchor);
    const box = element?.getBoundingClientRect();
    const next: Rect | null = box ? { top: box.top, left: box.left, width: box.width, height: box.height } : null;
    setTargetRect((current) => (sameRect(current, next) ? current : next));
    const cardBox = cardRef.current?.getBoundingClientRect();
    if (cardBox) {
      const placed = placeTourCard(next, { width: cardBox.width, height: cardBox.height }, { width: window.innerWidth, height: window.innerHeight });
      setCard((current) => (samePlacement(current, placed) ? current : placed));
    }
  }, [step]);

  // Measured before paint on every step, so the card never shows at its
  // previous position first...
  useLayoutEffect(() => {
    if (!step) {
      setTargetRect(null);
      return;
    }
    measure();
  }, [step, found, measure]);

  // ...then kept in step with scrolling and resizing, and with anything else
  // that moves — a drawer sliding in, a chart arriving with its data — by an
  // animation-frame loop while the tour runs.
  useEffect(() => {
    if (!step) return undefined;
    let frame = 0;
    const tick = () => {
      measure();
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    // The drawer's slide takes 0.2s; this catches its resting place even where
    // frames are throttled.
    const settled = window.setTimeout(measure, DRAWER_SETTLE_MS);
    window.addEventListener('scroll', measure, true);
    window.addEventListener('resize', measure);
    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(settled);
      window.removeEventListener('scroll', measure, true);
      window.removeEventListener('resize', measure);
    };
  }, [step, measure]);

  // Keyboard: Escape skips, the arrow keys step, and focus cannot leave the
  // card. Capture phase, so the sidebar's own Escape (which closes the drawer)
  // and the page underneath never see these keys.
  useEffect(() => {
    if (!running) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      const action = keyAction(event.key);
      if (!action) return;
      event.preventDefault();
      event.stopPropagation();
      if (action === 'skip') setState((current) => skipTour(current));
      else if (action === 'next') {
        travelRef.current = 1;
        setState((current) => nextStep(current, steps, present));
      } else {
        travelRef.current = -1;
        setState((current) => previousStep(current, steps, present));
      }
    };
    const onFocusIn = (event: FocusEvent) => {
      const dialog = cardRef.current;
      if (dialog && event.target instanceof Node && !dialog.contains(event.target)) dialog.focus();
    };
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('focusin', onFocusIn);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('focusin', onFocusIn);
    };
  }, [running, steps, present, setState]);

  // Tab wraps within the card's controls, so it cannot reach the page behind.
  const onCardKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Tab') return;
    const controls = Array.from(cardRef.current?.querySelectorAll<HTMLElement>('button:not([disabled])') ?? []);
    if (controls.length === 0) return;
    const first = controls[0];
    const last = controls[controls.length - 1];
    const active = document.activeElement;
    if (event.shiftKey && (active === first || active === cardRef.current)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const choose = (choice: TourChoice) => {
    onChoice?.(choice);
    setState((current) => finishTour(current));
  };

  const goNext = () => {
    travelRef.current = 1;
    setState((current) => nextStep(current, steps, present));
  };
  const goBack = () => {
    travelRef.current = -1;
    setState((current) => previousStep(current, steps, present));
  };

  const position = step ? stepPosition(state, steps, present) : null;
  const announcement = step && position ? stepAnnouncement(step, position) : '';

  return (
    <>
      {/* Always present so assistive technology has it registered before the
          first step is announced into it. */}
      <div className="visually-hidden" aria-live="polite" aria-atomic="true">{announcement}</div>
      {step && position && (
        <div className={motion.animate ? 'tour is-animated' : 'tour'} data-testid="tour" data-step={step.id}>
          <div className="tour-scrim" aria-hidden="true" />
          {found && targetRect && (
            <div
              className="tour-spotlight"
              aria-hidden="true"
              data-testid="tour-spotlight"
              style={{
                top: targetRect.top - SPOTLIGHT_PADDING,
                left: targetRect.left - SPOTLIGHT_PADDING,
                width: targetRect.width + SPOTLIGHT_PADDING * 2,
                height: targetRect.height + SPOTLIGHT_PADDING * 2,
              }}
            />
          )}
          {/* THE INVARIANT: while a step is running the card is always drawn.
              The scrim above blocks the page to a pointer and the trap below
              holds the keyboard, so a scrim without a card is a reader shut
              inside an invisible box with nothing to press — which is what a
              missing anchor used to produce, for six seconds, on a page that
              looked ordinary. The spotlight is what waits for the element; the
              way out never does.

              WHAT IT COSTS, on every anchored step and not just the broken
              ones: a step that navigates has no element until its screen
              renders, so for that moment the card is centred (and `is-center`
              carries the darkening) over the page being left, describing the
              page arriving, before it moves to the element. Paid knowingly.
              The alternative on offer was hiding the card until the anchor
              lands, and that is exactly the trap above — there is no length of
              time for which it is acceptable to show a reader a blocked page
              and no way off it. */}
          <div
            ref={cardRef}
            className={`tour-card is-${card.placement}`}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            aria-describedby={bodyId}
            tabIndex={-1}
            style={card.placement === 'sheet' ? undefined : { top: card.top, left: card.left }}
            onKeyDown={onCardKeyDown}
            data-testid="tour-card"
          >
            <div className="tour-progress">
              <Icon name="tour" size={14} />
              Step {position.current} of {position.total}
            </div>
            <h2 id={titleId} className="tour-title">{step.title}</h2>
            <p id={bodyId} className="tour-body">{step.body}</p>
            {step.choices && step.choices.length > 0 && (
              <div className="tour-choices">
                {step.choices.map((choice) => (
                  <button
                    key={choice.id}
                    type="button"
                    className={choice.emphasis === 'secondary' ? 'btn sm secondary' : 'btn sm'}
                    onClick={() => choose(choice)}
                    data-testid={`tour-choice-${choice.id}`}
                  >
                    {choice.icon && <Icon name={choice.icon} size={14} />}{choice.label}
                  </button>
                ))}
              </div>
            )}
            {step.note && <p className="tour-note">{step.note}</p>}
            <div className="tour-actions">
              <button type="button" className="btn sm secondary tour-skip" onClick={() => setState((current) => skipTour(current))} data-testid="tour-skip">
                <Icon name="close" size={14} />Skip tour
              </button>
              <span className="row tour-steps">
                {!isFirstStep(state, steps, present) && (
                  <button type="button" className="btn sm secondary" onClick={goBack} data-testid="tour-back">
                    <Icon name="arrow-left" size={14} />Back
                  </button>
                )}
                {isLastStep(state, steps, present) ? (
                  <button type="button" className="btn sm" onClick={goNext} data-testid="tour-next">
                    <Icon name="check" size={14} />Finish
                  </button>
                ) : (
                  <button type="button" className="btn sm" onClick={goNext} data-testid="tour-next">
                    Next<Icon name="arrow-right" size={14} />
                  </button>
                )}
              </span>
            </div>
            {footer && <div className="tour-footer">{footer}</div>}
          </div>
        </div>
      )}
    </>
  );
}
