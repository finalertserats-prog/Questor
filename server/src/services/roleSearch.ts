import type { Prisma } from '@prisma/client';
import { prisma } from '../db.js';
import { roleScope } from './access.js';
import type { AuthClaims } from './auth.js';
import { ROLE_METRICS_ROW_LIMIT } from './roleMetrics.js';

/**
 * Free-text search for the roles page: the title, the job description
 * (Role.sourceText) and the latest scorecard's responsibilities and
 * competencies.
 *
 * Matched in application code, not SQL. Prisma's `mode: 'insensitive'` does not
 * exist on SQLite, and SQLite's LIKE folds ASCII only, so the same query would
 * answer differently in development and production. Matching on the parsed
 * profile also keeps JSON keys ("responsibilities") from matching every role.
 *
 * The scan reads the same scoped roles, in the same order and under the same
 * ceiling, as the metrics list it narrows — in batches, so a tenant with long
 * job descriptions never holds them all in memory at once.
 */

const BATCH_SIZE = 500;

interface ProfileText {
  readonly responsibilities: readonly string[];
  readonly competencies: readonly string[];
}

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];

function profileText(profileJson: string | undefined): ProfileText {
  if (!profileJson) return { responsibilities: [], competencies: [] };
  let profile: unknown;
  try {
    profile = JSON.parse(profileJson);
  } catch {
    // An unreadable scorecard cannot match on its content; the role can still
    // match on its title and job description. Reading it is reported elsewhere.
    return { responsibilities: [], competencies: [] };
  }
  if (!profile || typeof profile !== 'object') return { responsibilities: [], competencies: [] };
  const { responsibilities, competencies } = profile as { responsibilities?: unknown; competencies?: unknown };
  const competencyText = Array.isArray(competencies)
    ? competencies.flatMap((c) => (c && typeof c === 'object' ? strings([(c as { name?: unknown }).name, (c as { definition?: unknown }).definition]) : []))
    : [];
  return { responsibilities: strings(responsibilities), competencies: competencyText };
}

/** Case-folded for comparison; locale-independent so the server's locale never changes an answer. */
const fold = (text: string): string => text.normalize('NFKC').toLowerCase();

export function roleMatchesQuery(
  role: { readonly title: string; readonly sourceText: string; readonly profileJson?: string },
  query: string,
): boolean {
  const needle = fold(query.trim());
  if (!needle) return true;
  const profile = profileText(role.profileJson);
  return [role.title, role.sourceText, ...profile.responsibilities, ...profile.competencies]
    .some((text) => fold(text).includes(needle));
}

export async function findRoleIdsMatching(
  auth: AuthClaims,
  query: string,
  options: { readonly rowLimit?: number } = {},
): Promise<ReadonlySet<string>> {
  const rowLimit = options.rowLimit ?? ROLE_METRICS_ROW_LIMIT;
  const where = (await roleScope(auth)) as Prisma.RoleWhereInput;
  const matches = new Set<string>();
  let cursor: string | undefined;
  let scanned = 0;
  while (scanned < rowLimit) {
    const batch = await prisma.role.findMany({
      where,
      select: {
        id: true,
        title: true,
        sourceText: true,
        scorecards: { orderBy: { version: 'desc' }, take: 1, select: { profileJson: true } },
      },
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      take: Math.min(BATCH_SIZE, rowLimit - scanned),
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    for (const role of batch) {
      if (roleMatchesQuery({ title: role.title, sourceText: role.sourceText, profileJson: role.scorecards[0]?.profileJson }, query)) {
        matches.add(role.id);
      }
    }
    scanned += batch.length;
    if (batch.length < BATCH_SIZE) break;
    cursor = batch[batch.length - 1].id;
  }
  return matches;
}
