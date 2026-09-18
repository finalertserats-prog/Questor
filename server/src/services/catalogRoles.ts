import { prisma } from '../db.js';
import { normalizeTitle } from '../domain/catalogText.js';
import { logAudit } from './audit.js';
import type { AuthClaims } from './auth.js';

/**
 * Why a title may not go into the shared catalog, or null when it may. Every
 * organisation reads the catalog, so a title that carries an email address, a
 * link or a phone/requisition number would carry one company's details to all
 * of them.
 */
export function catalogTitleProblem(title: string): string | null {
  const t = title.trim();
  if (t.length < 2 || t.length > 120) return 'Title must be 2 to 120 characters.';
  if (/[\r\n]/.test(t)) return 'Title must be a single line.';
  if (!/\p{L}/u.test(t)) return 'Title must contain a letter.';
  if (/@|https?:\/\/|www\./i.test(t)) return 'Title must not contain contact details or links.';
  if (/\d{6,}/.test(t)) return 'Title must not contain requisition or phone numbers.';
  return null;
}

export interface CatalogRoleRef {
  readonly id: string;
  readonly title: string;
  readonly status: string;
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && (err as { readonly code?: string }).code === 'P2002';
}

/** The role in this domain whose title or alias matches, retired ones included. */
export async function findCatalogMatch(domainId: string, title: string): Promise<CatalogRoleRef | null> {
  const normalizedTitle = normalizeTitle(title);
  return prisma.catalogRole.findFirst({
    where: { domainId, OR: [{ normalizedTitle }, { aliases: { some: { normalizedAlias: normalizedTitle } } }] },
    select: { id: true, title: true, status: true },
  });
}

export type AddCatalogRoleResult =
  | { readonly kind: 'created'; readonly id: string }
  | { readonly kind: 'existing'; readonly role: CatalogRoleRef };

/**
 * Add a title to the shared catalog, or report the role it already matches.
 * Validation is the caller's job (catalogTitleProblem). Two organisations adding
 * the same title at once both end up with the one row: the loser of the unique
 * race is told about the winner.
 */
export async function addCatalogRole(opts: {
  readonly auth: AuthClaims;
  readonly domainId: string;
  readonly title: string;
  readonly familyId?: string;
  readonly techStack?: readonly string[];
}): Promise<AddCatalogRoleResult> {
  const existing = await findCatalogMatch(opts.domainId, opts.title);
  if (existing) return { kind: 'existing', role: existing };
  const title = opts.title.trim();
  try {
    const created = await prisma.catalogRole.create({
      data: {
        domainId: opts.domainId,
        familyId: opts.familyId,
        title,
        normalizedTitle: normalizeTitle(title),
        techStackJson: JSON.stringify(opts.techStack ?? []),
        source: 'org',
        createdByTenantId: opts.auth.tenantId,
        createdById: opts.auth.userId,
      },
      select: { id: true },
    });
    await logAudit({
      tenantId: opts.auth.tenantId, actorId: opts.auth.userId, actorType: 'user', action: 'catalog.role.created',
      entityType: 'CatalogRole', entityId: created.id, after: { title, domainId: opts.domainId },
    });
    return { kind: 'created', id: created.id };
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    const winner = await findCatalogMatch(opts.domainId, title);
    if (!winner) throw err;
    return { kind: 'existing', role: winner };
  }
}
