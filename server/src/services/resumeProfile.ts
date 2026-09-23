import type { Prisma } from '@prisma/client';
import { prisma, parseJsonOptional, parseJsonStrict } from '../db.js';
import { normalizeProfile } from '../engines/resumeParser.js';
import { scoreFit } from '../engines/fitScoring.js';
import { prepareCvForScoring } from '../engines/cvRedaction.js';
import { refineCvFacts } from '../engines/cvFactsLlm.js';
import { extractCvFacts, factsFromPreparedCv } from '../engines/cvFacts.js';
import { scorecardForFit } from './scorecards.js';
import { roleTechStack } from './roleTechStack.js';
import { logger } from '../logger.js';
import type { NormalizedProfile, RoleSuccessProfile } from '../domain/types.js';
import type { TechStackItem } from '../domain/techStack.js';
import type { CvFacts } from '../domain/cvFacts.js';

/**
 * The resume pipeline behind POST /candidates/:id/resume, shared with applying
 * an existing person to another role: read the CV into evidence-backed facts,
 * score those facts against the role, store a new profile version with its
 * evidence graph and the resume record.
 *
 * Split in two so the writes can run inside a caller's transaction. The reads
 * that pick the scorecard happen first, on the shared client; the writes take
 * whichever client they are given.
 */

export interface ResumeScoring {
  readonly role: RoleSuccessProfile;
  readonly techStack: readonly TechStackItem[];
  /** The scorecard version the fit was measured against; null when the role has none. */
  readonly scorecardVersion: number | null;
}

export async function resumeScoringFor(roleId: string | null): Promise<ResumeScoring> {
  const scorecard = await scorecardForFit(roleId);
  const role = scorecard ? parseJsonStrict<RoleSuccessProfile>(scorecard.profileJson, { model: 'RoleScorecardVersion', id: scorecard.id, field: 'profileJson' }) : emptyProfile();
  const roleRow = roleId ? await prisma.role.findUnique({ where: { id: roleId }, select: { id: true, techStackJson: true } }) : null;
  return { role, techStack: roleRow ? roleTechStack(roleRow) : [], scorecardVersion: scorecard?.version ?? null };
}

/**
 * The CV as facts. The configured provider sharpens a messy parse where it can,
 * and a provider that is off, slow or wrong leaves the deterministic parse
 * standing — which is why this never throws and never awaits without a bound.
 *
 * Called once, when a resume is stored. Every later read takes the stored facts
 * (`storedCvFacts`) rather than calling a model again on a page load.
 */
export async function cvFactsFor(rawText: string): Promise<CvFacts> {
  const prepared = prepareCvForScoring(rawText);
  try {
    return await refineCvFacts(prepared, rawText);
  } catch (err) {
    logger.warn({ err: String(err) }, 'CV fact refinement failed; using the deterministic parse');
    return factsFromPreparedCv(prepared, rawText);
  }
}

/**
 * The facts stored with a profile version, or a fresh deterministic parse for a
 * row written before they were stored. Never calls a model: this runs on a read.
 */
export function storedCvFacts(row: { readonly cvFactsJson?: string | null; readonly rawText?: string | null }): CvFacts {
  const raw = row.cvFactsJson ?? '';
  if (raw && raw !== '{}') {
    const parsed = parseJsonOptional<Partial<CvFacts> | null>(raw, null, { model: 'CandidateProfileVersion', id: '', field: 'cvFactsJson' });
    const complete = parsed && completeFacts(parsed);
    if (complete) return complete;
  }
  // A row written before facts were stored, or one whose stored facts are a
  // shape this version cannot read. Re-parsing is free and deterministic; the
  // alternative is a scorer reaching into an object that is missing an array
  // and taking the request down.
  return extractCvFacts(row.rawText ?? '');
}

/**
 * Every field the scorer reads, present and of the right kind, or nothing.
 *
 * A half-populated object is worse than none: `facts.technologies.map(...)` on
 * an absent array is a 500 on a page that was only ever going to show a panel.
 */
function completeFacts(parsed: Partial<CvFacts>): CvFacts | null {
  const arrays = ['roles', 'technologies', 'qualifications', 'scope', 'gaps', 'lines'] as const;
  if (!arrays.every((key) => Array.isArray(parsed[key]))) return null;
  if (!parsed.tenure || typeof parsed.tenure.roleCount !== 'number') return null;
  const redaction = parsed.redaction;
  if (!redaction || !Array.isArray(redaction.kinds) || !Array.isArray(redaction.injectionLines) || typeof redaction.linesRemoved !== 'number') return null;
  return { ...(parsed as CvFacts), source: parsed.source === 'model_assisted' ? 'model_assisted' : 'deterministic' };
}

export interface StoreResumeInput {
  readonly tenantId: string;
  readonly candidateId: string;
  readonly rawText: string;
  readonly filename: string;
  readonly contentType: string;
  readonly scoring: ResumeScoring;
}

export async function storeResumeProfile(db: Prisma.TransactionClient, o: StoreResumeInput) {
  const profile: NormalizedProfile = normalizeProfile(o.rawText);
  const facts = await cvFactsFor(o.rawText);
  const { fit } = scoreFit(facts, o.scoring.role, o.scoring.techStack, { scorecardVersion: o.scoring.scorecardVersion });

  const version = (await db.candidateProfileVersion.count({ where: { candidateId: o.candidateId } })) + 1;
  const profileVersion = await db.candidateProfileVersion.create({
    data: {
      candidateId: o.candidateId, version, rawText: o.rawText,
      profileJson: JSON.stringify(profile), fitScoreJson: JSON.stringify(fit),
      cvFactsJson: JSON.stringify(facts),
    },
  });

  // Evidence graph nodes/edges. One competency node each — the scorer used to
  // read a competency once per group it fell into, so a competency that was
  // both essential and technical was written to the graph twice.
  for (const pc of fit.competencies ?? []) {
    const compNode = await db.evidenceNode.create({
      data: {
        profileId: profileVersion.id, kind: 'competency', label: pc.name,
        dataJson: JSON.stringify({ competencyId: pc.competencyId, strength: pc.strength, mustHave: pc.mustHave, explanation: pc.explanation }),
      },
    });
    for (const ev of pc.evidence) {
      const evNode = await db.evidenceNode.create({
        data: {
          profileId: profileVersion.id, kind: 'evidence', label: ev.quote.slice(0, 60),
          // The line index is the provenance: an evidence node that cannot say
          // which line it came from cannot be checked by the person reading it.
          dataJson: JSON.stringify({ text: ev.quote, line: ev.line, section: ev.section }),
        },
      });
      await db.evidenceEdge.create({ data: { fromId: evNode.id, toId: compNode.id, relation: pc.strength === 'not_evidenced' ? 'requires-validation' : 'supports', weight: 1 } });
    }
  }

  await db.artifact.create({ data: { tenantId: o.tenantId, candidateId: o.candidateId, kind: 'resume', filename: o.filename, contentType: o.contentType, storageKey: o.rawText, sizeBytes: o.rawText.length, retentionDays: 180 } });
  return { profile, fit, profileVersionId: profileVersion.id, facts };
}

function emptyProfile(): RoleSuccessProfile {
  return { roleContext: '', outcomes: [], responsibilities: [], competencies: [], scoringRules: { mustPassCompetencyIds: [], notEnoughEvidencePolicy: 'exclude', passThreshold: 65 }, policyRules: { prohibitedTopics: [], requiredDisclosures: [], accommodationsEnabled: true, jurisdiction: '' }, redFlags: [], seniority: '' };
}
