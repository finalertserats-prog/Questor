import { useEffect, useId, useRef, useState, type KeyboardEvent, type MouseEvent, type SyntheticEvent } from 'react';
import { api, ApiError } from '../api/client';
import { useAuth } from '../auth';
import { can } from './capabilityModel';
import { formatDate } from './dateFormat';
import { Icon } from './Icon';
import type { AwardRowView } from './candidateAwardsModel';

/**
 * The credential, open inside the app.
 *
 * Pressing Badge or Certificate on the journey used to save a file, and the
 * owner's complaint was exact: on Windows an `.svg` is labelled "Microsoft
 * Edge HTML Document", so a badge download read as "an HTML file", and in
 * any case nobody had asked for a download. They asked to SEE it. So this is
 * a dialog showing the badge the server drew and the certificate the server
 * laid out — the same bytes a download would save, fetched once — and the
 * three things a person then does with a credential are inside it:
 *
 *   Download            the bytes on screen, under the server's filename
 *   Copy verification   the public `…/v/<token>` page the certificate prints;
 *                       "share" is that link and nothing new
 *   Send to candidate   an admin releasing a Silver or a Gold, once, after a
 *                       confirmation that names who is about to get mail
 *
 * A native <dialog>, so the page behind is inert and the top layer is the
 * browser's, not a z-index. What it does not do on its own — return focus to
 * the button that opened it, lock the page's scroll, close on a click outside
 * — is done here.
 */

export type AwardViewKind = 'badge' | 'certificate';

export interface AwardViewerProps {
  readonly row: AwardRowView;
  readonly kind: AwardViewKind;
  readonly candidateName: string;
  readonly onClose: () => void;
  /** The certificate went: the journey row should now say so. */
  readonly onSent: (sentToCandidateAt: string) => void;
}

interface ShownFile {
  readonly blob: Blob;
  readonly url: string;
  readonly filename: string;
}

type LinkState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'copied'; readonly url: string }
  /** The clipboard refused, so the address is shown to be copied by hand. */
  | { readonly kind: 'manual'; readonly url: string };

type SendState = 'idle' | 'confirm' | 'sending';

