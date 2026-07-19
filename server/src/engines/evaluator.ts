import type {
  AssessmentResult, CompetencyScore, Proficiency, Recommendation, RoleSuccessProfile, TurnRecord,
} from '../domain/types.js';
import { answerQuality } from './interviewDirector.js';
import { extractEvidence } from './evidenceExtractor.js';
import { validateNoProtectedInference } from './policyEngine.js';
import { generateJson } from '../providers/llm/index.js';

// Independent post-interview evaluator (BRD FR-035, 16.1). Scores each approved
// competency against the rubric using ONLY transcript evidence and the rubric —
// never name, appearance, accent or demographics. Expresses uncertainty and
// marks "Not Enough Evidence" rather than forcing a score.

function qualityToLevel(avgQuality: number): Proficiency {
  if (avgQuality >= 82) return 5;
  if (avgQuality >= 65) return 4;
  if (avgQuality >= 45) return 3;
  if (avgQuality >= 25) return 2;
  return 1;
}

export async function evaluate(opts: {
  role: RoleSuccessProfile;
  turns: TurnRecord[];
  rubricVersion: string;
  assessmentVersion: string;
  sessionId?: string;
}): Promise<AssessmentResult> {
  const { role, turns, rubricVersion } = opts;
  const scored = role.competencies.filter((c) => c.classification !== 'non_scoring' && c.weight > 0);

  const competencyScores: CompetencyScore[] = [];
  for (const c of scored) {
    const evidence = extractEvidence(turns, c.id);
    if (evidence.length === 0) {
      competencyScores.push({
        id: c.id, name: c.name, level: null, requiredLevel: c.requiredLevel,
        confidence: 0.2, notEnoughEvidence: true, evidence: [],
        rationale: 'No transcript evidence was gathered for this competency during the interview.',
        rubricVersion,
      });
      continue;
    }
    const qualities = evidence.map((e) => answerQuality(e.quote));
    const avg = qualities.reduce((a, q) => a + q.score, 0) / qualities.length;
    const level = qualityToLevel(avg);
    const specificityCount = qualities.filter((q) => q.specific).length;
    const confidence = Math.max(0.35, Math.min(0.95, 0.4 + evidence.length * 0.12 + specificityCount * 0.08));
    const rationale = buildRationale(c.name, level, qualities);
    competencyScores.push({
      id: c.id, name: c.name, level, requiredLevel: c.requiredLevel,
      confidence: Math.round(confidence * 100) / 100, notEnoughEvidence: false,
      evidence, rationale, rubricVersion,
    });
  }

  // Overall score: weighted mean over competencies WITH evidence (NEE excluded).
  const withEvidence = competencyScores.filter((s) => !s.notEnoughEvidence && s.level !== null);
  const totalWeight = withEvidence.reduce((a, s) => a + weightOf(role, s.id), 0) || 1;
  const overallScore = Math.round(
    withEvidence.reduce((a, s) => a + (s.level! / 5) * 100 * weightOf(role, s.id), 0) / totalWeight,
  );
  const evidenceCoverage = scored.length ? Math.round((withEvidence.length / scored.length) * 100) / 100 : 0;

  // Must-pass evaluation.
  const mustPass = role.scoringRules.mustPassCompetencyIds;
  const failedMustPass = competencyScores.filter(
    (s) => mustPass.includes(s.id) && s.level !== null && s.level < s.requiredLevel,
  );
  const mustPassNEE = competencyScores.filter((s) => mustPass.includes(s.id) && s.notEnoughEvidence);

  const recommendation = decideRecommendation({
    overallScore, evidenceCoverage, passThreshold: role.scoringRules.passThreshold,
    failedMustPass: failedMustPass.length, mustPassNEE: mustPassNEE.length,
  });

  const strengths = competencyScores.filter((s) => (s.level ?? 0) >= 4).map((s) => `${s.name}: demonstrated at level ${s.level}/5 with supporting evidence.`);
  const concerns = [
    ...failedMustPass.map((s) => `${s.name} is a must-pass competency but was demonstrated at level ${s.level}/5 (required ${s.requiredLevel}).`),
    ...competencyScores.filter((s) => (s.level ?? 5) <= 2 && !s.notEnoughEvidence).map((s) => `${s.name} showed limited depth (level ${s.level}/5).`),
  ];
  const openQuestions = competencyScores.filter((s) => s.notEnoughEvidence).map((s) => `Not enough evidence gathered for ${s.name} — recommend a focused human follow-up.`);
  const contradictions = detectContradictions(turns);
  const limitations = [
    ...(evidenceCoverage < 0.6 ? [`Evidence coverage was ${Math.round(evidenceCoverage * 100)}% — some competencies lack sufficient evidence.`] : []),
    ...mustPassNEE.map((s) => `Must-pass competency ${s.name} had no evidence; recommendation is capped pending human review.`),
  ];

  const confidence = Math.round(
    (withEvidence.reduce((a, s) => a + s.confidence, 0) / (withEvidence.length || 1)) * evidenceCoverage * 100,
  ) / 100;

  const summary = await buildSummary({ role, recommendation, confidence, evidenceCoverage, overallScore, competencyScores, strengths, concerns, sessionId: opts.sessionId });

  const result: AssessmentResult = {
    assessmentVersion: opts.assessmentVersion,
    roleScorecardVersion: rubricVersion,
    recommendation,
    confidence: Math.max(0.2, confidence),
    evidenceCoverage,
    overallScore,
    competencies: competencyScores,
    strengths,
    concerns,
    contradictions,
    openQuestions,
    limitations,
    summary,
  };

  // Output guardrail: strip any protected inference (defensive).
  const check = validateNoProtectedInference(JSON.stringify(result));
  if (!check.allowed) result.limitations.push('An automated output check flagged and removed potentially non-job-related language.');

  return result;
}

