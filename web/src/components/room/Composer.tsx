import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Icon } from '../Icon';
import { useVoiceFrames } from './SpeakingRing';
import { composerHint, insertIndent, type ComposerMode } from './roomComposerModel';
import type { RoomPhase } from './roomConversationModel';

const MODES: ReadonlyArray<{ mode: ComposerMode; label: string; icon: 'mic' | 'keyboard' | 'build' }> = [
  { mode: 'speak', label: 'Speak', icon: 'mic' },
  { mode: 'type', label: 'Type', icon: 'keyboard' },
  { mode: 'code', label: 'Code', icon: 'build' },
];

const KEY_NAMES = /(Ctrl\+Enter|Tab|Esc)/;

/**
 * How long the recognizer's words must stop changing before the read-back
 * says them.
 *
 * HOW A BLIND CANDIDATE CONFIRMS WHAT WE HEARD — a deliberate choice.
 *
 * Interim recognition results arrive several times a second and are rewritten
 * as the recognizer changes its mind. Putting that stream in a live region
 * would bury the candidate under half-words for the whole of their answer,
 * which is worse than saying nothing. Never exposing it at all is worse still:
 * a sighted candidate can glance at the box and see "we ran both side by side"
 * and know they are being heard, and a blind candidate had no equivalent.
 *
 * So there are two paths, and the candidate picks:
 *
 *   1. ALWAYS, silently — the words sit in a labelled region ("What we heard
 *      you say") a screen reader can jump to at any moment, and focus is put
 *      there the instant the candidate presses "Done answering", so the last
 *      thing they hear before the answer goes is what we think they said.
 *   2. ON REQUEST — "Read back what I say" turns on a polite live region that
 *      speaks only text that has stopped changing for READ_BACK_SETTLE_MS,
 *      i.e. finished phrases rather than every partial guess.
 *
 * Off by default, because an interview is stressful enough without a second
 * voice over your own; reachable always, because being unable to check is
 * worse than being interrupted.
 */
export const READ_BACK_SETTLE_MS = 1_200;

/** Text that has stopped changing for `ms`; empty until it settles. */
function useSettledText(text: string, ms: number): string {
  const [settled, setSettled] = useState('');
  useEffect(() => {
    if (!text) { setSettled(''); return undefined; }
    const timer = window.setTimeout(() => setSettled(text), ms);
    return () => window.clearTimeout(timer);
  }, [text, ms]);
  return settled;
}

/** The hint with its key names set as keys. */
function Hint({ text, id }: { text: string; id: string }) {
  return (
    <span className="room-hint" id={id}>
      {text.split(KEY_NAMES).map((part, i) => (KEY_NAMES.test(part) ? <kbd key={i}>{part}</kbd> : part))}
    </span>
  );
}

function voicePrompt(phase: RoomPhase, interim: string): string {
  if (interim) return interim;
  if (phase === 'speaking') return 'Listen to the question…';
  if (phase === 'thinking') return 'One moment…';
  return 'Your turn — answer out loud, then press the microphone when you’re done.';
}

export interface ComposerProps {
  readonly mode: ComposerMode;
  /** Why speaking is unavailable, or null when it is available. */
  readonly speakUnavailable: string | null;
  readonly phase: RoomPhase;
  readonly paused: boolean;
  readonly interviewerName: string;
  /** Voice capture is open for this answer right now. */
  readonly capturing: boolean;
  readonly interim: string;
  readonly typed: string;
  readonly canSend: boolean;
  readonly currentQuestion: string;
  /** Said before the question after a rejoin ("Welcome back."); shown, never spoken. */
  readonly questionPrefix?: string;
  /** Offered when the last answer is on record without a reply; null otherwise. */
  readonly onContinue?: (() => void) | null;
  readonly repeatAvailable: boolean;
  readonly nudge: string | null;
  readonly getCandidateLevel: () => number;
  readonly onTypedChange: (value: string) => void;
  readonly onSelectMode: (mode: ComposerMode) => void;
  readonly onSend: () => void;
  readonly onDoneSpeaking: () => void;
  readonly onRepeat: () => void;
  readonly onResume: () => void;
}

