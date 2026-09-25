/**
 * The candidate's journey, one row per tier.
 *
 * The rule the rows exist to show: a tier is earned when the candidate is
 * promoted OUT of it. Silver is struck by the move to Gold, Gold by the move
 * to Diamond, and Diamond by arriving. So a candidate whose Silver interview
 * is finished but who has not been progressed has no Silver badge, no
 * certificate and no export — only the reason it is not there yet.
 *
 * Nothing here decides whether a tier is earned. The server ships a row that
 * either carries a reference and an export path or carries a reason, and a
 * view that inferred "earned" from anything else — a stage, a date, an
 * interview being complete — would be the second place that rule lives and
 * the first place it drifts.
 */

export type AwardTier = 'bronze' | 'silver' | 'gold' | 'diamond';

export interface AwardExports {
  readonly badgeSvg: string;
  readonly badgePng: string;
  readonly certificatePdf: string | null;
}

/** One row as the server sends it (GET /api/candidates/:id/awards). */
export interface AwardResponseRow {
  readonly tier: AwardTier;
  readonly label: string;
  readonly earned: boolean;
  readonly reason?: string;
  readonly awardedAt?: string;
  readonly reference?: string;
  readonly awardedBy?: string | null;
  readonly humanAssessed?: boolean;
  readonly headline?: string;
  readonly hasCertificate?: boolean;
  readonly exports?: AwardExports;
}

export interface AwardRowView {
  readonly tier: AwardTier;
  readonly label: string;
  readonly earned: boolean;
  /** What happened, after the tier's name. Empty on an unearned row. */
  readonly description: string;
  /** Bronze is held by the hiring team and never issued to the candidate. */
  readonly internal: boolean;
  /** Why the badge is not there yet. Empty on an earned row. */
  readonly reason: string;
  readonly awardedAt: string | null;
  readonly reference: string;
  /** Paths for `api.download`, which prefixes /api itself. Null where there is nothing to export. */
  readonly badgePath: string | null;
  readonly certificatePath: string | null;
  readonly fileStem: string;
}

/**
 * `api.download` prefixes /api, and the server states the agreed paths in
 * full, as the contract writes them. Stripping it once here beats each caller
 * remembering — a path sent through with its prefix asks for /api/api/… and
 * fails as a 404 that reads like a missing endpoint.
 */
function apiRelative(path: string): string {
  return path.startsWith('/api/') ? path.slice(4) : path;
}

const TIER_ORDER: readonly AwardTier[] = ['bronze', 'silver', 'gold', 'diamond'];

export function awardRows(rows: readonly AwardResponseRow[], candidateName: string): AwardRowView[] {
  const stem = candidateName.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'candidate';
  return [...rows]
    .sort((a, b) => TIER_ORDER.indexOf(a.tier) - TIER_ORDER.indexOf(b.tier))
    .map((row) => ({
      tier: row.tier,
      label: row.label,
      earned: row.earned,
      description: row.earned ? row.headline ?? '' : '',
      internal: row.tier === 'bronze',
      reason: row.earned ? '' : row.reason ?? '',
      awardedAt: row.earned ? row.awardedAt ?? null : null,
      reference: row.earned ? row.reference ?? '' : '',
      // An unearned tier has no export, and the row must not offer one: the
      // badge is struck at the moment of promotion, so there is no file to
      // render and a button here would ask the server for a certificate for
      // something that has not happened.
      badgePath: row.earned && row.exports ? apiRelative(row.exports.badgeSvg) : null,
      certificatePath: row.earned && row.exports?.certificatePdf ? apiRelative(row.exports.certificatePdf) : null,
      fileStem: `${stem}-${row.tier}`,
    }));
}
