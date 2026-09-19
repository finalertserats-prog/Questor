import type { ComposerMode } from './roomComposerModel';
import type { RoomPhase } from './roomConversationModel';
import type { useAnswerMode } from './useAnswerMode';
import type { useVoiceAnswer } from './useVoiceAnswer';

/**
 * The candidate's own controls over how they answer: switching between
 * speaking, typing and code, and pausing to take a moment. None of these may
 * lose what was already said or typed.
 */
export interface AnswerControlDeps {
  readonly voice: ReturnType<typeof useVoiceAnswer>;
  readonly answerMode: ReturnType<typeof useAnswerMode>;
  readonly typed: string;
  readonly setTyped: (text: string) => void;
  readonly setInterim: (text: string) => void;
  readonly setPaused: (paused: boolean) => void;
  readonly pausedRef: { readonly current: boolean };
  readonly phaseRef: { readonly current: RoomPhase };
  readonly setPhase: (phase: RoomPhase) => void;
  readonly speakUnavailableRef: { readonly current: string | null };
}

export function useAnswerControls(d: AnswerControlDeps) {
  const { voice, answerMode } = d;

  /**
   * Switching to the keyboard mid-answer. Anything already heard is put in the
   * box to keep or edit, rather than submitted over the top of someone who has
   * just decided to type.
   */
  const switchToTyping = () => {
    const heard = voice.discardCapture();
    if (heard) d.setTyped(d.typed.trim() ? d.typed : heard);
    d.setInterim('');
    answerMode.setTextMode(true);
    if (d.phaseRef.current === 'thinking' && !voice.turnClosedRef.current) d.setPhase('listening');
  };

  /** A client-side pause: listening stops, and what was heard is kept for when they carry on. */
  const pause = async () => {
    if (d.phaseRef.current !== 'listening' || voice.turnClosedRef.current) return;
    d.setPaused(true);
    if (!answerMode.textModeRef.current) await voice.holdCapture();
  };

  const resume = () => {
    d.setPaused(false);
    if (!answerMode.textModeRef.current && d.phaseRef.current === 'listening') void voice.beginListening({ resume: true });
  };

  const selectMode = (next: ComposerMode) => {
    answerMode.choose();
    if (next !== 'speak') {
      answerMode.setCodeMode(next === 'code');
      if (!answerMode.textModeRef.current) switchToTyping();
      return;
    }
    if (d.speakUnavailableRef.current) return;
    answerMode.setCodeMode(false);
    if (!answerMode.textModeRef.current) return;
    answerMode.setTextMode(false);
    if (d.phaseRef.current === 'listening' && !d.pausedRef.current) void voice.beginListening({ resume: true });
  };

  return { pause, resume, selectMode };
}
