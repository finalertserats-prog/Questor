import type { Prisma } from '@prisma/client';
import { prisma, parseJsonStrict } from '../db.js';
import { normalizeProfile } from '../engines/resumeParser.js';
import { computeFitScore } from '../engines/fitScoring.js';
import { scorecardForFit } from './scorecards.js';
import { roleTechStack } from './roleTechStack.js';
import type { NormalizedProfile, RoleSuccessProfile } from '../domain/types.js';
import type { TechStackItem } from '../domain/techStack.js';

/**
 * The resume pipeline behind POST /candidates/:id/resume, shared with applying
 * an existing person to another role: parse the text, score it against the
 * role, store a new profile version with its evidence graph and the resume
 * record.
 *
 * Split in two so the writes can run inside a caller's transaction. The reads
 * that pick the scorecard happen first, on the shared client; the writes take
 * whichever client they are given.
 */

export interface ResumeScoring {
  readonly role: RoleSuccessProfile;
  readonly techStack: readonly TechStackItem[];
}

export async function resumeScoringFor(roleId: string | null): Promise<ResumeScoring> {
  const scorecard = await scorecardForFit(roleId);
  const role = scorecard ? parseJsonStrict<RoleSuccessProfile>(scorecard.profileJson, { model: 'RoleScorecardVersion', id: scorecard.id, field: 'profileJson' }) : emptyProfile();
  const roleRow = roleId ? await prisma.role.findUnique({ where: { id: roleId }, select: { id: true, techStackJson: true } }) : null;
  return { role, techStack: roleRow ? roleTechStack(roleRow) : [] };
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
  const { fit, perCompetency } = computeFitScore(profile, o.rawText, o.scoring.role, o.scoring.techStack);

  const version = (await db.candidateProfileVersion.count({ where: { candidateId: o.candidateId } })) + 1;
  const profileVersion = await db.candidateProfileVersion.create({
    data: { candidateId: o.candidateId, version, rawText: o.rawText, profileJson: JSON.stringify(profile), fitScoreJson: JSON.stringify(fit) },
  });

  // Evidence graph nodes/edges
  for (const pc of perCompetency) {
    const compNode = await db.evidenceNode.create({ data: { profileId: profileVersion.id, kind: 'competency', label: pc.name, dataJson: JSON.stringify({ competencyId: pc.competencyId, strength: pc.strength }) } });
    for (const ev of pc.evidence) {
      const evNode = await db.evidenceNode.create({ data: { profileId: profileVersion.id, kind: 'evidence', label: ev.slice(0, 60), dataJson: JSON.stringify({ text: ev }) } });
      await db.evidenceEdge.create({ data: { fromId: evNode.id, toId: compNode.id, relation: pc.strength === 'missing' ? 'requires-validation' : 'supports', weight: 1 } });
    }
  }

  await db.artifact.create({ data: { tenantId: o.tenantId, candidateId: o.candidateId, kind: 'resume', filename: o.filename, contentType: o.contentType, storageKey: o.rawText, sizeBytes: o.rawText.length, retentionDays: 180 } });
  return { profile, fit, profileVersionId: profileVersion.id };
}

function emptyProfile(): RoleSuccessProfile {
  return { roleContext: '', outcomes: [], responsibilities: [], competencies: [], scoringRules: { mustPassCompetencyIds: [], notEnoughEvidencePolicy: 'exclude', passThreshold: 65 }, policyRules: { prohibitedTopics: [], requiredDisclosures: [], accommodationsEnabled: true, jurisdiction: '' }, redFlags: [], seniority: '' };
}
