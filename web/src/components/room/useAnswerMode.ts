import { useCallback, useRef, useState } from 'react';
import { composerMode, isCodingQuestion, modeForNewQuestion, type ComposerMode } from './roomComposerModel';

/** State that callbacks created on an earlier render must read current, not as it was then. */
export function useRefState<T>(initial: T): [T, (value: T) => void, { readonly current: T }] {
  const [value, setValue] = useState(initial);
  const ref = useRef(initial);
  const set = useCallback((next: T) => { ref.current = next; setValue(next); }, []);
  return [value, set, ref];
}

/**
 * How the candidate is answering: speaking, typing, or writing code.
 *
 * `textMode` keeps its long-standing meaning (not answering by voice), so the
 * capture code and every fallback that forces typing are untouched; the code
 * editor is a flavour of typing on top of it.
 */
export function useAnswerMode(speakUnavailableRef: { readonly current: string | null }) {
  const [textMode, setTextMode, textModeRef] = useRefState(false);
  const [codeMode, setCodeMode, codeModeRef] = useRefState(false);
  const [nudge, setNudge] = useState<string | null>(null);
  // The mode the room switched away from on its own for a coding question.
  const autoFromRef = useRef<ComposerMode | null>(null);

  /** A new interviewer turn: suggest the code editor for a coding question. */
  const applyQuestionMode = useCallback((text: string) => {
    const next = modeForNewQuestion({
      mode: composerMode(textModeRef.current, codeModeRef.current),
      autoFrom: autoFromRef.current,
      coding: isCodingQuestion(text),
      canSpeak: speakUnavailableRef.current === null,
    });
    autoFromRef.current = next.autoFrom;
    setNudge(next.nudge);
    setCodeMode(next.mode === 'code');
    setTextMode(next.mode !== 'speak');
  }, [textModeRef, codeModeRef, speakUnavailableRef, setCodeMode, setTextMode]);

  /** The candidate chose a mode: the room's own suggestion no longer applies. */
  const choose = useCallback(() => {
    autoFromRef.current = null;
    setNudge(null);
  }, []);

  return {
    mode: composerMode(textMode, codeMode),
    textMode, setTextMode, textModeRef, codeMode, setCodeMode, nudge, applyQuestionMode, choose,
  };
}
