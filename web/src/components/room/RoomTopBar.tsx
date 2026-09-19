import { useEffect, useState } from 'react';
import { BrandLogo } from '../BrandLogo';
import { Icon } from '../Icon';
import { transcriptionProcessorSentence, type SttCapability } from '../../pages/Portal';
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
export function CaptureIndicator({ mode, stt }: { mode: 'transcribing' | 'mic'; stt: SttCapability }) {
  const detail = mode === 'transcribing'
    ? `Your voice is captured while you answer and transcribed to text. ${transcriptionProcessorSentence(stt)} `
      + 'No audio file is stored — the written transcript is what is kept and reviewed.'
    : 'Your microphone is open so the level meter can show you it is working. You are answering by '
      + 'typing, so no audio is being transcribed and none is stored.';
  return (
    <span className="room-capture" title={detail}>
      <i />{mode === 'transcribing' ? 'LIVE TRANSCRIPTION' : 'MIC OPEN'}
    </span>
  );
}

export interface RoomTopBarProps {
  readonly roleTitle: string;
  readonly durationMinutes: number;
  /** Epoch ms the interview started, or 0 before it has. */
  readonly startedAt: number;
  readonly finished: boolean;
  readonly question: number | null;
  readonly capture: { readonly mode: 'transcribing' | 'mic'; readonly stt: SttCapability } | null;
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
  return (
    <header className="room-bar">
      {/* The room is dark in both themes, so it always takes the dark cut. */}
      <BrandLogo variant="lockup" size={22} surfaceTone="dark" className="candidate-logo" />
      <span className="room-role">{props.roleTitle}</span>
      <div className="room-progress" aria-label="Interview progress">
        <span className="room-track" aria-hidden="true">
          {timeTrack(elapsedMs, props.durationMinutes).map((state, i) => <i key={i} className={`room-track-${state}`} />)}
        </span>
        <span className="room-progress-label">{label}</span>
      </div>
      {props.capture && <CaptureIndicator mode={props.capture.mode} stt={props.capture.stt} />}
      <span className="room-timer" aria-label="Elapsed time">{formatElapsed(elapsedMs)}</span>
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
