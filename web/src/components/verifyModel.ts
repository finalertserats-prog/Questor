/**
 * The public verification page, minus React.
 *
 * `questor.app/v/<token>` is printed on the face of every certificate Questor
 * issues. It is the only page an employer ever sees, and the only one a
 * candidate reaches without being invited to anything, so its words are worth
 * holding to something — which is what this file is for.
 *
 * Nothing here decides what is shown. The four facts come from the server, in
 * the certificate's own words, and a page that assembled its own sentence
 * about a tier or a role would be a second place for that sentence to live and
 * the first place it would drift from the paper.
 */

export type VerifyPhase = 'loading' | 'verified' | 'unknown' | 'notReady' | 'failed';

/** The claim line, in the fragments the certificate sets in different weights. */
export interface VerifyClaim {
  readonly lead: string;
  readonly tier: string;
  readonly middle: string;
  readonly role: string;
}

/** GET /api/v/:token. Four facts, the claim and the footnote; deliberately nothing else. */
export interface VerifiedRecord {
  readonly tier: 'bronze' | 'silver' | 'gold';
  readonly candidateName: string;
  readonly roleTitle: string;
  readonly issuedAt: string;
  readonly issuedOn: string;
  readonly claim: VerifyClaim;
  readonly footnote: string;
}

/**
 * Which state an answer leaves the page in.
 *
 * 404 is every way a token can fail to resolve — nonsense, never minted, or an
 * award deleted because the candidate was erased — and the server answers all
 * three identically on purpose. The page must keep them identical too: a state
 * of its own for "deleted" would put the distinction back on the screen that
 * the server went to the trouble of removing.
 *
 * 429 lands in `failed` rather than in a state of its own. Someone reading a
 * certificate has made one request; being over a limit means a script shares
 * their address, and "try again in a moment" is both true and all they can do.
 */
export function verifyPhaseFor(status: number): VerifyPhase {
  if (status === 404) return 'unknown';
  if (status === 503) return 'notReady';
  return 'failed';
}

export interface VerifyMessage {
  readonly title: string;
  readonly body: string;
}

export const VERIFY_COPY: Readonly<Record<'verified' | 'unknown' | 'notReady' | 'failed', VerifyMessage>> = {
  /**
   * The answer an employer came for, in one line, before anything else on the
   * page. "Issued" rather than "valid" or "authentic": Questor can say what it
   * did, and a certificate is never a statement about what a person is worth.
   */
  verified: {
    title: 'Questor issued this certificate.',
    body: 'This is what Questor holds for it.',
  },
  /**
   * A link that does not resolve. It says nothing about whether it ever did —
   * a candidate who has exercised their right to erasure has had their awards
   * deleted, and a page reading "withdrawn" would tell an employer that they
   * were assessed here after all.
   *
   * So it names the likeliest innocent cause instead, which it almost always
   * is: a link typed off paper, or one a mail client broke across two lines.
   */
  unknown: {
    title: 'We can’t check this link.',
    body: 'Questor has no record matching it. Check the link against the certificate, character for character — links copied by hand or split across two lines are the usual reason.',
  },
  notReady: {
    title: 'This record isn’t ready yet.',
    body: 'It is being brought up to date. Please try the link again in a few minutes — nothing is wrong with the certificate.',
  },
  failed: {
    title: 'Something went wrong at our end.',
    body: 'The record could not be checked just now. Please try again in a moment.',
  },
};

/**
 * What this page is, for a reader who has never heard of Questor, and what it
 * deliberately does not show.
 *
 * An employer holding a certificate will read it as a reference unless told
 * otherwise, which is what the footnote on the document exists to deny. Saying
 * the same thing here in full sentences is the difference between a page that
 * verifies a record and a page that endorses a person.
 */
export const VERIFY_EXPLANATION =
  'Questor runs structured assessments and records what happened in them. This page shows what is printed on the certificate and nothing further: how the candidate did, and who assessed them, belong to the organisation that ran the assessment.';

/** No account, no password — said plainly, because nobody reaching this page has one. */
export const VERIFY_NO_ACCOUNT_NEEDED = 'No account is needed to open this page or to download the certificate.';

export const VERIFY_DOWNLOAD_LABEL = 'Download the certificate';
export const VERIFY_RETRY_LABEL = 'Try again';

export const VERIFY_DOWNLOAD_FAILED = 'The certificate could not be prepared. Please try again in a moment.';

/** `api.download` prefixes /api itself, so this is the path without it. */
export function certificateDownloadPath(token: string): string {
  return `/v/${token}/certificate.pdf`;
}

/**
 * Only a fallback. The server sends a `Content-Disposition` naming the file by
 * its reference and `api.download` prefers that; this is what is left if a
 * proxy strips the header. It names no person for the same reason the server's
 * filename does not: a filename travels into download folders and shared
 * drives that an erasure request can never reach.
 */
export function certificateFallbackFilename(tier: string): string {
  return `questor-${tier}-certificate.pdf`;
}
