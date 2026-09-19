import type { Competency, FitScore, FitScoreComponent, NormalizedProfile, RoleSuccessProfile } from '../domain/types.js';

// Pre-interview fit scoring (BRD 7.2). Prioritizes demonstrated relevance and
// recency; deliberately ignores protected/irrelevant signals. Never a hidden
// binary decision — every component exposes its evidence and rule.

const EXCLUDED_SIGNALS = [
  'name', 'photograph', 'age', 'marital status', 'caste', 'religion', 'nationality',
  'home address', 'employment gaps', 'school prestige', 'accent/grammar artifacts',
];

function keywords(competency: Competency): string[] {
  return [competency.name, ...competency.name.split(/[\s/&]+/)]
    .map((w) => w.toLowerCase())
    .filter((w) => w.length > 2);
}

function evidenceFor(competency: Competency, text: string): string[] {
  const kws = keywords(competency);
  const sentences = text.split(/\n|(?<=\.)\s+/).map((s) => s.trim()).filter((s) => s.length > 15);
  const hits: string[] = [];
  for (const s of sentences) {
    const sl = s.toLowerCase();
    if (kws.some((k) => sl.includes(k))) {
      hits.push(s.slice(0, 180));
      if (hits.length >= 3) break;
    }
  }
  return hits;
}

function hasQuantifiedImpact(text: string): boolean {
  return /\b(\d+%|\$\d|\d+\s*(million|billion|k\b|crore|lakh)|reduced|increased|improved|grew|scaled|cut)\b/i.test(text);
}

export interface FitResult {
  fit: FitScore;
  perCompetency: Array<{ competencyId: string; name: string; evidence: string[]; strength: 'explicit' | 'inferred' | 'missing' }>;
}

export function computeFitScore(profile: NormalizedProfile, rawText: string, role: RoleSuccessProfile): FitResult {
  const text = rawText || JSON.stringify(profile);
  const essential = role.competencies.filter((c) => c.classification === 'essential');
  const technical = role.competencies.filter((c) => c.category === 'technical' || c.category === 'domain');
  const preferred = role.competencies.filter((c) => c.classification === 'preferred');

  const perCompetency: FitResult['perCompetency'] = [];
  const missing: string[] = [];
  const probes: string[] = [];

  function scoreGroup(group: Competency[]): { score: number; evidence: string[] } {
    if (group.length === 0) return { score: 50, evidence: [] };
    let sum = 0;
    const allEvidence: string[] = [];
    for (const c of group) {
      const ev = evidenceFor(c, text);
      const strength: 'explicit' | 'inferred' | 'missing' = ev.length >= 2 ? 'explicit' : ev.length === 1 ? 'inferred' : 'missing';
      perCompetency.push({ competencyId: c.id, name: c.name, evidence: ev, strength });
      if (strength === 'missing') {
        missing.push(c.name);
        probes.push(`Probe ${c.name}: ask for a concrete example demonstrating ${c.name.toLowerCase()}.`);
        sum += 25; // absence is uncertainty, not a penalty spiral
      } else if (strength === 'inferred') {
        sum += 60;
      } else {
        sum += 85;
      }
      allEvidence.push(...ev);
    }
    return { score: Math.round(sum / group.length), evidence: allEvidence.slice(0, 6) };
  }

  const essentialResult = scoreGroup(essential.length ? essential : role.competencies);
  const technicalResult = scoreGroup(technical);
  const preferredResult = scoreGroup(preferred);

  // Outcome similarity: overlap between role outcomes and resume achievements.
  const outcomeWords = new Set(role.outcomes.join(' ').toLowerCase().match(/[a-z]{4,}/g) ?? []);
  const resumeWords = new Set(text.toLowerCase().match(/[a-z]{4,}/g) ?? []);
  const overlap = [...outcomeWords].filter((w) => resumeWords.has(w)).length;
  const outcomeScore = Math.min(100, 40 + overlap * 4);

  // Career trajectory: distinct roles + seniority progression (non-linear not penalized).
  const roleCount = profile.employment.length;
  const trajectoryScore = Math.min(100, 45 + roleCount * 10 + (profile.totalYears ? Math.min(20, profile.totalYears * 2) : 0));

  // Evidence quality / specificity.
  const qualityScore = hasQuantifiedImpact(text) ? 82 : text.length > 800 ? 62 : 45;

  const components: FitScoreComponent[] = [
    { key: 'essential', label: 'Essential competency evidence', weight: 0.35, score: essentialResult.score, evidence: essentialResult.evidence, rule: 'Explicit role-relevant achievements mapped to essential competencies.' },
    { key: 'outcome', label: 'Outcome similarity', weight: 0.20, score: outcomeScore, evidence: [], rule: 'Overlap between role outcomes and demonstrated achievements.' },
    { key: 'technical', label: 'Technical/domain evidence', weight: 0.20, score: technicalResult.score, evidence: technicalResult.evidence, rule: 'Technologies and domain knowledge tied to demonstrated use.' },
    { key: 'trajectory', label: 'Career trajectory and scope', weight: 0.10, score: trajectoryScore, evidence: [], rule: 'Growth, ownership and level alignment; non-linear careers not auto-penalized.' },
    { key: 'preferred', label: 'Preferred qualifications', weight: 0.05, score: preferred.length ? preferredResult.score : 60, evidence: preferredResult.evidence, rule: 'Bonus signals, not hidden requirements.' },
    { key: 'quality', label: 'Evidence quality and specificity', weight: 0.10, score: qualityScore, evidence: [], rule: 'Quantified or contextual evidence; missing detail becomes an interview probe.' },
  ];

  const overall = Math.round(components.reduce((a, c) => a + c.score * c.weight, 0));
  // Confidence reflects how much evidence we actually found.
  const explicitCount = perCompetency.filter((p) => p.strength === 'explicit').length;
  const confidence = Math.max(0.3, Math.min(0.95, (explicitCount / Math.max(1, role.competencies.length)) * 0.9 + 0.25));

  return {
    fit: {
      overall,
      confidence: Math.round(confidence * 100) / 100,
      components,
      missing: Array.from(new Set(missing)).slice(0, 8),
      probes: Array.from(new Set(probes)).slice(0, 8),
      excludedSignals: EXCLUDED_SIGNALS,
    },
    perCompetency,
  };
}
