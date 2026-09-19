import { useEffect, useRef } from 'react';
import { Icon } from '../Icon';
import { VoiceHandling, type SttCapability } from '../../pages/Portal';
import {
  FEEDBACK_EXPLANATION, FEEDBACK_NO_LABEL, FEEDBACK_QUESTION, FEEDBACK_YES_LABEL, answerConfirmation,
} from '../feedbackOptInCopy';

export function JoinPanel({ durationMinutes, interviewer, stt, canCapture, onJoin }: {
  durationMinutes: number;
  interviewer: string;
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
      {canCapture && (
        <div className="room-muted room-join-facts">
          <VoiceHandling stt={stt} />
        </div>
      )}
      <button type="button" className="room-join-btn" onClick={onJoin}><Icon name="play" size={18} />Join interview</button>
    </div>
  );
}

/**
 * The "What's captured" facts. The AI disclosure lives here for the whole
 * interview, and so do the four voice facts from the consent screen, so a
 * candidate can check either at any moment without leaving the room.
 */
export function RoomPrivacy({ interviewer, stt, canCapture }: { interviewer: string; stt: SttCapability; canCapture: boolean }) {
  return (
    <>
      <ul>
        <li>{interviewer} is an AI interviewer. A person on the hiring team reviews the interview.</li>
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

export function DonePanel({ feedback, completedNote = '' }: { feedback: FeedbackState; completedNote?: string }) {
  // Reached from a refusal rather than the sign-off: this room saw none of the
  // interview, so it says only that it is complete.
  if (completedNote) {
    return (
      <div className="room-done">
        <h3>Your interview is complete</h3>
        <p className="room-muted">{completedNote}</p>
      </div>
    );
  }
  return (
    <div className="room-done">
      <h3>That's everything — thank you.</h3>
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
    <div className="center-screen muted" role="status">
      <span className="check-label"><Icon name="refresh" size={18} />Connecting to the interview room…</span>
    </div>
  );
}
