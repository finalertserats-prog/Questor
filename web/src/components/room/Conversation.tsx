import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { formatElapsed } from './roomProgressModel';
import { isNearBottom, type RoomMessage } from './roomConversationModel';
import { prefersReducedMotion } from './SpeakingRing';

/** How often the reveal checks how far the voice has got. Words last ~380 ms. */
const REVEAL_POLL_MS = 90;

export interface RevealingMessage {
  readonly id: string;
  /** Words of the message spoken so far, or null before the voice has started. */
  readonly spoken: () => number | null;
}

/**
 * The interviewer's newest words, faint until they are said. The full text is
 * in the DOM from the start, so a screen reader announces the message once,
 * whole, instead of a word at a time.
 */
function RevealedText({ text, revealing }: { text: string; revealing: RevealingMessage | null }) {
  const [shown, setShown] = useState(0);
  useEffect(() => {
    if (!revealing) return undefined;
    const t = window.setInterval(() => setShown(revealing.spoken() ?? 0), REVEAL_POLL_MS);
    return () => window.clearInterval(t);
  }, [revealing]);

  if (!revealing || prefersReducedMotion()) return <p className="room-text">{text}</p>;
  let word = -1;
  return (
    <p className="room-text">
      {text.split(/(\s+)/).map((part, i) => {
        if (!part.trim()) return part;
        word += 1;
        return <span key={i} className={word < shown ? 'room-word' : 'room-word is-pending'}>{part}</span>;
      })}
    </p>
  );
}

export interface ConversationProps {
  readonly messages: readonly RoomMessage[];
  readonly interviewer: { readonly name: string; readonly initial: string };
  readonly candidateInitials: string;
  readonly revealing: RevealingMessage | null;
}

export function Conversation({ messages, interviewer, candidateInitials, revealing }: ConversationProps) {
  const listRef = useRef<HTMLOListElement>(null);
  const followRef = useRef(true);
  const seenCountRef = useRef(messages.length);
  const [unseen, setUnseen] = useState(false);

  // NOT a live region, deliberately. The transcript used to announce the
  // interviewer's newest line as it arrived — a caption of words the candidate
  // was hearing at that very moment. A blind candidate hears the interviewer;
  // repeating her in text is noise over noise, and it reads as artificial
  // because it is. The list is a labelled list a screen reader can read at
  // will, and the room announces only what makes no sound (roomAnnouncements.ts
  // — including the one case where a turn genuinely was silent).

  // Follow new messages only while the reader is at the bottom: someone who
  // scrolled up to re-read an answer must not be pulled away from it.
  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el) return;
    if (followRef.current) {
      el.scrollTop = el.scrollHeight;
      seenCountRef.current = messages.length;
    } else if (messages.length > seenCountRef.current) {
      setUnseen(true);
    }
  }, [messages]);

  // The reveal grows the last message without adding one; keep it in view.
  useEffect(() => {
    if (!revealing) return undefined;
    const t = window.setInterval(() => {
      const el = listRef.current;
      if (el && followRef.current) el.scrollTop = el.scrollHeight;
    }, 250);
    return () => window.clearInterval(t);
  }, [revealing]);

  const onScroll = () => {
    const el = listRef.current;
    if (!el) return;
    followRef.current = isNearBottom(el);
    if (followRef.current) {
      seenCountRef.current = messages.length;
      setUnseen(false);
    }
  };

  const jumpToLatest = () => {
    const el = listRef.current;
    if (!el) return;
    followRef.current = true;
    seenCountRef.current = messages.length;
    setUnseen(false);
    el.scrollTop = el.scrollHeight;
  };

  return (
    <div className="room-convo-body">
      <ol className="room-transcript" ref={listRef} onScroll={onScroll} aria-label="Conversation so far">
        {messages.length === 0 && <li className="room-empty">The conversation will appear here as you go.</li>}
        {messages.map((m) => {
          const agent = m.speaker === 'agent';
          return (
            <li key={m.id} className={`room-msg ${agent ? 'room-msg-ai' : 'room-msg-you'}`}>
              <span className="room-mini" aria-hidden="true">{agent ? interviewer.initial : candidateInitials}</span>
              <div className="room-msg-body">
                <div className="room-who">
                  <b>{agent ? interviewer.name : 'You'}</b>
                  {typeof m.atMs === 'number' && <time>{formatElapsed(m.atMs)}</time>}
                </div>
                {m.code
                  ? <pre className="room-code">{m.text}</pre>
                  : agent
                    ? <RevealedText text={m.text} revealing={revealing?.id === m.id ? revealing : null} />
                    : <p className="room-text">{m.text}</p>}
              </div>
            </li>
          );
        })}
      </ol>
      {unseen && (
        <button type="button" className="room-jump" onClick={jumpToLatest}>Jump to latest</button>
      )}
    </div>
  );
}

/** The right-hand column: the conversation, any error, and what sits under it (join, composer, done). */
export function ConversationPanel({ err, children, ...conversation }: ConversationProps & { err: string; children: ReactNode }) {
  return (
    <section className="room-convo" aria-labelledby="room-convo-title">
      <div className="room-convo-head">
        <h2 className="room-col-label" id="room-convo-title">Conversation</h2>
        <span className="room-hint">Everything said so far, in writing</span>
      </div>
      <Conversation {...conversation} />
      {err && <div className="room-error" role="alert">{err}</div>}
      {children}
    </section>
  );
}
