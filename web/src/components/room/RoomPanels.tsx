import { useEffect, useRef } from 'react';
import { Icon } from '../Icon';
import { VoiceHandling, type SttCapability } from '../../pages/Portal';
import {
  FEEDBACK_EXPLANATION, FEEDBACK_NO_LABEL, FEEDBACK_QUESTION, FEEDBACK_YES_LABEL, answerConfirmation,
} from '../feedbackOptInCopy';

export function JoinPanel({ durationMinutes, interviewer, aiFact, stt, canCapture, onJoin }: {
  durationMinutes: number;
  interviewer: string;
  /** "<Name> is an AI interviewer…" — the on-screen name carries no label. */
  aiFact: string;
  stt: SttCapability;
  canCapture: boolean;
  onJoin: () => void;
}) {
  return (
    <div className="room-join">
      <p className="room-muted">
        {durationMinutes} minutes · voice or typed · you can ask {interviewer} to repeat anything.
      </p>
      {/* Repeated here, not just on the consent screen. The consent screen may
          have been read minutes ago on another device, and this is the last
          moment before the microphone actually opens. */}
      <div className="room-muted room-join-facts">
        <p data-testid="room-ai-fact">{aiFact}</p>
        {canCapture && <VoiceHandling stt={stt} />}
      </div>
      <button type="button" className="room-join-btn" onClick={onJoin}><Icon name="play" size={18} />Join interview</button>
    </div>
  );
}

/**
 * The "What's captured" facts. The AI disclosure lives here for the whole
 * interview, and so do the four voice facts from the consent screen, so a
 * candidate can check either at any moment without leaving the room.
 */
export function RoomPrivacy({ aiFact, stt, canCapture }: { aiFact: string; stt: SttCapability; canCapture: boolean }) {
  return (
    <>
      <ul>
        <li>{aiFact}</li>
        {canCapture
          ? <li>Your voice is turned into text while you speak. No audio is kept.</li>
          : <li>Your microphone is not used — you are answering by typing.</li>}
        <li>The written transcript is kept and reviewed.</li>
      </ul>
      {canCapture && <VoiceHandling stt={stt} />}
    </>
  );
}

export interface FeedbackState {
  readonly offered: boolean;
  readonly choice: string | null;
  readonly saving: boolean;
  readonly error: string;
  readonly onAnswer: (wantsFeedback: boolean) => void;
}

/**
 * The ending's heading. Focus moves here when the interview ends, because the
 * control the candidate was using (Send, Leave) has just disappeared, and a
 * keyboard or screen-reader user would otherwise be left nowhere.
 */
function DoneHeading({ children }: { children: string }) {
  const ref = useRef<HTMLHeadingElement>(null);
  useEffect(() => { ref.current?.focus(); }, []);
  return <h3 ref={ref} tabIndex={-1}>{children}</h3>;
}

export function DonePanel({ feedback, completedNote = '', withdrawn = false }: {
  feedback: FeedbackState;
  completedNote?: string;
  /** The candidate chose to leave: nothing is being reviewed as an interview. */
  withdrawn?: boolean;
}) {
  // Reached from a refusal rather than the sign-off: this room saw none of the
  // interview, so it says only that it is complete.
  if (completedNote) {
    return (
      <div className="room-done">
        <DoneHeading>Your interview is complete</DoneHeading>
        <p className="room-muted">{completedNote}</p>
      </div>
    );
  }
  if (withdrawn) {
    return (
      <div className="room-done">
        <DoneHeading>You've left the interview.</DoneHeading>
        <p className="room-muted">
          Your microphone is now off. The interview has ended at your request and will not be scored —
          it will not count against you. The hiring team will follow up by email, and you can ask them
          for a different format or a conversation with a person instead.
        </p>
        <p className="room-muted">
          The conversation above is everything that was captured. You can close this window whenever you like.
        </p>
      </div>
    );
  }
  return (
    <div className="room-done">
      <DoneHeading>That's everything — thank you.</DoneHeading>
      <p className="room-muted">
        Your microphone is now off. Your interview has been submitted for human review: a person on
        the hiring team reads the <b>transcript</b> — the text of what you said, which is all that
        was kept — and makes the decision. No recording of your voice exists.
      </p>
      <p className="room-muted">
        <b>Everything that was captured is in the conversation above</b>, exactly as the reviewer will see
        it. Take as long as you like to read it before closing this window. If something you said is
        missing or came out wrong, reply to your invitation email and tell us — we would rather know.
      </p>

      {/* Asked here, and only here: the invitation link is consumed the
          moment the interview finalises, so this is the last moment the
          candidate can be asked anything at all. */}
      {feedback.offered && (
        <div className="room-feedback">
          {feedback.choice === null ? (
            <>
              <p><b>{FEEDBACK_QUESTION}</b></p>
              <p className="room-muted">{FEEDBACK_EXPLANATION}</p>
              <div className="row">
                <button type="button" className="btn" disabled={feedback.saving} onClick={() => feedback.onAnswer(true)}>
                  {FEEDBACK_YES_LABEL}
                </button>
                <button type="button" className="btn secondary" disabled={feedback.saving} onClick={() => feedback.onAnswer(false)}>
                  {FEEDBACK_NO_LABEL}
                </button>
              </div>
            </>
          ) : (
            <p className="room-muted">{answerConfirmation(feedback.choice)}</p>
          )}
          {feedback.error && <p className="room-muted">{feedback.error}</p>}
        </div>
      )}
    </div>
  );
}

/**
 * The confirm step before leaving. A modal dialog, so focus is held inside it
 * and Esc cancels — leaving by accident would end the interview.
 */
export function LeaveDialog({ open, interviewer, onCancel, onConfirm }: {
  open: boolean;
  interviewer: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);
  return (
    <dialog ref={ref} className="room-dialog" aria-labelledby="room-leave-title" onCancel={onCancel}>
      <h2 id="room-leave-title">Leave the interview?</h2>
      <p>
        Leaving ends this interview now, and {interviewer} will sign off. Nothing you've said will count
        against you, and the hiring team will follow up by email.
      </p>
      <div className="room-dialog-actions">
        <button type="button" className="room-ghost" onClick={onCancel} autoFocus>Stay in the interview</button>
        <button type="button" className="room-ghost room-leave" onClick={onConfirm}>Leave interview</button>
      </div>
    </dialog>
  );
}

/** Before the room exists: connecting, or why it cannot open. */
export function RoomLoading({ err }: { err: string }) {
  if (err) return <div className="center-screen"><div className="card auth-card"><div className="banner error">{err}</div></div></div>;
  return (
    <div className="center-screen muted" role="status" aria-busy="true">
      <span className="check-label"><Icon name="refresh" size={18} />Connecting to the interview room…</span>
    </div>
  );
}
