import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import { HttpError, asyncHandler } from '../middleware/index.js';
import { logger } from '../logger.js';
import { fingerprint } from '../middleware/rateLimit.js';
import { certificateFilename, findAwardByVerifyToken, verifyDisplayUrl } from '../services/awardAccess.js';
import {
  AwardEvidenceError, AwardEvidenceNotReadyError, certificateEvidence, claimFor, footnoteFor, hasCertificate,
} from '../services/awardEvidence.js';
import { certificatePdf, issuedOn } from '../services/certificatePdf.js';
import { isTier } from '../services/badgeGeometry.js';

/**
 * `questor.app/v/<token>` — the address printed on the face of every
 * certificate Questor issues.
 *
 * It existed on paper for a month before anything served it: the export put
 * the URL on the document, `web/src/App.tsx` redirected it to the front page,
 * and the email that sent a certificate said it was "available to view and
 * download here" while carrying no attachment. This router is the other half
 * of that promise.
 *
 * WHO READS THIS. Not a Questor user. An employer holding a piece of paper
 * somebody handed them, asking one question: is this real, and is it about the
 * person in front of me? So the page answers with the four facts the owner
 * chose — the name, the tier, the role and the date — and offers the document
 * itself. It says nothing about the organisation that ran the assessment,
 * nothing about how the candidate did, and nothing about who reviewed them.
 * The evidence rows were offered and declined.
 *
 * WHY IT IS A SEPARATE ROUTER. `candidateAwards.ts` calls `authenticate` on
 * the way in, which is right for every route on it and wrong for every route
 * here. A public route living inside an authenticated router is one `use()`
 * away from being authenticated by accident, or from making the whole router
 * public by accident. The two are kept apart so neither can happen quietly.
 *
 * WHAT IT NEVER DOES. There is no lookup by reference, by candidate, by
 * organisation or by anything a person could guess. `findAwardByVerifyToken`
 * is the only door, and the token behind it is 256 bits of independent
 * randomness — never derived from the reference printed beside it, because a
 * reference travels through emails, spreadsheets and ATS notes in the hands of
 * people who think it is an order number.
 */
export const awardVerifyRouter = Router();

/**
 * The one answer for every token that does not resolve.
 *
 * Three different things end here — a string that is not a token, a token that
 * was never minted, and a token whose award has been deleted because the
 * candidate exercised their right to erasure — and a reader must not be able
 * to tell which. "This record has been withdrawn" would tell an employer that
 * the person was once assessed here, which is precisely the fact an erasure
 * exists to remove.
 *
 * The wording points at the likeliest innocent cause instead, because it
 * almost always is one: a link read off paper, or one that a mail client broke
 * across two lines.
 *
 * ---- The cost of that choice, named rather than glossed
 *
 * An employer holding a genuine certificate for a candidate who has since been
 * erased is told Questor has no record of it, which reads as the paper being a
 * forgery. That is a real harm to a real person and it is not hypothetical.
 *
 * The alternative is worse. "This record was withdrawn" re-asserts to a
 * stranger holding a piece of paper that the person WAS assessed here, which
 * is the precise fact the erasure existed to remove — and the stranger is
 * often the one party the candidate least wants told. Erasure wins because it
 * is the promise Questor made to the candidate, and because the employer's
 * question still has an answer: they can ask the person in front of them.
 */
const NOT_FOUND =
  'Questor has no record matching this link. Check it against the certificate, character for character — links copied by hand or split across two lines are the usual reason.';

const NOT_READY =
  'This record is being brought up to date and cannot be shown just yet. Please try the link again shortly.';

const CORRUPT =
  'This record cannot be shown at the moment. Please try again later, or contact the organisation that sent you the certificate.';

function notFound(): HttpError {
  return new HttpError(404, NOT_FOUND, 'verification_not_found');
}

/**
 * A page with a named person on it, reached by a bearer URL.
 *
 * `no-store` rather than `no-cache`: the point is not revalidation but that no
 * copy is written down at all — not by a proxy, not by a corporate gateway,
 * not on the disk of the shared machine the employer opened it on.
 *
 * `X-Robots-Tag` is the instruction a crawler obeys once it already has the
 * response. It is the last of three lines rather than the only one — the SPA
 * ships `robots.txt` disallowing `/v/`, and the page itself sets a `robots`
 * meta tag — because this header alone cannot stop the HTML shell from being
 * indexed, and `robots.txt` alone is only honoured by crawlers that read it.
 *
 * Applied to refusals as well as to answers: a 404 carries no name, but a
 * cached 404 would make a genuine certificate look forged for as long as the
 * cache held it.
 */
awardVerifyRouter.use((req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.set('X-Robots-Tag', 'noindex, nofollow, noarchive, noimageindex');
  // On this router the PATH is the credential, and the app's error handler
  // logs the path of every failed request at error level. A 503 for a record
  // the sweep has not reached, or a 500 for one that cannot be read, would
  // therefore write a live bearer key into the log — the one place nobody
  // thinks to guard, and one an erasure can never reach. The comment above
  // `res.json` below says echoing a token back "is how one ends up in a log";
  // this is the line that makes that true rather than aspirational.
  //
  // A fingerprint rather than a bare `/api/v/…`: two log lines about the same
  // link can still be matched to each other, which is what an operator needs
  // to tell one broken certificate from twenty. Same device, and the same
  // reason, as the rate limiter's keys.
  req.logPath = `${req.baseUrl}/${fingerprint(pathToken(req.path))}`;
  next();
});

