import { prisma } from '../db.js';
import { logAudit } from './audit.js';
import { logger } from '../logger.js';
import { upgradeLegacyEvidence } from '../domain/candidateAwards.js';
import { parseAwardEvidence, parseStoredEvidence, type AwardEvidence } from './awardEvidence.js';

/**
 * Reading the evidence a certificate is drawn from, whichever version it was
 * written as.
 *
 * ---- Why anything has to happen here at all
 *
 * Every award in the database was struck as a version-1 record: the five
 * evidence rows, and nothing saying whose record they are. The renderer needs
 * a name, a role title and two signatures. So the choice for those awards was
 * between refusing them for ever, printing them without saying whose they are,
 * and filling the gaps — and the three gaps do not deserve the same answer.
 *
 * The name and the title are RESOLVED from the rows the award already points
 * at. The signatures are NOT reconstructed. `upgradeLegacyEvidence` in the
 * domain carries the argument for that split; the short of it is that
 * following a frozen pointer is not the same act as re-deriving a claim about
 * what happened.
 *
 * ---- Why it is written back rather than done on the way past
 *
 * Because a certificate that resolved its name on every render could print two
 * different names under one reference — export it, correct the spelling of the
 * candidate's name, export it again — which is precisely what freezing exists
 * to stop. Resolving once and storing the result means the first export fixes
 * the document and every later one reproduces it.
 *
 * It is therefore a write on the path of a GET, which is worth being uneasy
 * about. It is conditional on the exact bytes it read, so two exports racing
 * cannot both apply it; it is audited, so the reconstruction is attributable
 * rather than silent; and a failure to store it does not fail the export,
 * because a reader waiting for their certificate should not be told no over a
 * bookkeeping write. That last case is logged loudly, because until it lands
 * the document is not yet reproducible.
 */

/** The fields of a `CandidateAward` this needs. Narrow on purpose. */
export interface UpgradableAward {
  readonly id: string;
  readonly tenantId: string;
  readonly candidateId: string;
  readonly roleId: string;
  readonly tier: string;
  readonly reference: string;
  readonly evidenceJson: string;
}

export async function certificateEvidence(o: { readonly award: UpgradableAward }): Promise<AwardEvidence> {
  const stored = parseStoredEvidence(o.award.id, o.award.evidenceJson);
  if (stored.kind === 'current') return stored.evidence;

  const [candidate, role] = await Promise.all([
    prisma.candidate.findFirst({
      where: { id: o.award.candidateId, tenantId: o.award.tenantId },
      select: { fullName: true },
    }),
    prisma.role.findFirst({
      where: { id: o.award.roleId, tenantId: o.award.tenantId },
      select: { title: true },
    }),
  ]);

  const upgraded = upgradeLegacyEvidence({
    legacy: stored.legacy,
    // An absent row leaves the placeholder the writer uses for the same gap,
    // so the certificate says what is missing rather than failing to exist.
    candidateName: candidate?.fullName ?? '',
    roleTitle: role?.title ?? '',
  });
  const evidenceJson = JSON.stringify(upgraded);

  // Parsed with the same reader that serves every other certificate, before it
  // is stored and before it is drawn. An upgrade cannot put a record into the
  // database that the renderer would then refuse.
  const evidence = parseAwardEvidence(o.award.id, evidenceJson);

  await store(o, evidenceJson);
  return evidence;
}

async function store(o: { readonly award: UpgradableAward }, evidenceJson: string): Promise<void> {
  try {
    // Conditional on the bytes that were read. Two exports of the same award
    // arriving together both build the same record — nothing in the upgrade
    // depends on the clock — and exactly one of them writes it.
    const claimed = await prisma.candidateAward.updateMany({
      where: { id: o.award.id, tenantId: o.award.tenantId, evidenceJson: o.award.evidenceJson },
      data: { evidenceJson },
    });
    if (claimed.count === 0) return;

    await logAudit({
      tenantId: o.award.tenantId,
      // The system, not the person whose export happened to trigger it. They
      // pressed Certificate; they did not edit a record, and a trail saying
      // they did would be the wrong sentence about somebody in an audit log.
      // Their export is recorded beside this, under their own name, by the
      // route that made it.
      actorId: 'evidence-upgrade',
      actorType: 'system',
      action: 'candidate.award.evidence_upgraded',
      entityType: 'CandidateAward',
      entityId: o.award.id,
      // The tier and the reference, and never the name that was resolved. The
      // trail outlives the award — an erasure deletes the award and cannot
      // reach back through the audit log — so a name written here would be the
      // one copy of it that erasure could not take away.
      after: { tier: o.award.tier, reference: o.award.reference, from: 1, to: 2 },
    });
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err), awardId: o.award.id },
      'a version 1 award rendered but could not be upgraded; it will be reconstructed again on the next export, and two exports could disagree if the candidate is renamed in between',
    );
  }
}
