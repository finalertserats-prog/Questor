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
import { storedArtifactContent } from './artifactContent.js';
import type { NormalizedProfile, RoleSuccessProfile } from '../domain/types.js';
import type { TechStackItem } from '../domain/techStack.js';
import type { CvFacts } from '../domain/cvFacts.js';

/**
 * How to ask for a candidate's current profile.
 *
 * Version first, because that is what it means; `createdAt` second, because
 * version alone is not unique on rows written before the counter was fixed.
 * Exported and shared so the eight places that read "the latest profile"
 * cannot answer differently from one another — `candidateReuse.ts` had already
 * discovered the tie and ordered by `createdAt` locally, and one call site
 * knowing something the other seven did not is how this stayed invisible.
 */
export const LATEST_PROFILE = [
  { version: 'desc' },
  { createdAt: 'desc' },
] as const satisfies Prisma.CandidateProfileVersionOrderByWithRelationInput[];

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
  /**
   * Whether a person had approved that scorecard.
   *
   * `scorecardForFit` falls through to the newest draft when a role has never
   * been approved, and the resulting reading is a guess about a guess. It is
   * carried here so the stored fit can say so in a field rather than in a
   * docstring — see services/scorecards.ts for what a provisional reading is
   * and is not allowed to do.
   */
  readonly scorecardStatus: 'approved' | 'draft' | null;
}

export async function resumeScoringFor(roleId: string | null): Promise<ResumeScoring> {
  const scorecard = await scorecardForFit(roleId);
  const role = scorecard ? parseJsonStrict<RoleSuccessProfile>(scorecard.profileJson, { model: 'RoleScorecardVersion', id: scorecard.id, field: 'profileJson' }) : emptyProfile();
  const roleRow = roleId ? await prisma.role.findUnique({ where: { id: roleId }, select: { id: true, techStackJson: true } }) : null;
  return {
    role,
    techStack: roleRow ? roleTechStack(roleRow) : [],
    scorecardVersion: scorecard?.version ?? null,
    // Anything that is not the string "approved" is a draft as far as a reader
    // of the score is concerned. Defaulting the unknown case to 'draft' is the
    // safe direction: the cost of a wrongly-provisional label is a caveat on a
    // screen, and the cost of a wrongly-approved one is a candidate ranked on a
    // reading nobody checked.
    scorecardStatus: scorecard ? (scorecard.status === 'approved' ? 'approved' : 'draft') : null,
  };
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
  // The elements too, not just the arrays. `lines: [{}]` satisfies every check
  // above and then takes the request down on `line.text.toLowerCase()`, which
  // is the first thing the scorer does with each one.
  if (!parsed.lines!.every(isReadableLine)) return null;
  if (!parsed.technologies!.every((t) => typeof t?.name === 'string' && Array.isArray(t.evidence) && t.evidence.every(isEvidence))) return null;
  if (!parsed.roles!.every((r) => typeof r?.title === 'string' && isEvidence(r.evidence) && Array.isArray(r.bullets) && r.bullets.every(isEvidence))) return null;
  if (!parsed.scope!.every((s) => typeof s?.value === 'string' && isEvidence(s.evidence))) return null;
  return { ...(parsed as CvFacts), source: parsed.source === 'model_assisted' ? 'model_assisted' : 'deterministic' };
}

function isReadableLine(line: unknown): boolean {
  const l = line as { index?: unknown; text?: unknown; section?: unknown };
  return typeof l?.text === 'string' && typeof l.index === 'number' && typeof l.section === 'string';
}

function isEvidence(value: unknown): boolean {
  const e = value as { line?: unknown; quote?: unknown; section?: unknown };
  return typeof e?.quote === 'string' && typeof e.line === 'number' && typeof e.section === 'string';
}

export interface StoreResumeInput {
  readonly tenantId: string;
  readonly candidateId: string;
  readonly rawText: string;
  readonly filename: string;
  readonly contentType: string;
  readonly scoring: ResumeScoring;
  /**
   * The CV already read into facts, by `cvFactsFor`, BEFORE the caller opened
   * its transaction.
   *
   * It is a parameter rather than something this function works out, because
   * reading a CV can involve a model call with an eight-second budget, and
   * doing that with a write transaction open holds a connection — and, on
   * Postgres, row locks — for the whole of it. Every caller already does its
   * slow reads before the transaction; this is one of them.
   */
  readonly facts: CvFacts;
}

export function storeResumeProfile(db: Prisma.TransactionClient, o: StoreResumeInput) {
  return writeResumeProfile(db, o);
}

async function writeResumeProfile(db: Prisma.TransactionClient, o: StoreResumeInput) {
  const profile: NormalizedProfile = normalizeProfile(o.rawText);
  const facts = o.facts;
  const { fit } = scoreFit(facts, o.scoring.role, o.scoring.techStack, {
    scorecardVersion: o.scoring.scorecardVersion,
    scorecardStatus: o.scoring.scorecardStatus,
  });

  // `count(*) + 1` gave every row the same number whenever one was ever removed
  // or two were written close together, and production carries three profiles
  // for one candidate all numbered 1. Every reader asks for the highest
  // version, so a tie made "the current profile" whichever row the database
  // felt like returning — the same request answering differently on different
  // days, on a real person's record.
  const highest = await db.candidateProfileVersion.aggregate({
    where: { candidateId: o.candidateId },
    _max: { version: true },
  });
  const version = (highest._max.version ?? 0) + 1;
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

  // storageKey holds the CV text itself, not a key to it. Sealed where the
  // deployment has encryption on (services/artifactContent.ts); sizeBytes stays
  // the size of the content, not of the envelope around it.
  await db.artifact.create({ data: { tenantId: o.tenantId, candidateId: o.candidateId, kind: 'resume', filename: o.filename, contentType: o.contentType, storageKey: storedArtifactContent(o.rawText), sizeBytes: o.rawText.length, retentionDays: 180 } });
  return { profile, fit, profileVersionId: profileVersion.id, facts };
}

function emptyProfile(): RoleSuccessProfile {
  return { roleContext: '', outcomes: [], responsibilities: [], competencies: [], scoringRules: { mustPassCompetencyIds: [], notEnoughEvidencePolicy: 'exclude', passThreshold: 65 }, policyRules: { prohibitedTopics: [], requiredDisclosures: [], accommodationsEnabled: true, jurisdiction: '' }, redFlags: [], seniority: '' };
}
