import { useCallback, useEffect, useState } from 'react';
import { api } from '../../api/client';
import type { RoomPhase } from './roomConversationModel';
import type { FeedbackState } from './RoomPanels';

type IntegrityEvent = 'TAB_BLUR' | 'FOCUS_LOST' | 'PASTE_DETECTED';

/** Browser-integrity signals while the interview is live, when the tenant has proctoring on. */
export function useIntegrityEvents(token: string, enabled: boolean, phase: RoomPhase): void {
  const send = useCallback((type: IntegrityEvent) => {
    // Fire-and-forget by design: browser-integrity telemetry must never make the
    // interview feel broken to the candidate. The server gates this on consent
    // and tenant policy before storing anything.
    void fetch(`/api/portal/${token}/integrity-event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type }),
      credentials: 'include',
    }).catch(() => undefined);
  }, [token]);

  useEffect(() => {
    if (!enabled || phase === 'ready' || phase === 'done') return undefined;
    const onVisibility = () => { if (document.hidden) send('TAB_BLUR'); };
    const onBlur = () => send('FOCUS_LOST');
    // Pasting into the typed-answer box is a legitimate, expected way to answer
    // — not an integrity signal. Flagging it would penalize exactly the
    // candidates this accommodation exists to support.
    const onPaste = (e: ClipboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.getAttribute('data-answer-input') === 'true') return;
      send('PASTE_DETECTED');
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('blur', onBlur);
    document.addEventListener('paste', onPaste);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('blur', onBlur);
      document.removeEventListener('paste', onPaste);
    };
  }, [enabled, phase, send]);
}

/**
 * The end-of-interview feedback question. `choice` is null until an answer is
 * on file; once there is one the question is not put again, either way.
 */
export function useFeedbackOptIn(token: string, offered: boolean, onFile: string | null): FeedbackState {
  const [choice, setChoice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  // A candidate who already answered — on another device, or before a reload —
  // is shown their answer rather than the question again.
  useEffect(() => { setChoice(onFile); }, [onFile]);

  // The server decides what sticks — a replay returns the answer already on
  // file — so this takes its result rather than assuming the click won.
  const onAnswer = useCallback(async (wantsFeedback: boolean) => {
    setSaving(true);
    setError('');
    try {
      const res = await api.post<{ optIn: { choice: string } }>(`/portal/${token}/feedback-opt-in`, { wantsFeedback });
      setChoice(res.optIn.choice);
    } catch {
      // Never a blocking error: the interview is already safely submitted and
      // this question is an extra. Offer a way through that does not depend on us.
      setError('We could not record that just now — please reply to your invitation email instead.');
    } finally {
      setSaving(false);
    }
  }, [token]);

  return { offered, choice, saving, error, onAnswer: (wants) => { void onAnswer(wants); } };
}

/**
 * Keep the room the size of the visible viewport. A phone keyboard shrinks
 * the visual viewport but not the layout one, so a full-height fixed room
 * would put the composer — and the Send button — under the keyboard.
 */
const COMPACT_BELOW_PX = 560;

export function useVisualViewport(): void {
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return undefined;
    const html = document.documentElement;
    const root = html.style;
    const update = () => {
      root.setProperty('--room-vh', `${vv.height}px`);
      root.setProperty('--room-top', `${vv.offsetTop}px`);
      // Too short for everything (typically a keyboard is open): the room
      // gives the answer box the space and folds away what can wait.
      html.toggleAttribute('data-room-compact', vv.height < COMPACT_BELOW_PX);
    };
    update();
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    return () => {
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
      root.removeProperty('--room-vh');
      root.removeProperty('--room-top');
      html.removeAttribute('data-room-compact');
    };
  }, []);
}
