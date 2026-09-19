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
  // Whether the answer box had focus. When it is replaced (the room switched
  // back to speaking) focus would fall to the page; it goes to the mode
  // switch instead, so a keyboard user is not dropped at the top.
  const textFocusedRef = useRef(false);
  const [questionOpen, setQuestionOpen] = useState(false);
  useVoiceFrames(props.getCandidateLevel, () => ({ wave: waveRef.current }));

  // A new question starts clamped again.
  useEffect(() => { setQuestionOpen(false); }, [props.currentQuestion]);

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
    if (props.capturing) props.onDoneSpeaking();
  };

  return (
    <div className="room-composer">
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
          <button type="button" className="room-ghost" onClick={props.onResume}>I’m ready</button>
        </div>
      )}

      <div className="room-mode-row">
        <div className="room-seg" role="group" aria-label="Answer by" ref={segRef}>
          {MODES.map((m) => (
            <button
              key={m.mode}
              type="button"
              aria-pressed={mode === m.mode}
              disabled={m.mode === 'speak' && speakUnavailable !== null}
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
            <span className={props.interim ? 'room-interim' : undefined}>
              {paused ? 'Paused.' : voicePrompt(phase, props.interim)}
            </span>
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
        <button type="button" className="room-round room-send" aria-label="Send" title="Send answer (Ctrl+Enter)" disabled={!props.canSend} onClick={props.onSend}>
          <Icon name="arrow-right" size={20} />
        </button>
      </div>
      {speakUnavailable && (
        <div className="room-mic-note" id="room-mic-note" ref={noteRef} tabIndex={-1}>{speakUnavailable}</div>
      )}
    </div>
  );
}
