import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../api/client';
import { BrandLogo } from '../components/BrandLogo';
import { Icon } from '../components/Icon';
import { hasPrivacyPage } from '../components/privacyRoute';
import {
  conversationLine, feedbackHeading, feedbackNote, firstName, privacyNoticeHref, retentionLine,
  statusHeading, statusSteps, whatHappensNext,
  feedbackProvenance, type LetterSource, LINK_IS_SPENT, NEXT_HEADING, PRIVACY_LINK_TEXT, TALK_BUTTON, TALK_FAILED,
  TALK_HEADING, TALK_INVITE, TALK_RECORDED, TALK_SENDING, WHERE_YOU_ARE,
  type StatusView,
} from '../components/candidateStatusModel';

/**
 * The candidate's status page: where the invitation link leads once the
 * interview is over.
 *
 * The same URL, deliberately. It is the only address a candidate has for this,
 * it is in their inbox, and until now it led to a dead end that told them to
 * reply to an email. It cannot start another interview — the server refuses
 * that independently of this page — and the opening paragraph says so kindly
 * rather than leaving them to discover it by pressing something.
 *
 * Everything shown here comes from GET /api/portal/:token/status, which sends
 * no score, no verdict, no competency and nothing about anybody else. The
 * written feedback, when it has actually been sent, comes from
 * GET /api/portal/:token/feedback — the endpoint that already outlived the
 * interview and had no page to render it.
 *
 * Reachability, not decoration: proper landmarks and headings, one column at
 * 375px, the room's dark palette in both themes, and every state announced in
 * words rather than only by colour.
 */

interface LetterResponse {
  approvedText: string;
  source?: LetterSource;
  sentAt: string;
}

type TalkState = 'idle' | 'sending' | 'recorded' | 'failed';
type Dead = 'expired' | 'unknown' | 'not_yet' | 'failed';
/** Whether the letter itself has been fetched, separately from whether it exists. */
type LetterState = 'idle' | 'loading' | 'ready' | 'missing';

