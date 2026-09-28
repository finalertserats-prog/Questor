import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { BrandLogo } from '../BrandLogo';
import { Icon } from '../Icon';
import { transcriptionProcessorSentence, type SttCapability } from '../../pages/Portal';
import { RoomPrivacy } from './RoomPanels';
import { formatElapsed, progressLabel, timeTrack } from './roomProgressModel';

/** Re-render once a second while the interview runs, for the clock and time left. */
function useSecondTick(running: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return undefined;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [running]);
  return now;
}

/**
 * What the bar is allowed to claim about the microphone.
 *
 * Nothing is recorded: no audio file is written, kept or playable — the
 * transcript is the artefact, and the server discards each uploaded clip once
 * the text comes back. But the microphone genuinely is open and audio does
 * leave the machine for a transcriber, so an unmarked room would understate
 * what is happening. The pill says what the capture is FOR.
 *
 * 'transcribing' — audio is being captured and turned into text.
 * 'mic'          — the mic is open for the level meter only (typed answers).
 */
export function CaptureIndicator({ mode, stt, aiFact }: { mode: 'transcribing' | 'mic'; stt: SttCapability; aiFact: string }) {
  // The AI fact rides with what is captured, so it stays reachable during the
  // interview even though the name on screen carries no label.
  const detail = (mode === 'transcribing'
    ? `Your voice is captured while you answer and transcribed to text. ${transcriptionProcessorSentence(stt)} `
      + 'No audio file is stored — the written transcript is what is kept and reviewed.'
    : 'Your microphone is open so the level meter can show you it is working. You are answering by '
      + 'typing, so no audio is being transcribed and none is stored.') + ` ${aiFact}`;
  return (
    <span className="room-capture" title={detail}>
      <i />{mode === 'transcribing' ? 'LIVE TRANSCRIPTION' : 'MIC OPEN'}
    </span>
  );
}

/**
 * The "What's captured" facts, from the top bar.
 *
 * On a phone the participants rail drops its own copy of these facts, and a
 * compact (keyboard-open) room drops the rail entirely; the capture pill's
 * tooltip was then the only place the room said the interviewer is an AI, and
 * a touch screen never shows a tooltip. So the bar carries the same facts
 * behind a control a finger or a keyboard can open. room.css shows it only
 * where the rail's copy is hidden.
 */
function CapturedFacts({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setOpen(false);
      buttonRef.current?.focus();
    };
    // A tap anywhere else puts it away, as the rail's details never cover the room.
    const onPointer = (e: PointerEvent) => {
      if (e.target instanceof Node && !wrapRef.current?.contains(e.target)) setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointer);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointer);
    };
  }, [open]);
  return (
    <div className="room-facts" ref={wrapRef}>
      <button
        ref={buttonRef}
        type="button"
        className="room-ghost"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((was) => !was)}
      >
        What's captured
      </button>
      {open && <div id={panelId} className="room-facts-panel">{children}</div>}
    </div>
  );
}

export interface RoomTopBarProps {
  readonly roleTitle: string;
  readonly durationMinutes: number;
  /** Epoch ms the interview started, or 0 before it has. */
  readonly startedAt: number;
  readonly finished: boolean;
  readonly question: number | null;
  readonly capture: { readonly mode: 'transcribing' | 'mic'; readonly stt: SttCapability; readonly aiFact: string } | null;
  /**
   * The rail's "What's captured" content, for the bar's own copy on a phone.
   * Without it the bar builds the same facts from `capture`: an open mic means
   * the candidate consented to capture.
   */
  readonly privacy?: ReactNode;
  /** The browser has lost the network. Announced separately; this is the same fact on screen. */
  readonly offline?: boolean;
  readonly showActions: boolean;
  readonly paused: boolean;
  readonly pauseAvailable: boolean;
  readonly leaveAvailable: boolean;
  readonly onPause: () => void;
  readonly onLeave: () => void;
}

export function RoomTopBar(props: RoomTopBarProps) {
  const started = props.startedAt > 0;
  const now = useSecondTick(started && !props.finished);
  const elapsedMs = started ? now - props.startedAt : 0;
  const label = progressLabel({ started, durationMinutes: props.durationMinutes, elapsedMs, question: props.question });
  const privacy = props.privacy
    ?? (props.capture && <RoomPrivacy aiFact={props.capture.aiFact} stt={props.capture.stt} canCapture />);
  return (
    <header className="room-bar">
      {/* The room is dark in both themes, so it always takes the dark cut. */}
      <BrandLogo variant="lockup" size={22} surfaceTone="dark" className="candidate-logo" />
      <span className="room-role">{props.roleTitle}</span>
      {/* A group, so the name below is a name and not decoration: aria-label on
          a plain div is ignored, and the bar then had an unnamed cluster. */}
      <div className="room-progress" role="group" aria-label="Interview progress">
        <span className="room-track" aria-hidden="true">
          {timeTrack(elapsedMs, props.durationMinutes).map((state, i) => <i key={i} className={`room-track-${state}`} />)}
        </span>
        <span className="room-progress-label">{label}</span>
      </div>
      {props.offline && <span className="room-offline">Offline — reconnecting</span>}
      {props.capture && <CaptureIndicator mode={props.capture.mode} stt={props.capture.stt} aiFact={props.capture.aiFact} />}
      {privacy && <CapturedFacts>{privacy}</CapturedFacts>}
      {/* The label went on the span itself, which replaced the time with the
          word "Elapsed time" — the one thing this is for. Prefixed instead. */}
      <span className="room-timer"><span className="visually-hidden">Elapsed time </span>{formatElapsed(elapsedMs)}</span>
      {props.showActions && (
        <div className="room-bar-actions">
          <button
            type="button"
            className="room-ghost"
            aria-label="Need a moment?"
            onClick={props.onPause}
            disabled={!props.pauseAvailable || props.paused}
            title={props.pauseAvailable ? 'Ask for a short pause' : 'Available when it is your turn to answer'}
          >
            <Icon name="pause" size={16} /><span>Need a moment?</span>
          </button>
          <button
            type="button"
            className="room-ghost room-leave"
            aria-label="Leave"
            onClick={props.onLeave}
            disabled={!props.leaveAvailable}
            title="Leave the interview"
          >
            <Icon name="sign-out" size={16} /><span>Leave</span>
          </button>
        </div>
      )}
    </header>
  );
}
