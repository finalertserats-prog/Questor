import { useRef, type ReactNode } from 'react';
import { LevelBars, RingedAvatar, useVoiceFrames } from './SpeakingRing';

type Tone = 'ai' | 'you';

interface TileProps {
  readonly tone: Tone;
  readonly name: string;
  readonly initial: string;
  /** A small label after the name, such as "You". */
  readonly tag?: string;
  readonly getLevel: () => number;
  /** The status line, given whether the voice is audibly speaking this moment. */
  readonly status: (speakingNow: boolean) => ReactNode;
  /** Forces the active outline; otherwise it follows the voice. */
  readonly active?: boolean;
  readonly testId?: string;
}

export function ParticipantTile({ tone, name, initial, tag, getLevel, status, active, testId }: TileProps) {
  const ringRef = useRef<HTMLCanvasElement>(null);
  const avatarRef = useRef<HTMLDivElement>(null);
  const barsRef = useRef<HTMLSpanElement>(null);
  const speakingNow = useVoiceFrames(getLevel, () => ({
    ring: ringRef.current, avatar: avatarRef.current, bars: barsRef.current,
  }));
  const isActive = active ?? speakingNow;
  return (
    <div className={`room-tile room-tile-${tone}${isActive ? ' is-active' : ''}`} data-testid={testId}>
      <RingedAvatar initial={initial} ringRef={ringRef} avatarRef={avatarRef} />
      <div className="room-tile-text">
        <div className="room-tile-name" data-testid={testId ? `${testId}-name` : undefined}>
          {name}
          {tag && <span className="room-tag">{tag}</span>}
        </div>
        <div className="room-tile-status">
          <LevelBars barsRef={barsRef} />
          <span>{status(speakingNow)}</span>
        </div>
      </div>
    </div>
  );
}

export interface RoomObserver {
  readonly name: string;
}

/**
 * A person from the hiring team watching silently. Rendered only for an
 * observer who is actually present — the room never shows a watcher it
 * cannot vouch for, and never hides one it knows about.
 */
export function ObserverTile({ observer }: { observer: RoomObserver }) {
  const letters = observer.name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]?.toUpperCase() ?? '').join('');
  return (
    <div className="room-tile room-tile-observer">
      <div className="room-avatar" aria-hidden="true">{letters || 'O'}</div>
      <div className="room-observer-text">
        <span className="room-tile-name">{observer.name}</span>
        <small>Hiring team · observing silently</small>
      </div>
    </div>
  );
}

/** Three dots for "Thinking" — motion that stops under reduced motion (see room.css). */
export function ThinkingDots() {
  return <span className="room-dots" aria-hidden="true"><i /><i /><i /></span>;
}

export interface ParticipantsRailProps {
  readonly interviewer: { readonly name: string; readonly initial: string };
  readonly candidate: { readonly name: string; readonly initial: string };
  readonly aiStatus: string;
  readonly aiThinking: boolean;
  readonly aiSpeaking: boolean;
  readonly getAiLevel: () => number;
  readonly getCandidateLevel: () => number;
  readonly candidateStatus: (speakingNow: boolean) => string;
  readonly observers: readonly RoomObserver[];
  /** The "What's captured" facts. */
  readonly privacy: ReactNode;
}

export function ParticipantsRail(props: ParticipantsRailProps) {
  return (
    <aside className="room-people" aria-label="Participants">
      <h2 className="room-col-label">Participants</h2>
      <ParticipantTile
        tone="ai"
        testId="room-interviewer"
        name={props.interviewer.name}
        initial={props.interviewer.initial}
        getLevel={props.getAiLevel}
        active={props.aiSpeaking}
        status={() => (props.aiThinking ? <><ThinkingDots /> {props.aiStatus}</> : props.aiStatus)}
      />
      <ParticipantTile
        tone="you"
        name={props.candidate.name}
        initial={props.candidate.initial}
        tag="You"
        getLevel={props.getCandidateLevel}
        status={props.candidateStatus}
      />
      {props.observers.map((observer) => <ObserverTile key={observer.name} observer={observer} />)}
      <details className="room-privacy">
        <summary>What's captured</summary>
        {props.privacy}
      </details>
    </aside>
  );
}