export function CandidateStatus({ token, takeFocus = false }: { token: string; takeFocus?: boolean }) {
  const [view, setView] = useState<StatusView | null>(null);
  const [letter, setLetter] = useState<LetterResponse | null>(null);
  const [letterState, setLetterState] = useState<LetterState>('idle');
  const [dead, setDead] = useState<Dead | null>(null);
  const [talk, setTalk] = useState<TalkState>('idle');
  // Set when this page replaced a form the candidate had just pressed a button
  // on. The button is gone, and focus left on nothing strands a keyboard or
  // screen-reader user at the top of a page with no announcement of what
  // changed — so focus moves to the heading that explains it.
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { if (takeFocus && view) heading.current?.focus(); }, [takeFocus, view]);

  useEffect(() => {
    let cancelled = false;
    // Everything on screen belongs to the token that is going away. React keeps
    // this component instance across a change of the :token param, so without
    // this one candidate's name, timeline and letter would stay on screen while
    // another's token loaded — and an old letter could even render under a new
    // view. Cleared first, so the page shows nothing rather than somebody else.
    setView(null);
    setLetter(null);
    setLetterState('idle');
    setDead(null);
    setTalk('idle');
    api.get<StatusView>(`/portal/${token}/status`)
      .then((loaded) => { if (!cancelled) setView(loaded); })
      .catch((err: unknown) => {
        if (cancelled) return;
        // An erased candidate's link resolves to nothing, and that is the
        // correct outcome of an erasure — so it is answered as a closed link,
        // not as a broken page.
        const status = err instanceof ApiError ? err.status : 0;
        if (status === 410) { setDead('expired'); return; }
        if (status === 404) { setDead('unknown'); return; }
        // 409: this link is still an invitation, so there is no status page
        // behind it yet. Reachable from a session state nothing currently
        // writes (see portalEntryModel's READY_STATES without consent), and it
        // must read as the old "not open right now" card rather than a fault.
        setDead(status === 409 ? 'not_yet' : 'failed');
      });
    return () => { cancelled = true; };
  }, [token]);

  useEffect(() => {
    if (view?.feedback.outlook !== 'arrived') return;
    let cancelled = false;
    setLetterState('loading');
    // A 404 here is ordinary rather than a fault: the outlook and the letter
    // are two reads and the letter can land between them. It is still recorded
    // as `missing` rather than swallowed, because a heading that says "Feedback
    // from your conversation" over an empty box is the one thing this section
    // must never do — the page says instead that the words are in their inbox.
    api.get<LetterResponse>(`/portal/${token}/feedback`)
      .then((got) => { if (!cancelled) { setLetter(got); setLetterState('ready'); } })
      .catch(() => { if (!cancelled) setLetterState('missing'); });
    return () => { cancelled = true; };
  }, [token, view?.feedback.outlook]);

  const askForAPerson = useCallback(async () => {
    setTalk('sending');
    try {
      await api.post(`/portal/${token}/talk-to-a-person`, {});
      setTalk('recorded');
    } catch {
      setTalk('failed');
    }
  }, [token]);

  if (dead) return <ClosedLink kind={dead} />;
  if (!view) return <Loading />;

  const steps = statusSteps(view);
  const outlook = view.feedback.outlook;
  const alreadyAsked = view.talkToAPerson.requested || talk === 'recorded';

  return (
    <div className="cstatus">
      <main className="cstatus-page" aria-labelledby="cstatus-title">
        <div className="cstatus-top">
          {/* The page paints itself dark whatever the theme, so the logo is
              told which surface it is on rather than reading the app's. */}
          <BrandLogo variant="mark" size={20} surfaceTone="dark" decorative />
          <span className="cstatus-org">{view.organisation} &middot; interviews by Questor</span>
        </div>

        <header className="cstatus-hero">
          <span className="cstatus-avatar" aria-hidden="true">
            <b>{initialOf(view.interviewer ?? view.organisation)}</b>
          </span>
          <h1 id="cstatus-title" ref={heading} tabIndex={-1}>{statusHeading(view)}</h1>
          <p>{conversationLine(view)} {LINK_IS_SPENT}</p>
        </header>

        <section aria-labelledby="cstatus-where">
          <h2 className="cstatus-label" id="cstatus-where">{WHERE_YOU_ARE}</h2>
          <ol className="cstatus-steps">
            {steps.map((step) => (
              <li key={step.key} className={`cstatus-step-${step.state}`}>
                <span className="cstatus-dot">
                  {/* The tick is the only mark that carries meaning on its own;
                      every other state is named in the text beside it. */}
                  {step.state === 'done' && <Icon name="check" size={12} />}
                </span>
                <span>
                  <b>{step.title}</b>
                  <span>{step.detail}</span>
                </span>
              </li>
            ))}
          </ol>
        </section>

        <section className="cstatus-box" aria-labelledby="cstatus-next">
          <h2 id="cstatus-next">{NEXT_HEADING}</h2>
          <p>{whatHappensNext(view)}</p>
        </section>

        <section
          className={`cstatus-box ${outlook === 'arrived' ? 'cstatus-box-letter' : 'cstatus-box-waiting'}`}
          aria-labelledby="cstatus-feedback"
        >
          <h2 id="cstatus-feedback">{feedbackHeading(outlook)}</h2>
          {outlook === 'arrived' && letter
            ? (
              <>
                <p className="cstatus-letter" data-testid="cstatus-letter">{letter.approvedText}</p>
                <p className="cstatus-provenance">{feedbackProvenance(letter.source ?? 'automatic')}</p>
              </>
            )
            : <p data-testid="cstatus-feedback-note">{feedbackNote(view, letterState === 'loading')}</p>}
        </section>

        <section className="cstatus-box" aria-labelledby="cstatus-talk">
          <h2 id="cstatus-talk">{TALK_HEADING}</h2>
          {alreadyAsked
            ? (
              <p className="cstatus-talk-done" data-testid="cstatus-talk-recorded">
                <Icon name="check-circle" size={16} />
                <span>{TALK_RECORDED}</span>
              </p>
            )
            : (
              <>
                <p>{TALK_INVITE}</p>
                <button
                  type="button"
                  className="cstatus-talk-btn"
                  disabled={talk === 'sending'}
                  onClick={() => { void askForAPerson(); }}
                >
                  {talk === 'sending' ? TALK_SENDING : TALK_BUTTON}
                </button>
              </>
            )}
          {/* Announced, not just coloured: a failure here is the difference
              between "nobody is coming" and "press it again". */}
          <p className="cstatus-error" role="status">{talk === 'failed' ? TALK_FAILED : ''}</p>
        </section>

        <footer className="cstatus-foot">
          <p>{retentionLine(view)}</p>
          <p><Link to={privacyNoticeHref(hasPrivacyPage)}>{PRIVACY_LINK_TEXT}</Link></p>
        </footer>
      </main>
    </div>
  );
}

function initialOf(name: string): string {
  return firstName(name).charAt(0).toUpperCase() || 'Q';
}

function Loading() {
  return (
    <div className="cstatus">
      <div className="cstatus-centre">
        <p role="status">Loading where your interview stands&hellip;</p>
      </div>
    </div>
  );
}

const CLOSED: Readonly<Record<Dead, { title: string; body: string }>> = {
  // Both of these are reached by a link that no longer resolves to anything —
  // an expiry, or an erasure that did exactly what it was asked to. Neither is
  // an error, and neither is the candidate's fault, so neither is shown as one.
  expired: {
    title: 'This link has expired',
    body: 'It is no longer possible to see the status of this interview here. '
      + 'If you would like to know where things stand, reply to your invitation email and the hiring team will tell you.',
  },
  unknown: {
    title: 'This link is no longer active',
    body: 'It may have expired, or the details it pointed to may have been deleted at your request. '
      + 'If you were expecting to see something here, reply to your invitation email and we will look into it.',
  },
  not_yet: {
    title: 'This interview is not open right now',
    body: 'If you think that is wrong, reply to your invitation email and we will look into it.',
  },
  failed: {
    title: 'We could not load this just now',
    body: 'Something went wrong at our end. Please try again in a few minutes.',
  },
};

function ClosedLink({ kind }: { kind: Dead }) {
  const { title, body } = CLOSED[kind];
  return (
    <div className="cstatus">
      <main className="cstatus-centre" aria-labelledby="cstatus-closed">
        <div>
          <h1 id="cstatus-closed">{title}</h1>
          <p>{body}</p>
        </div>
      </main>
    </div>
  );
}