function describe(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

/**
 * Whether this browser can show a PDF inside the page at all.
 *
 * Android Chrome and most in-app browsers cannot, and say so through
 * `pdfViewerEnabled`; a browser that does not know the flag is given the
 * benefit of the doubt, and "Open in a new tab" is offered regardless.
 */
function pdfInlineSupported(): boolean {
  const flag = (navigator as Navigator & { pdfViewerEnabled?: boolean }).pdfViewerEnabled;
  return flag !== false;
}

export function AwardViewer({ row, kind, candidateName, onClose, onSent }: AwardViewerProps) {
  const { user } = useAuth();
  const titleId = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  // Copy and send are not abortable requests; this is what stops their
  // answers landing on a dialog that has since been closed.
  const mounted = useRef(true);
  const [file, setFile] = useState<ShownFile | null>(null);
  const [failure, setFailure] = useState('');
  const [link, setLink] = useState<LinkState>({ kind: 'idle' });
  const [linkBusy, setLinkBusy] = useState(false);
  const [send, setSend] = useState<SendState>('idle');
  const [sentAt, setSentAt] = useState<string | null>(row.sentToCandidateAt);

  const path = kind === 'badge' ? row.badgePath : row.certificatePath;
  const fallbackName = `${row.fileStem}-${kind}.${kind === 'badge' ? 'svg' : 'pdf'}`;
  const title = `${row.label} ${kind}`;

  // Open as a modal, and give focus back to whatever opened it when it goes:
  // the button on the journey row, so a keyboard user lands where they were.
  useEffect(() => {
    mounted.current = true;
    const dialog = dialogRef.current;
    const returnTo = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (dialog && !dialog.open) dialog.showModal();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      mounted.current = false;
      document.body.style.overflow = previousOverflow;
      // Closed BEFORE focus moves. While a modal dialog is open everything
      // outside it is inert, and focusing an inert button is silently a
      // no-op — the keyboard user would be dropped at the top of the page.
      if (dialog?.open) dialog.close();
      returnTo?.focus();
    };
  }, []);

  // Fetch once, show, and let the object URL go when the dialog does. Without
  // the revoke the document stays in memory for the life of the tab; without
  // the abort a dialog closed mid-fetch would set state on nothing.
  useEffect(() => {
    if (!path) {
      setFailure('There is nothing to show for this tier.');
      return undefined;
    }
    const controller = new AbortController();
    let url = '';
    api.fetchFile(path, { signal: controller.signal })
      .then((fetched) => {
        if (controller.signal.aborted) return;
        // Only the type asked for is shown. A blob URL carries this page's
        // origin, and an <object> given an HTML body would run it as this
        // page — so anything that is not the badge's SVG or the
        // certificate's PDF is refused rather than displayed.
        const type = fetched.blob.type.toLowerCase().split(';', 1)[0].trim();
        if (type !== (kind === 'badge' ? 'image/svg+xml' : 'application/pdf')) {
          setFailure(`The server answered with something other than a ${kind === 'badge' ? 'badge' : 'certificate'}. Try again in a moment.`);
          return;
        }
        url = URL.createObjectURL(fetched.blob);
        setFile({ blob: fetched.blob, url, filename: fetched.filename ?? fallbackName });
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setFailure(describe(err, 'That file could not be prepared. Try again in a moment.'));
      });
    return () => {
      controller.abort();
      if (url) URL.revokeObjectURL(url);
    };
  }, [path, fallbackName, kind]);

  // The confirmation replaces the button that asked for it, so focus would
  // otherwise be dropped on the body; it lands on the answer instead.
  useEffect(() => {
    if (send === 'confirm') confirmRef.current?.focus();
  }, [send]);

  const close = () => onClose();

  // The native `close` event: the browser (or something driving it) closed
  // the dialog without a button here being pressed, and the parent must hear
  // of it.
  //
  // Browsers fire it as a queued task, after the fact, so the close the
  // cleanup above performs also lands here — once the component is gone, or,
  // under StrictMode's mount-cleanup-mount in development, once it has
  // mounted again and re-opened the dialog. A flag reset in the cleanup
  // cannot tell those apart (it has been reset by the time the event
  // arrives; that is how the viewer came to vanish the instant it opened).
  // The state of the dialog can: an event for a dialog that is open again,
  // or for a component no longer mounted, is stale.
  const onNativeClose = () => {
    if (!mounted.current || dialogRef.current?.open) return;
    close();
  };

  const onCancel = (event: SyntheticEvent<HTMLDialogElement>) => {
    // The browser's own Escape. Closing is the parent's decision, not the
    // element's, so it is refused here and asked for there.
    event.preventDefault();
    close();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDialogElement>) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    close();
  };

  // A click on the backdrop lands on the dialog element itself; one inside
  // lands on the sheet within it.
  const onClick = (event: MouseEvent<HTMLDialogElement>) => {
    if (event.target === dialogRef.current) close();
  };

  const download = () => {
    if (!file) return;
    api.saveFile(file.blob, file.filename);
  };

  const copyLink = async () => {
    if (!row.verifyLinkPath || linkBusy) return;
    setLinkBusy(true);
    setFailure('');
    try {
      const answer = await api.get<{ verifyUrl: string }>(row.verifyLinkPath);
      if (!mounted.current) return;
      try {
        if (!navigator.clipboard) throw new Error('no clipboard');
        await navigator.clipboard.writeText(answer.verifyUrl);
        if (mounted.current) setLink({ kind: 'copied', url: answer.verifyUrl });
      } catch {
        // A clipboard refused — an insecure page, a permission, a webview —
        // is not a reason to withhold the link. Show it; the person copies.
        if (mounted.current) setLink({ kind: 'manual', url: answer.verifyUrl });
      }
    } catch (err: unknown) {
      if (mounted.current) setFailure(describe(err, 'The verification link could not be fetched. Try again in a moment.'));
    } finally {
      if (mounted.current) setLinkBusy(false);
    }
  };

  const sendNow = async () => {
    if (!row.sendPath) return;
    setSend('sending');
    setFailure('');
    try {
      const answer = await api.post<{ sentToCandidateAt: string }>(row.sendPath);
      // The row is told whether or not the dialog is still open: the mail has
      // gone, and a journey that went on offering the button would be wrong.
      onSent(answer.sentToCandidateAt);
      if (!mounted.current) return;
      setSentAt(answer.sentToCandidateAt);
      setSend('idle');
    } catch (err: unknown) {
      if (!mounted.current) return;
      setFailure(describe(err, 'The certificate could not be sent. Nothing has been recorded — try again.'));
      setSend('idle');
    }
  };

  // Only once the certificate is on screen. The point of sending from here is
  // that the person has seen what the candidate is about to receive, and a
  // sheet that failed to render is one nobody has seen.
  const canSend = kind === 'certificate' && row.sendPath !== null && can(user, 'admin:manage') && file !== null && !failure;

  return (
    <dialog
      ref={dialogRef}
      className="award-viewer"
      aria-labelledby={titleId}
      onCancel={onCancel}
      // Closed by the browser rather than by a button here (an extension, a
      // future UA behaviour): the parent must hear of it, or the journey
      // would believe a dialog nobody can see is still open.
      onClose={onNativeClose}
      onKeyDown={onKeyDown}
      onClick={onClick}
    >
      <div className="award-viewer-sheet">
        <header className="award-viewer-head">
          <div>
            <h2 id={titleId} className="award-viewer-title">{title}</h2>
            <p className="award-viewer-sub muted small">
              {candidateName}
              {row.reference ? ` · ${row.reference}` : ''}
              {row.awardedAt ? ` · ${formatDate(row.awardedAt)}` : ''}
            </p>
          </div>
          <button type="button" className="award-viewer-close" onClick={close} aria-label="Close">
            <Icon name="close" />
          </button>
        </header>

        <div className={`award-viewer-stage award-viewer-stage-${kind}`}>
          {!file && !failure && <p className="award-viewer-wait muted">Preparing the {kind}…</p>}
          {file && kind === 'badge' && (
            <img className="award-viewer-badge" src={file.url} alt={`${row.label} badge`} />
          )}
          {file && kind === 'certificate' && (pdfInlineSupported() ? (
            // The viewer's own toolbar and thumbnail rail are asked to stand
            // down (PDF open parameters, honoured by Chrome, Edge and Acrobat)
            // so the sheet fills the stage; the new-tab link keeps them.
            <object className="award-viewer-sheet-pdf" data={`${file.url}#toolbar=0&navpanes=0&view=FitH`} type="application/pdf" aria-label={`${row.label} certificate`}>
              <p className="award-viewer-wait muted">
                This browser cannot show the certificate here. Open it in a new tab or download it.
              </p>
            </object>
          ) : (
            <p className="award-viewer-wait muted">
              This browser cannot show the certificate here. Open it in a new tab or download it.
            </p>
          ))}
        </div>

        {failure && <p className="award-failure" role="alert">{failure}</p>}

        <div className="award-viewer-actions">
          <button type="button" className="award-action award-action-primary" onClick={download} disabled={!file}>
            <Icon name="export" />Download
          </button>
          {row.verifyLinkPath && (
            <button type="button" className="award-action" onClick={() => void copyLink()} disabled={linkBusy}>
              <Icon name="link" />{linkBusy ? 'Fetching link…' : 'Copy verification link'}
            </button>
          )}
          {kind === 'certificate' && file && (
            <a className="award-action" href={file.url} target="_blank" rel="noopener">
              <Icon name="eye" />Open in a new tab
            </a>
          )}
          {canSend && sentAt === null && send === 'idle' && (
            <button type="button" className="award-action" onClick={() => setSend('confirm')}>
              <Icon name="send" />Send to candidate
            </button>
          )}
        </div>

        {/* Announced politely, so a screen reader hears that the copy happened
            without the focus moving off the button that did it. */}
        <p className="award-viewer-status" role="status" aria-live="polite">
          {link.kind === 'copied' ? 'Verification link copied.' : ''}
        </p>
        {link.kind === 'manual' && (
          <label className="award-viewer-manual">
            <span className="muted small">The clipboard refused. Copy the link from here:</span>
            <input type="text" readOnly aria-label="Verification link" value={link.url} onFocus={(event) => event.currentTarget.select()} />
          </label>
        )}

        {kind === 'certificate' && row.internal && (
          <p className="award-viewer-note muted small">
            A Bronze record is held by the hiring team and is not issued to the candidate.
          </p>
        )}
        {kind === 'certificate' && !row.internal && sentAt && (
          <p className="award-viewer-note muted small">Sent to the candidate on {formatDate(sentAt)}.</p>
        )}
        {canSend && sentAt === null && send !== 'idle' && (
          <div className="award-viewer-confirm" role="group" aria-label="Confirm sending">
            <p>
              Email this certificate to <b>{candidateName}</b>? They receive a short message with the
              reference and a link to the public verification page. This is done once and is recorded.
            </p>
            <div className="award-viewer-actions">
              <button ref={confirmRef} type="button" className="award-action award-action-primary" onClick={() => void sendNow()} disabled={send === 'sending'}>
                {send === 'sending' ? 'Sending…' : 'Yes, send it'}
              </button>
              <button type="button" className="award-action" onClick={() => setSend('idle')} disabled={send === 'sending'}>
                Not now
              </button>
            </div>
          </div>
        )}
      </div>
    </dialog>
  );
}
