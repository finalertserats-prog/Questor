import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api, ApiError } from '../api/client';
import { LoadingNote } from '../components/Skeleton';

/**
 * "Would you like to speak to a person?" — the page behind the link in a
 * feedback email.
 *
 * Two deliberate choices here, both of which look like extra work and are not:
 *
 *   1. NOTHING IS RECORDED ON LOAD. The request is only sent when the person
 *      presses the button. Corporate mail gateways and link scanners fetch every
 *      URL in an incoming message, so a page that recorded on load would file
 *      requests on behalf of candidates who never clicked — and someone from HR
 *      would ring them about a conversation they never asked for.
 *
 *   2. NOTHING ABOUT THE CANDIDATE IS SHOWN. Not their name, not the role, not
 *      the company. The link is a bearer credential sitting in a mailbox, and
 *      anything displayed here is something a stolen link discloses. The server
 *      does not return those facts either, so this is not the only thing
 *      standing in the way — but the page should not be the weak half.
 */

type Phase = 'loading' | 'open' | 'recorded' | 'expired' | 'unknown' | 'failed';

export function TalkToAPerson() {
  const { token } = useParams();
  const [phase, setPhase] = useState<Phase>('loading');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api.get<{ state: 'open' | 'recorded' }>(`/feedback-request/${token}`)
      .then((res) => { if (!cancelled) setPhase(res.state === 'recorded' ? 'recorded' : 'open'); })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 410) { setPhase('expired'); return; }
        if (err instanceof ApiError && err.status === 404) { setPhase('unknown'); return; }
        setPhase('failed');
      });
    return () => { cancelled = true; };
  }, [token]);

  const confirm = useCallback(async () => {
    setSubmitting(true);
    try {
      await api.post(`/feedback-request/${token}/confirm`);
      setPhase('recorded');
    } catch (err: unknown) {
      if (err instanceof ApiError && err.status === 410) setPhase('expired');
      else if (err instanceof ApiError && err.status === 404) setPhase('unknown');
      else setPhase('failed');
    } finally {
      setSubmitting(false);
    }
  }, [token]);

  return (
    <div className="center-screen">
      <div className="card auth-card">
        {phase === 'loading' && <LoadingNote />}

        {phase === 'open' && (
          <>
            <h1>Would you like to speak to someone?</h1>
            <p className="muted">
              If you would rather talk your feedback through with a person than read it, press the button
              below and we will pass that on to the hiring team. Nobody will contact you unless you do.
            </p>
            <button className="btn" onClick={() => void confirm()} disabled={submitting}>
              {submitting ? 'Sending…' : 'Yes, I\'d like to speak to someone'}
            </button>
          </>
        )}

        {/* Same words whether this is the first press or the fifth: pressing it
            again is a thing people do when they are unsure it worked, and it
            should read as reassurance rather than as an error. */}
        {phase === 'recorded' && (
          <>
            <h1>Thank you — that's been passed on.</h1>
            <p className="muted">
              Someone from the hiring team will be in touch. You do not need to do anything else, and it is
              fine if you pressed this more than once.
            </p>
          </>
        )}

        {phase === 'expired' && (
          <>
            <h1>This link has expired.</h1>
            <p className="muted">
              Links in feedback emails work for 30 days. You can still reach us by replying to the email your
              feedback came in — we would be glad to hear from you.
            </p>
          </>
        )}

        {phase === 'unknown' && (
          <>
            <h1>This link doesn't work.</h1>
            <p className="muted">
              It may have been copied incompletely. Try opening it straight from your email, or simply reply
              to that email instead.
            </p>
          </>
        )}

        {phase === 'failed' && (
          <>
            <h1>Something went wrong at our end.</h1>
            <p className="muted">
              Please try again in a moment. If it keeps happening, replying to your feedback email will reach
              the same people.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