export function Composer(props: ComposerProps) {
  const { mode, speakUnavailable, phase, paused } = props;
  const textRef = useRef<HTMLTextAreaElement>(null);
  const waveRef = useRef<HTMLCanvasElement>(null);
  const noteRef = useRef<HTMLDivElement>(null);
  // Esc hands Tab back to the browser, so a keyboard user can always leave
  // the code editor; focusing the editor again restores indenting.
  const tabReleasedRef = useRef(false);
  const caretRef = useRef<number | null>(null);
  const segRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const heardRef = useRef<HTMLElement>(null);
  const resumeRef = useRef<HTMLButtonElement>(null);
  // Whether the answer box had focus. When it is replaced (the room switched
  // back to speaking) focus would fall to the page; it goes to the mode
  // switch instead, so a keyboard user is not dropped at the top.
  const textFocusedRef = useRef(false);
  const [questionOpen, setQuestionOpen] = useState(false);
  const [readBack, setReadBack] = useState(false);
  const settled = useSettledText(props.interim, READ_BACK_SETTLE_MS);
  useVoiceFrames(props.getCandidateLevel, () => ({ wave: waveRef.current }));

  // A new question starts clamped again.
  useEffect(() => { setQuestionOpen(false); }, [props.currentQuestion]);

  // The composer appears in place of the Join button the candidate has just
  // pressed. Without this, focus is left on an element that no longer exists
  // and a keyboard or screen-reader user is dropped at the top of the page.
  useEffect(() => { rootRef.current?.focus(); }, []);

  // "Need a moment?" disables itself the instant it is pressed, so focus goes
  // to the control that now matters — and comes back when the pause is over.
  const wasPaused = useRef(paused);
  useEffect(() => {
    if (paused === wasPaused.current) return;
    wasPaused.current = paused;
    if (paused) resumeRef.current?.focus();
    else rootRef.current?.focus();
  }, [paused]);

  const typing = mode !== 'speak';
  useEffect(() => {
    if (typing || !textFocusedRef.current) return;
    textFocusedRef.current = false;
    if (document.activeElement === document.body || document.activeElement === null) {
      segRef.current?.querySelector<HTMLButtonElement>('button[aria-pressed="true"]')?.focus();
    }
  }, [typing]);

  // Grow with the answer up to the stylesheet's max-height, then scroll.
  useLayoutEffect(() => {
    const el = textRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight + 2}px`;
    if (caretRef.current !== null) {
      el.selectionStart = caretRef.current;
      el.selectionEnd = caretRef.current;
      caretRef.current = null;
    }
  }, [props.typed, mode]);

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      if (props.canSend) props.onSend();
      return;
    }
    if (e.key === 'Escape') { tabReleasedRef.current = true; return; }
    if (e.key === 'Tab' && mode === 'code' && !tabReleasedRef.current && !e.shiftKey) {
      e.preventDefault();
      const el = e.currentTarget;
      const next = insertIndent(el.value, el.selectionStart, el.selectionEnd);
      caretRef.current = next.caret;
      props.onTypedChange(next.value);
    }
  };

  const micLabel = speakUnavailable
    ? 'Speaking unavailable — why?'
    : !typing
      ? (props.capturing ? 'Done answering' : 'Microphone — opens on your turn')
      : 'Answer by speaking';
  const onMic = () => {
    if (speakUnavailable) { noteRef.current?.focus(); return; }
    if (typing) { props.onSelectMode('speak'); return; }
    if (!props.capturing) return;
    props.onDoneSpeaking();
    // The microphone button disables itself once the answer is closed, which
    // would drop focus to the page. It goes to what we heard instead, so the
    // last thing a blind candidate is told before the answer is sent is the
    // text we are sending.
    heardRef.current?.focus();
  };

  return (
    <div className="room-composer" ref={rootRef} role="group" aria-label="Answer this question" tabIndex={-1}>
      {(props.currentQuestion || props.questionPrefix) && (
        <div className="room-current">
          <div>
            <div className="room-current-label">Current question</div>
            {/* Clamped to two lines; the whole question opens on a tap, or from
                the keyboard with the toggle — not only from a tooltip nobody
                can reach. The toggle is its own button so its name stays short. */}
            <p
              id="room-current-question"
              className={questionOpen ? 'room-current-text is-open' : 'room-current-text'}
              data-testid="room-current-question"
              onClick={() => setQuestionOpen((open) => !open)}
            >
              {props.questionPrefix && `${props.questionPrefix} `}{props.currentQuestion}
            </p>
            <button
              type="button"
              className="room-current-toggle"
              aria-expanded={questionOpen}
              aria-controls="room-current-question"
              onClick={() => setQuestionOpen((open) => !open)}
            >
              {questionOpen ? 'Show less' : 'Show all'}
            </button>
          </div>
          <button type="button" className="room-ghost" onClick={props.onRepeat} disabled={!props.repeatAvailable} title="Hear the question again">
            <Icon name="refresh" size={14} />Repeat
          </button>
        </div>
      )}

      {paused && (
        <div className="room-paused" role="status">
          <span>Paused — {props.interviewerName} will wait. Take the time you need.</span>
          <button type="button" className="room-ghost" ref={resumeRef} onClick={props.onResume}>I’m ready</button>
        </div>
      )}

      <div className="room-mode-row">
        <div className="room-seg" role="group" aria-label="Answer by" ref={segRef}>
          {MODES.map((m) => (
            <button
              key={m.mode}
              type="button"
              aria-pressed={mode === m.mode}
              // Held still while an answer is being sent: a switch then would
              // fold the in-flight words into the box and double them on retry.
              disabled={phase === 'thinking' || (m.mode === 'speak' && speakUnavailable !== null)}
              title={m.mode === 'speak' && speakUnavailable ? speakUnavailable : undefined}
              onClick={() => props.onSelectMode(m.mode)}
            >
              <Icon name={m.icon} size={14} />{m.label}
            </button>
          ))}
        </div>
        {props.onContinue && (
          <button type="button" className="room-ghost" onClick={props.onContinue}>
            <Icon name="arrow-right" size={14} />Continue
          </button>
        )}
        {props.nudge && <span className="room-nudge">{props.nudge}</span>}
        {!typing && (
          <button
            type="button"
            className="room-ghost room-readback"
            aria-pressed={readBack}
            title="Have your own words read back to you as you speak"
            onClick={() => setReadBack((on) => !on)}
          >
            <Icon name="speaker" size={14} />Read back what I say
          </button>
        )}
        <Hint text={composerHint(mode)} id="room-composer-hint" />
      </div>

      <div className="room-input-row">
        {typing ? (
          <textarea
            ref={textRef}
            className={mode === 'code' ? 'room-answer is-code' : 'room-answer'}
            value={props.typed}
            onChange={(e) => props.onTypedChange(e.target.value)}
            onKeyDown={onKeyDown}
            onFocus={() => { tabReleasedRef.current = false; textFocusedRef.current = true; }}
            onBlur={() => { textFocusedRef.current = false; }}
            placeholder={mode === 'code' ? 'Write your query or code here. Indentation is kept.' : 'Type your answer…'}
            aria-label="Your answer"
            aria-describedby="room-composer-hint"
            spellCheck={mode !== 'code'}
            data-answer-input="true"
          />
        ) : (
          <div className={`room-voice-box${props.capturing && !paused ? ' is-live' : ''}`}>
            <canvas ref={waveRef} className="room-wave" width={240} height={56} aria-hidden="true" />
            {/* A named region, not a live one: reachable whenever the candidate
                wants to check what we heard, silent until they ask. */}
            <span
              ref={heardRef}
              className={props.interim ? 'room-interim' : undefined}
              role="region"
              aria-label="What we heard you say"
              tabIndex={-1}
            >
              {paused ? 'Paused.' : voicePrompt(phase, props.interim)}
            </span>
            {readBack && (
              <span className="visually-hidden" data-testid="room-read-back" aria-live="polite" aria-atomic="true">
                {settled}
              </span>
            )}
          </div>
        )}
        <button
          type="button"
          // The label changes with the state ("Done answering"), so it is not
          // also a toggle: a screen reader would announce both.
          className={`room-round room-mic${!typing && props.capturing ? ' is-live' : ''}`}
          aria-label={micLabel}
          aria-disabled={speakUnavailable ? true : undefined}
          aria-describedby={speakUnavailable ? 'room-mic-note' : undefined}
          disabled={!speakUnavailable && !typing && !props.capturing}
          onClick={onMic}
        >
          <Icon name="mic" size={20} />
        </button>
        <button
          type="button"
          className="room-round room-send"
          aria-label="Send"
          title="Send answer (Ctrl+Enter)"
          disabled={!props.canSend}
          // Sending empties the box, which disables Send and would drop focus
          // to the page. It stays where the candidate is working instead.
          onClick={() => { props.onSend(); (typing ? textRef.current : heardRef.current)?.focus(); }}
        >
          <Icon name="arrow-right" size={20} />
        </button>
      </div>
      {speakUnavailable && (
        <div className="room-mic-note" id="room-mic-note" ref={noteRef} tabIndex={-1}>{speakUnavailable}</div>
      )}
    </div>
  );
}
