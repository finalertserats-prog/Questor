import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api, ApiError } from '../api/client';
import { Icon } from '../components/Icon';
import {
  applicantIntent,
  decisionPhaseForStatus,
  joinEmailCaution,
  type DecisionPhase,
  type SignupMode,
} from '../components/signupModel';

interface Applicant {
  name: string;
  email: string;
  organisation: string;
  mode: SignupMode;
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
export function SignupDecision() {
  const { token } = useParams();
  const [phase, setPhase] = useState<DecisionPhase>('loading');
  const [applicant, setApplicant] = useState<Applicant | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDecline, setConfirmDecline] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api.get<{ state: 'open' | 'decided'; applicant: Applicant }>(`/signup/decision/${token}`)
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
    setBusy(true);
    try {
      await api.post(`/signup/decision/${token}`, { decision });
      setPhase(decision === 'approve' ? 'approved' : 'declined');
    } catch (err: unknown) {
      setPhase(err instanceof ApiError ? decisionPhaseForStatus(err.status) : 'failed');
    } finally {
      setBusy(false);
    }
  };

  const caution = applicant ? joinEmailCaution(applicant.mode, applicant.email, applicant.organisation) : null;
  const who = applicant?.name?.trim() || 'This request';

  return (
    <div className="center-screen">
      <div className="card auth-card">
        {phase === 'loading' && <p className="muted">One moment…</p>}

        {phase === 'open' && applicant && (
          <>
            <h1>Someone is asking for an account</h1>
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
                <dd>{applicantIntent(applicant.mode, applicant.organisation)}</dd>
              </div>
            </dl>

            {caution && (
              <p className="signup-flag">
                <Icon name="alert" size={14} />
                <span>{caution}</span>
              </p>
            )}

            <p className="muted small">
              Approving opens the account. Declining creates nothing. Either way this link stops working
              afterwards.
            </p>

            <div className="signup-actions">
              <button type="button" className="btn" onClick={() => void decide('approve')} disabled={busy}>
                <Icon name="check" size={15} />
                {busy ? 'Recording…' : 'Approve'}
              </button>
              {confirmDecline ? (
                <>
                  <button type="button" className="btn secondary" onClick={() => void decide('decline')} disabled={busy}>
                    <Icon name="x-circle" size={15} />
                    {busy ? 'Declining…' : 'Confirm decline'}
                  </button>
                  <button type="button" className="btn ghost" onClick={() => setConfirmDecline(false)} disabled={busy}>
                    Cancel
                  </button>
                </>
              ) : (
                <button type="button" className="btn secondary" onClick={() => setConfirmDecline(true)} disabled={busy}>
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
            <p className="muted">{who}'s request has been approved. There is nothing else to do here.</p>
          </>
        )}

        {phase === 'declined' && (
          <>
            <h1>Declined</h1>
            <p className="muted">{who}'s request has been declined. Nothing has been created.</p>
          </>
        )}

        {phase === 'decided' && (
          <>
            <h1>This one has already been decided</h1>
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
              Approval links stop working after a while, so an old message cannot open an account.
              Opening an expired link also closes the request, so it is no longer waiting for a
              decision and the person has not been told anything. If they still want an account, ask
              them to request one again.
            </p>
          </>
        )}

        {phase === 'invalid' && (
          <>
            <h1>This link doesn't work</h1>
            <p className="muted">
              It may have been copied incompletely. Try opening it straight from the email, or decide the
              request under Account requests when you sign in.
            </p>
          </>
        )}

        {phase === 'failed' && (
          <>
            <h1>Something went wrong at our end</h1>
            <p className="muted">
              Nothing has been recorded. Please try again in a moment — the request is still waiting.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
