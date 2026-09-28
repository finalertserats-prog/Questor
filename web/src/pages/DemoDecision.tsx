import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api, ApiError } from '../api/client';
import { Icon } from '../components/Icon';
import { LoadingNote } from '../components/Skeleton';
import { decisionPhaseForStatus, type DecisionPhase } from '../components/signupModel';

interface Applicant {
  name: string;
  email: string;
  organisation: string;
  mode: string;
}

/**
 * The page the operator lands on from the emailed link.
 *
 * Unauthenticated by design: the token in the URL is the credential. Putting
 * this behind a sign-in would mean the person who can grant access needs access
 * before they can grant it.
 *
 * READING THE LINK IS NOT DECIDING IT. Opening this page only fetches and shows
 * who is asking; approving and declining are POSTs, behind a button somebody
 * presses. That separation is not ceremony, it is the whole safety of the link.
 * Mail gateways — Proofpoint, Mimecast, Defender and the rest — fetch every URL
 * in an inbound message to inspect it, so a decision that happened on GET would
 * be taken by the operator's own security stack, on every request, before a
 * human ever read one. Do not collapse this into a one-click link.
 */
export function DemoDecision() {
  const { token } = useParams();
  const [phase, setPhase] = useState<DecisionPhase>('loading');
  const [applicant, setApplicant] = useState<Applicant | null>(null);
  // Which decision is being recorded, so only that button says so.
  const [busy, setBusy] = useState<'approve' | 'decline' | null>(null);
  const [confirmDecline, setConfirmDecline] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api.get<{ state: 'open' | 'decided'; applicant: Applicant }>(`/demo/decision/${token}`)
      .then((res) => {
        if (cancelled) return;
        setApplicant(res.applicant);
        setPhase(res.state === 'decided' ? 'decided' : 'open');
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setPhase(err instanceof ApiError ? decisionPhaseForStatus(err.status) : 'failed');
      });
    return () => { cancelled = true; };
  }, [token]);

  // The only thing that records a decision, and it needs a press to happen.
  const decide = async (decision: 'approve' | 'decline') => {
    if (busy) return;
    setBusy(decision);
    try {
      await api.post(`/demo/decision/${token}`, { decision });
      setPhase(decision === 'approve' ? 'approved' : 'declined');
    } catch (err: unknown) {
      setPhase(err instanceof ApiError ? decisionPhaseForStatus(err.status) : 'failed');
    } finally {
      setBusy(null);
    }
  };

  const who = applicant?.name?.trim() || 'This request';

  return (
    <div className="center-screen">
      <div className="card auth-card">
        {phase === 'loading' && <LoadingNote />}

        {phase === 'open' && applicant && (
          <>
            <h1>Someone is asking for demo access again</h1>
            <dl className="signup-facts">
              <div>
                <dt>Name</dt>
                <dd>{applicant.name}</dd>
              </div>
              <div>
                <dt>Email</dt>
                <dd>{applicant.email}</dd>
              </div>
              <div>
                <dt>Asking for</dt>
                <dd>{`Demo for ${applicant.organisation}`}</dd>
              </div>
            </dl>



            <p className="muted small">
              Approving emails them a new one-time demo link. Declining sends nothing. Either way this link
              stops working afterwards.
            </p>

            <div className="signup-actions">
              <button type="button" className="btn" onClick={() => void decide('approve')} disabled={busy !== null}>
                <Icon name="check" size={15} />
                {busy === 'approve' ? 'Sending…' : 'Approve and send a new link'}
              </button>
              {confirmDecline ? (
                <>
                  <button type="button" className="btn secondary" onClick={() => void decide('decline')} disabled={busy !== null}>
                    <Icon name="x-circle" size={15} />
                    {busy === 'decline' ? 'Declining…' : 'Confirm decline'}
                  </button>
                  <button type="button" className="btn ghost" onClick={() => setConfirmDecline(false)} disabled={busy !== null}>
                    Cancel
                  </button>
                </>
              ) : (
                <button type="button" className="btn secondary" onClick={() => setConfirmDecline(true)} disabled={busy !== null}>
                  <Icon name="x-circle" size={15} />
                  Decline
                </button>
              )}
            </div>
          </>
        )}

        {phase === 'approved' && (
          <>
            <h1>Approved</h1>
            <p className="muted">{who}'s demo request has been approved and a new demo link is on its way to them. There is nothing else to do here.</p>
          </>
        )}

        {phase === 'declined' && (
          <>
            <h1>Declined</h1>
            <p className="muted">{who}'s demo request has been declined. No link has been sent.</p>
          </>
        )}

        {phase === 'decided' && (
          <>
            <h1>This demo request has already been decided</h1>
            <p className="muted">
              It has been approved or declined already — possibly by you, in another tab or on another
              device. Nothing further is needed.
            </p>
          </>
        )}

        {phase === 'expired' && (
          <>
            <h1>This link has expired</h1>
            <p className="muted">
              Decision links stop working after a while, so an old message cannot hand out a demo.
              Opening an expired link also closes the request, and the person has not been told
              anything. If they still want a demo, they can ask for one again from the demo page.
            </p>
          </>
        )}

        {phase === 'invalid' && (
          <>
            <h1>This link doesn't work</h1>
            <p className="muted">
              It may have been copied incompletely. Try opening it straight from the email.
            </p>
          </>
        )}

        {phase === 'failed' && (
          <>
            <h1>Something went wrong at our end</h1>
            <p className="muted">
              Nothing has been recorded. Please try again in a moment — the request is still waiting.
            </p>
            {applicant && (
              <button type="button" className="btn secondary" onClick={() => setPhase('open')}>
                <Icon name="refresh" size={15} />Try again
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
