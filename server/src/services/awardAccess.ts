import { prisma } from '../db.js';
import { config } from '../config.js';
import { HttpError } from '../middleware/index.js';
import { assertCanAccessCandidate } from './access.js';
import type { AuthClaims } from './auth.js';
import { isTier, type Tier } from './badgeGeometry.js';

/**
 * Reading an award for export.
 *
 * Separate from `candidateAwards.ts`, which STRIKES awards inside a promotion's
 * own transaction. These two halves were written in parallel by different
 * lanes, and the split turned out to be the right one rather than an accident:
 * striking is a write on the hot path of a stage move, and this is a read on
 * the way to a document about a named person. They share a table and nothing
 * else.
 *
 * Everything here is deliberately narrow: a certificate is a document about a
 * named person, and the only thing standing between one organisation and
 * another's is the filter on the query that fetches it.
 */

export type AwardRow = Awaited<ReturnType<typeof prisma.candidateAward.findFirst>>;

export function readTier(value: string): Tier {
  // Not a 400: a tier that is not a tier is a URL that does not exist, and
  // answering "that is the wrong shape" is a different sentence from "there is
  // nothing here", which is the one every other miss on this router says.
  if (!isTier(value)) throw new HttpError(404, 'Award not found');
  return value;
}

/**
 * The award, or a 404 that says nothing about whether it exists.
 *
 * Two gates, not one. `assertCanAccessCandidate` decides whether the caller may
 * see this person at all — tenant first, then the assignments a non-admin is
 * limited to — and the award query then repeats the tenant filter and pins the
 * candidate to the row it already proved. The repetition is the point: this
 * function is the only way an award reaches a renderer, and a `findFirst` on
 * `{ candidateId, tier }` alone would be a correct-looking query that returns
 * another organisation's document the first time an id is guessed or leaks.
 *
 * The role is pinned too, not just the candidate. `@@unique` is on
 * `[candidateId, roleId, tier]`, so the same candidate row could in principle
 * carry two Silvers, and `orderBy awardedAt desc` alone would then export
 * whichever was struck last — a certificate naming the wrong role, rendered
 * from the wrong frozen evidence, under a reference the reader cannot tell
 * apart from the right one. Questor writes one candidate row per application,
 * so `candidate.roleId` is the application being looked at; when it is absent
 * there is nothing to disambiguate with and the most recent is the honest
 * answer.
 */
export async function assertCanAccessAward(auth: AuthClaims, candidateId: string, tier: Tier) {
  const candidate = await assertCanAccessCandidate(auth, candidateId);
  const award = await prisma.candidateAward.findFirst({
    // `auth.tenantId` rather than `candidate.tenantId`. The two are the same
    // value — the scope filter above cannot return a candidate from another
    // tenant — but a reviewer reading this query alone should not have to
    // prove that before believing it, and the day someone widens
    // `candidateScope` is the day the weaker spelling stops being equivalent.
    where: {
      tenantId: auth.tenantId,
      candidateId: candidate.id,
      tier,
      ...(candidate.roleId ? { roleId: candidate.roleId } : {}),
    },
    orderBy: { awardedAt: 'desc' },
  });
  if (!award) throw new HttpError(404, 'Award not found');
  return award;
}

/**
 * What the certificate prints under "Verify".
 *
 * Built from `verifyToken` and never from `reference`. The approved mockup
 * shows `QS-SLV-8F2K-4471` beside `questor.app/v/8F2K4471`, which reads as one
 * derived from the other — and if it were, the printed reference on any
 * certificate would hand a reader the verification link for it, and a
 * reference is quoted in emails, spreadsheets and ATS notes by people who
 * think it is an order number. The token is a separate random column for that
 * reason, and this function is the only place the printed link comes from.
 */
export function verifyDisplayUrl(verifyToken: string): string {
  return `${config.webOrigin.replace(/^https?:\/\//, '').replace(/\/+$/, '')}/v/${verifyToken}`;
}

/**
 * The download's name.
 *
 * The reference and nothing else. A candidate's name in a filename travels
 * into download folders, mail clients and shared drives that an erasure
 * request can never reach, and the organisation's name is absent from the
 * document for the same reason it is absent here.
 */
export function certificateFilename(reference: string, tier: Tier): string {
  const stem = reference.replace(/[^A-Za-z0-9-]+/g, '').slice(0, 40) || 'certificate';
  return `questor-${tier}-${stem}.pdf`;
}

export function badgeFilename(reference: string, tier: Tier, extension: 'png' | 'svg'): string {
  const stem = reference.replace(/[^A-Za-z0-9-]+/g, '').slice(0, 40) || 'badge';
  return `questor-${tier}-${stem}.${extension}`;
}
