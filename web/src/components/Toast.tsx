import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Icon } from './Icon';
import {
  addToast,
  msUntilDone,
  pauseCountdown,
  removeToast,
  resumeCountdown,
  startCountdown,
  TOAST_LEAVE_MS,
  type ToastItem,
  type ToastOptions,
} from './toastModel';

/**
 * The one toast system. Every "done, nothing more to do" confirmation goes
 * through here, so the rule (fades after ~4s, pauses on hover and focus,
 * optional Undo, announced politely) is applied the same way everywhere.
 * Things still waiting on someone stay banners (components/ui.tsx Banner).
 */

export interface ToastApi {
  /** Show a confirmation. Returns its id. */
  show: (message: ReactNode, options?: ToastOptions) => number;
  dismiss: (id: number) => void;
}

// Outside a provider (a component rendered on its own in a test) a toast has
// nowhere to go; that is not an error worth failing the render over.
const ToastContext = createContext<ToastApi>({ show: () => -1, dismiss: () => undefined });

export function useToast(): ToastApi {
  return useContext(ToastContext);
}

function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

function ToastView({ toast, onDone }: { toast: ToastItem; onDone: (id: number) => void }) {
  const [leaving, setLeaving] = useState(false);
  // Bumped whenever the countdown is paused or resumed, to reschedule the timer.
  const [revision, setRevision] = useState(0);
  const countdown = useRef(startCountdown(Date.now()));
  const hovered = useRef(false);
  const focused = useRef(false);

  useEffect(() => {
    if (leaving) return undefined;
    const wait = msUntilDone(countdown.current, Date.now());
    if (wait === null) return undefined;
    const timer = window.setTimeout(() => setLeaving(true), wait);
    return () => window.clearTimeout(timer);
  }, [revision, leaving]);

  useEffect(() => {
    if (!leaving) return undefined;
    const timer = window.setTimeout(() => onDone(toast.id), prefersReducedMotion() ? 0 : TOAST_LEAVE_MS);
    return () => window.clearTimeout(timer);
  }, [leaving, onDone, toast.id]);

  const hold = () => {
    countdown.current = pauseCountdown(countdown.current, Date.now());
    setRevision((n) => n + 1);
  };
  const release = () => {
    if (hovered.current || focused.current) return;
    countdown.current = resumeCountdown(countdown.current, Date.now());
    setRevision((n) => n + 1);
  };

  const undo = toast.undo;
  return (
    <div
      className={leaving ? 'toast is-leaving' : 'toast'}
      data-testid={toast.testId}
      onMouseEnter={() => { hovered.current = true; hold(); }}
      onMouseLeave={() => { hovered.current = false; release(); }}
      onFocus={() => { focused.current = true; hold(); }}
      onBlur={(e) => {
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
        focused.current = false;
        release();
      }}
    >
      <Icon name="check" size={16} className="toast-icon" />
      <div className="toast-message">{toast.message}{toast.action ? <> {toast.action}</> : null}</div>
      {undo && (
        <button type="button" className="toast-undo" onClick={() => { undo.run(); onDone(toast.id); }}>
          {undo.label ?? 'Undo'}
        </button>
      )}
      <button type="button" className="toast-close" aria-label="Dismiss" onClick={() => setLeaving(true)}>
        <Icon name="close" size={14} />
      </button>
    </div>
  );
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<readonly ToastItem[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => setToasts((list) => removeToast(list, id)), []);
  const show = useCallback((message: ReactNode, options?: ToastOptions) => {
    const id = nextId.current;
    nextId.current += 1;
    setToasts((list) => addToast(list, { id, message, ...options }));
    return id;
  }, []);
  const api = useMemo(() => ({ show, dismiss }), [show, dismiss]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      {/* Always in the document, so a screen reader is already watching it
          when the first toast arrives; polite, because nothing here is urgent. */}
      <div className="toast-region" role="status" aria-live="polite" aria-label="Notifications">
        {toasts.map((t) => <ToastView key={t.id} toast={t} onDone={dismiss} />)}
      </div>
    </ToastContext.Provider>
  );
}
