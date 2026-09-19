import type { ComposerMode } from './roomComposerModel';
import type { RoomPhase } from './roomConversationModel';
import type { useAnswerMode } from './useAnswerMode';
import type { useVoiceAnswer } from './useVoiceAnswer';

/**
 * The candidate's own controls over how they answer: switching between
 * speaking, typing and code, pausing to take a moment, and hearing the
 * question again. None of these may lose what was already said or typed.
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
  /** Say the current question again; `continueAnswer` keeps the answer under way. */
  readonly replayQuestion: (continueAnswer: boolean) => void;
}

export function useAnswerControls(d: AnswerControlDeps) {
  const { voice, answerMode } = d;

  /**
   * Switching to the keyboard mid-answer. Everything said so far joins the
   * draft after whatever was already typed — never instead of it, and never
   * submitted over the top of someone who has just decided to type.
   */
  const switchToTyping = async () => {
    d.setInterim('');
    answerMode.setTextMode(true);
    if (d.phaseRef.current === 'thinking' && !voice.turnClosedRef.current) d.setPhase('listening');
    await voice.releaseToTyping();
  };

  /**
   * Switching to speaking. The typed words go into the spoken answer — shown
   * as the start of it, and sent with it — rather than hidden in a box the
   * candidate can no longer see and then erased when the answer is sent.
   */
  const switchToSpeaking = () => {
    voice.carryIn(d.typed);
    if (d.typed) d.setTyped('');
    answerMode.setTextMode(false);
    if (d.phaseRef.current === 'listening' && !d.pausedRef.current) void voice.beginListening({ resume: true });
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

  const selectMode = async (next: ComposerMode) => {
    answerMode.choose();
    if (next !== 'speak') {
      answerMode.setCodeMode(next === 'code');
      if (!answerMode.textModeRef.current) await switchToTyping();
      return;
    }
    if (d.speakUnavailableRef.current) return;
    answerMode.setCodeMode(false);
    if (answerMode.textModeRef.current) switchToSpeaking();
  };

  /**
   * Hear the question again. An answer already under way — including one
   * interrupted by a check-in, when nothing is listening — carries on after
   * it, with what was said so far kept.
   */
  const repeat = async () => {
    const continueAnswer = voice.answerInProgress();
    await voice.holdCapture();
    d.replayQuestion(continueAnswer);
  };

  return { pause, resume, selectMode, repeat };
}
