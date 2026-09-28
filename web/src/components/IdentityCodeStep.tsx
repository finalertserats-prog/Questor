import { useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../api/client';
import { Banner } from './ui';
import { Icon } from './Icon';
import {
  CODE_LENGTH, IDENTITY_HEADING, IDENTITY_WHY, NO_EMAIL_HELP, RESEND_COOLDOWN_SECONDS, SENDING_MESSAGE,
  canSubmitCode, codeFromInput, codeSentMessage, resendLabel, type PortalIdentity,
} from './identityCodeModel';

interface SendResponse { sent: boolean; verified?: boolean; destination?: string; resendAfterSeconds?: number; retryAfterSeconds?: number }

/** The words and controls of the step, without the requests: rendered in tests. */
export function IdentityCodeForm(props: {
  destination: string;
  sent: boolean;
  code: string;
  busy: boolean;
  secondsLeft: number;
  error: string;
  onCode: (value: string) => void;
  onSubmit: () => void;
  onResend: () => void;
}) {
  // The step swaps in where the consent button was, so the control the
  // candidate just pressed has gone. Focus goes to the heading: a screen
  // reader then says what this step is before asking for six digits, and a
  // keyboard user tabs straight into the code box.
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => { headingRef.current?.focus(); }, []);
  return (
    <form
      data-testid="identity-code-step"
      onSubmit={(e) => { e.preventDefault(); props.onSubmit(); }}
    >
      <h3 ref={headingRef} tabIndex={-1}>{IDENTITY_HEADING}</h3>
      <p className="small">{IDENTITY_WHY}</p>
      <p className="small" role="status">{props.sent ? codeSentMessage(props.destination) : SENDING_MESSAGE}</p>
      {props.error && <Banner kind="error"><span id="identity-code-error">{props.error}</span></Banner>}
      <label htmlFor="identity-code">{`${CODE_LENGTH}-digit code`}</label>
      <input
        id="identity-code"
        value={props.code}
        onChange={(e) => props.onCode(codeFromInput(e.target.value))}
        inputMode="numeric"
        autoComplete="one-time-code"
        pattern="[0-9]*"
        maxLength={CODE_LENGTH + 2}
        placeholder="123456"
        // The refusal is tied to the field, so a screen reader reaching the box
        // is told what went wrong rather than only that it is invalid.
        aria-invalid={props.error ? true : undefined}
        aria-describedby={props.error ? 'identity-code-error identity-code-help' : 'identity-code-help'}
        style={{ fontSize: 22, letterSpacing: 6, textAlign: 'center' }}
      />
      <button className="btn" style={{ width: '100%', marginTop: 12 }} disabled={!canSubmitCode(props.code, props.busy)}>
        <Icon name="check-circle" size={16} />{props.busy ? 'Checking…' : 'Confirm and continue'}
      </button>
      <button
        type="button"
        className="btn secondary sm"
        style={{ marginTop: 10 }}
        disabled={props.busy || props.secondsLeft > 0}
        onClick={props.onResend}
      >
        {resendLabel(props.secondsLeft)}
      </button>
      <div id="identity-code-help" className="card tight" style={{ background: 'var(--panel-2)', marginTop: 12 }}>
        <b className="check-label"><Icon name="about" size={16} />Didn't get the email?</b>
        <ul className="small" style={{ margin: '6px 0 0', paddingLeft: 18 }}>
          {NO_EMAIL_HELP.map((tip) => <li key={tip}>{tip}</li>)}
        </ul>
      </div>
    </form>
  );
}

/**
 * The code step of the portal journey: sends the code on arrival, takes the
 * six digits, and hands over to the audio check once the server confirms it.
 */
export function IdentityCodeStep({ token, identity, onVerified }: {
  token: string;
  identity: PortalIdentity;
  onVerified: () => void;
}) {
  const [sent, setSent] = useState(false);
  const [destination, setDestination] = useState(identity.destination);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [secondsLeft, setSecondsLeft] = useState(0);
  const requested = useRef(false);

  useEffect(() => {
    if (secondsLeft <= 0) return undefined;
    const timer = window.setTimeout(() => setSecondsLeft((s) => Math.max(0, s - 1)), 1000);
    return () => window.clearTimeout(timer);
  }, [secondsLeft]);

  const send = async () => {
    setError('');
    try {
      const res = await api.post<SendResponse>(`/portal/${token}/identity/code`, {});
      if (res.verified) { onVerified(); return; }
      // Not sent this time means one went out a moment ago (a reload, a second
      // tab): that code is still good to use, and the server says when to resend.
      setSent(true);
      if (res.destination) setDestination(res.destination);
      setSecondsLeft(res.sent ? res.resendAfterSeconds ?? RESEND_COOLDOWN_SECONDS : res.retryAfterSeconds ?? RESEND_COOLDOWN_SECONDS);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'We could not send the code. Please try again.');
    }
  };

  // Sent once on arrival. The ref stops a re-render (or React's development
  // double effect) from mailing the candidate twice.
  useEffect(() => {
    if (requested.current) return;
    requested.current = true;
    void send();
  }, []);

  const submit = async () => {
    if (!canSubmitCode(code, busy)) return;
    setBusy(true);
    setError('');
    try {
      await api.post(`/portal/${token}/identity/verify`, { code });
      onVerified();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'We could not check the code. Please try again.');
      if (e instanceof ApiError && (e.code === 'identity_code_locked' || e.code === 'identity_code_expired')) setCode('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <IdentityCodeForm
      destination={destination}
      sent={sent}
      code={code}
      busy={busy}
      secondsLeft={secondsLeft}
      error={error}
      onCode={setCode}
      onSubmit={() => void submit()}
      onResend={() => void send()}
    />
  );
}