/** The token out of a router-relative path, whichever route under it was asked for. */
function pathToken(path: string): string {
  return path.replace(/^\/+/, '').split('/')[0] ?? '';
}

/**
 * The award this token verifies, or the one refusal.
 *
 * `hasCertificate` is the gate for the page and for the download alike, so the
 * two can never disagree about which tiers are public. Diamond is refused as
 * though it did not exist: it carries no certificate, its token is therefore
 * printed nowhere, and a verification page for a document that was never
 * issued is not verification of anything.
 */
async function verifiable(token: string) {
  const award = await findAwardByVerifyToken(token);
  if (!award) throw notFound();
  if (!isTier(award.tier) || !hasCertificate(award.tier)) throw notFound();
  return { ...award, tier: award.tier };
}

awardVerifyRouter.get('/:token', asyncHandler(async (req, res) => {
  const award = await verifiable(req.params.token);
  const evidence = certificateEvidence(award.id, award.evidenceJson);
  const claim = claimFor(award.tier, evidence.roleTitle);

  res.json({
    tier: award.tier,
    candidateName: evidence.candidateName,
    roleTitle: evidence.roleTitle,
    // Both the instant and the words. The page needs an instant for its
    // `<time>` element, and it needs the certificate's own rendering of the
    // date beside it: an employer is holding the paper and comparing the two,
    // and a page that wrote "25/09/2026" against a document reading "24
    // September 2026" would read as a mismatch rather than as a time zone.
    issuedAt: award.awardedAt,
    issuedOn: issuedOn(award.awardedAt),
    // The claim in the certificate's own words, from the same function the PDF
    // draws it with, in fragments so the page can set the tier and the role in
    // the same weight the document does. A second copy of this sentence in the
    // web bundle is a second place for it to drift.
    claim,
    // Bronze's footnote adds that the document is the hiring team's and was
    // never issued to the candidate. Whoever is holding one should read that
    // here as well as on the paper.
    footnote: footnoteFor(award.tier),
    // Deliberately no reference and no token. The reference is not one of the
    // four facts the owner chose, and the token is the credential that reached
    // this route — echoing a bearer value back into a body is how one ends up
    // in a log or a screenshot. The page builds the download path from the
    // address it is already on.
  });
}));

awardVerifyRouter.get('/:token/certificate.pdf', asyncHandler(async (req, res) => {
  const award = await verifiable(req.params.token);
  const evidence = certificateEvidence(award.id, award.evidenceJson);

  const pdf = await certificatePdf({
    tier: award.tier,
    reference: award.reference,
    // `verifyDisplayUrl`, exactly as the authenticated export uses it, so the
    // document this page hands out is byte for byte the one the hiring team
    // exports. Built from configuration and never from the request's `Host`
    // header, which the caller chooses: a certificate printing a verification
    // link at an address an attacker named would be a forgery Questor rendered
    // on request.
    //
    // The caller's own string rather than the stored column, and they are the
    // same string: the lookup was an exact match on a unique column, so an
    // award only reached this line because the two are equal. The column stays
    // out of the select on purpose — `verifiable` returns a spread of this row,
    // and a token in it is one careless `res.json(award)` away from being
    // published.
    verifyUrl: verifyDisplayUrl(req.params.token),
    issuedAt: award.awardedAt,
    evidence,
  });

  // Nothing is audited here, deliberately. The audit log is scoped to a tenant
  // and names actors; this caller is neither, and writing a row per request
  // would turn an unauthenticated endpoint into an unauthenticated writer.
  // `sentToCandidateAt` already records the one act a tenant took.
  res.type('application/pdf');
  res.set('Content-Disposition', `attachment; filename="${certificateFilename(award.reference, award.tier)}"`);
  res.send(pdf);
}));

/**
 * The two states a stored record can be in that are not "renderable", in the
 * words a stranger can act on.
 *
 * `award_evidence_not_ready` is answered rather than hidden behind the 404
 * above, and that does tell the caller a record exists. It is the right trade:
 * reaching this line means holding 256 bits of token, so they already knew,
 * and telling a candidate that their real certificate is unknown to Questor is
 * a worse answer than asking them to come back in a minute. The record is
 * never reconstructed here — the migration happens at rest, for the reason
 * `awardEvidence.ts` gives at length.
 */
awardVerifyRouter.use((err: unknown, _req: Request, _res: Response, next: NextFunction) => {
  if (err instanceof AwardEvidenceNotReadyError) {
    logger.error({ err, awardId: err.awardId }, 'a certificate was verified before its record was brought up to date');
    next(new HttpError(503, NOT_READY, { code: 'award_evidence_not_ready', retryAfterSeconds: 60 }));
    return;
  }
  if (err instanceof AwardEvidenceError) {
    logger.error({ err, awardId: err.awardId }, 'an award cannot be verified because its stored record is incomplete');
    next(new HttpError(500, CORRUPT, 'award_evidence_corrupt'));
    return;
  }
  next(err);
});