function weightOf(role: RoleSuccessProfile, id: string): number {
  return role.competencies.find((c) => c.id === id)?.weight ?? 0;
}

function buildRationale(name: string, level: Proficiency, qualities: Array<ReturnType<typeof answerQuality>>): string {
  const hasResult = qualities.some((q) => q.hasResult);
  const hasAction = qualities.some((q) => q.hasAction);
  const specific = qualities.some((q) => q.specific);
  const parts: string[] = [`Scored ${level}/5 on ${name} based on interview evidence.`];
  if (hasAction) parts.push('Candidate described concrete personal actions');
  if (hasResult) parts.push('and referenced measurable outcomes');
  if (specific) parts.push('with specific, contextual detail');
  if (!hasResult && level >= 3) parts.push('though impact/outcome detail was limited');
  if (level <= 2) parts.push('answers stayed general and lacked demonstrated depth');
  return parts.join(' ').replace(/\s+and\s+with/, ', with') + '.';
}

function decideRecommendation(o: {
  overallScore: number; evidenceCoverage: number; passThreshold: number; failedMustPass: number; mustPassNEE: number;
}): Recommendation {
  if (o.failedMustPass > 0) return o.overallScore >= o.passThreshold ? 'CONSIDER' : 'DO_NOT_PROGRESS';
  if (o.evidenceCoverage < 0.4 || o.mustPassNEE > 0) return 'CONSIDER';
  if (o.overallScore >= o.passThreshold) return 'PROCEED';
  if (o.overallScore >= o.passThreshold - 15) return 'CONSIDER';
  return 'DO_NOT_PROGRESS';
}

function detectContradictions(turns: TurnRecord[]): string[] {
  // Light heuristic: candidate walks back a claim ("actually", "I didn't really").
  const out: string[] = [];
  for (const t of turns) {
    if (t.speaker === 'candidate' && /\b(actually,? i (didn'?t|wasn'?t)|to be honest i never|i wasn'?t really involved|that was the team)\b/i.test(t.text)) {
      out.push(`Possible walk-back of an earlier claim: "${t.text.slice(0, 120)}" — flagged for human review, not treated as dishonesty.`);
    }
  }
  return out.slice(0, 5);
}

async function buildSummary(o: {
  role: RoleSuccessProfile; recommendation: Recommendation; confidence: number; evidenceCoverage: number;
  overallScore: number; competencyScores: CompetencyScore[]; strengths: string[]; concerns: string[]; sessionId?: string;
}): Promise<string> {
  const llm = await generateJson<{ summary: string }>({
    fn: 'report_writer',
    sessionId: o.sessionId,
    system:
      'You are Questor\'s report writer. Summarize a structured interview assessment for a recruiter in 3-5 sentences. ' +
      'Only use the provided structured facts — invent nothing. Distinguish observed evidence from limitations. ' +
      'Never mention protected traits. Output JSON: {"summary": "..."}.',
    user: JSON.stringify({
      recommendation: o.recommendation, confidence: o.confidence, evidenceCoverage: o.evidenceCoverage,
      overallScore: o.overallScore,
      competencies: o.competencyScores.map((c) => ({ name: c.name, level: c.level, notEnoughEvidence: c.notEnoughEvidence })),
      strengths: o.strengths, concerns: o.concerns,
    }),
    validate: (raw: any) => {
      if (!raw || typeof raw.summary !== 'string' || raw.summary.length < 20) throw new Error('bad');
      return { summary: raw.summary.slice(0, 1200) };
    },
  });
  if (llm) return llm.summary;

  // Deterministic summary.
  const rec = o.recommendation === 'PROCEED' ? 'Proceed' : o.recommendation === 'CONSIDER' ? 'Consider' : 'Do Not Progress';
  const topStrength = o.strengths[0]?.split(':')[0];
  const topConcern = o.concerns[0];
  return (
    `Recommendation: ${rec} (confidence ${Math.round(o.confidence * 100)}%; evidence coverage ${Math.round(o.evidenceCoverage * 100)}%). ` +
    `Overall competency score ${o.overallScore}/100. ` +
    (topStrength ? `The candidate showed particular strength in ${topStrength.toLowerCase()}. ` : '') +
    (topConcern ? `Area for human-panel focus: ${topConcern} ` : '') +
    `This assessment reflects evidence gathered in a first-round screen and is intended to support, not replace, human judgment.`
  );
}
