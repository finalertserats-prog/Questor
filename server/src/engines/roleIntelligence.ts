import { nanoid } from 'nanoid';
import type { Competency, RoleSuccessProfile } from '../domain/types.js';
import { generateJson } from '../providers/llm/index.js';

// Skill taxonomy: keyword -> canonical skill + category. Covers the knowledge-
// worker role families the MVP targets (BRD 4.2).
const TAXONOMY: Array<{ kw: RegExp; name: string; category: Competency['category'] }> = [
  { kw: /\b(sql|postgres|mysql|snowflake|bigquery|redshift)\b/i, name: 'SQL & Data Warehousing', category: 'technical' },
  { kw: /\b(python|pandas|numpy|airflow|dbt|spark|scala|etl|elt|pipeline)\b/i, name: 'Data Engineering & Pipelines', category: 'technical' },
  { kw: /\b(aws|azure|gcp|cloud|kubernetes|docker|terraform)\b/i, name: 'Cloud & Platform Architecture', category: 'technical' },
  { kw: /\b(java|typescript|javascript|node|react|golang|go |c\+\+|api|microservice)\b/i, name: 'Software Engineering', category: 'technical' },
  { kw: /\b(machine learning|ml|ai|model|tensorflow|pytorch|llm|nlp)\b/i, name: 'ML / AI Engineering', category: 'technical' },
  { kw: /\b(product|roadmap|backlog|user stor|prioriti|stakeholder)\b/i, name: 'Product Management', category: 'domain' },
  { kw: /\b(sales|pipeline|quota|crm|salesforce|prospect|closing deals)\b/i, name: 'Sales Execution', category: 'domain' },
  { kw: /\b(marketing|campaign|seo|content|brand|demand gen)\b/i, name: 'Marketing', category: 'domain' },
  { kw: /\b(finance|accounting|budget|forecast|p&l|gaap|financial model)\b/i, name: 'Finance & Analysis', category: 'domain' },
  { kw: /\b(security|compliance|governance|risk|audit|soc 2|iso 27001)\b/i, name: 'Security & Compliance', category: 'domain' },
  { kw: /\b(data model|dimensional|star schema|slowly changing|warehouse design)\b/i, name: 'Data Modeling', category: 'technical' },
  { kw: /\b(observability|monitoring|reliability|sla|slo|incident|on-call)\b/i, name: 'Reliability & Operations', category: 'technical' },
];

const BEHAVIORAL: Array<Omit<Competency, 'id' | 'weight' | 'sourceText' | 'confidence'>> = [
  {
    name: 'Communication', definition: 'Explains complex ideas clearly, listens actively and adapts to the audience.',
    category: 'communication', classification: 'essential', requiredLevel: 3, targetLevel: 4,
    indicators: ['Structures answers logically', 'Checks for understanding', 'Adapts detail to audience'],
    evidenceModes: ['behavioral_example', 'technical_explanation'],
  },
  {
    name: 'Problem Solving', definition: 'Breaks down ambiguous problems, reasons about trade-offs and validates solutions.',
    category: 'behavioral', classification: 'essential', requiredLevel: 3, targetLevel: 4,
    indicators: ['Decomposes the problem', 'Considers alternatives and trade-offs', 'Validates the outcome'],
    evidenceModes: ['behavioral_example', 'case'],
  },
  {
    name: 'Collaboration', definition: 'Works effectively across teams, handles disagreement and shares ownership.',
    category: 'behavioral', classification: 'essential', requiredLevel: 3, targetLevel: 4,
    indicators: ['Describes cross-functional work', 'Handles conflict constructively', 'Credits the team'],
    evidenceModes: ['behavioral_example'],
  },
  {
    name: 'Ownership & Impact', definition: 'Takes end-to-end ownership and drives measurable outcomes.',
    category: 'behavioral', classification: 'preferred', requiredLevel: 2, targetLevel: 4,
    indicators: ['Owns outcomes not just tasks', 'Quantifies impact', 'Follows through under pressure'],
    evidenceModes: ['behavioral_example'],
  },
];

const EXCLUSIONARY_TERMS: Array<{ re: RegExp; suggestion: string }> = [
  { re: /\b(young|energetic recent graduate|digital native)\b/i, suggestion: 'Avoid age-coded language; describe the skill instead.' },
  { re: /\b(rockstar|ninja|guru)\b/i, suggestion: 'Replace hype terms with concrete competencies.' },
  { re: /\b(native (english )?speaker)\b/i, suggestion: 'Use "professional working proficiency" if communication is job-essential.' },
  { re: /\b(he\/his|she\/her|manpower|chairman)\b/i, suggestion: 'Use gender-neutral language.' },
  { re: /\b(must be able to lift|physically fit)\b/i, suggestion: 'Only include bona fide physical requirements.' },
];

function detectField(text: string, labels: string[]): string {
  for (const label of labels) {
    const re = new RegExp(`${label}\\s*[:\\-]\\s*([^\\n]+)`, 'i');
    const m = text.match(re);
    if (m) return m[1].trim().slice(0, 120);
  }
  return '';
}

function extractLines(text: string, verbs: RegExp): string[] {
  return text
    .split(/\n|(?<=\.)\s+/)
    .map((l) => l.replace(/^[\-\*•\d.)\s]+/, '').trim())
    .filter((l) => l.length > 12 && l.length < 220 && verbs.test(l))
    .slice(0, 12);
}

function classify(name: string, text: string): Competency['classification'] {
  const idx = text.toLowerCase().indexOf(name.toLowerCase().split(' ')[0]);
  const window = idx >= 0 ? text.slice(Math.max(0, idx - 60), idx + 60).toLowerCase() : '';
  if (/\b(preferred|nice to have|bonus|plus|desirable)\b/.test(window)) return 'preferred';
  if (/\b(must|required|essential|strong|expert)\b/.test(window)) return 'essential';
  return 'essential';
}

export interface RoleExtraction {
  title: string;
  level: string;
  location: string;
  employmentType: string;
  profile: RoleSuccessProfile;
  jdWarnings: Array<{ term: string; suggestion: string }>;
}

/** Heuristic role extraction (always available). */
export function extractRoleHeuristic(sourceText: string, titleHint = ''): RoleExtraction {
  const text = sourceText.replace(/\r/g, '');
  const firstLine = text.split('\n').map((l) => l.trim()).find((l) => l.length > 0) ?? '';
  const title = titleHint || detectField(text, ['title', 'position', 'role']) || firstLine.slice(0, 80) || 'Untitled Role';
  const level = detectField(text, ['level', 'seniority', 'grade']) ||
    (/\b(senior|sr\.?|lead|principal|staff)\b/i.test(text) ? 'Senior' : /\bjunior|entry\b/i.test(text) ? 'Junior' : 'Mid');
  const location = detectField(text, ['location', 'based in', 'office']) || (/\bremote\b/i.test(text) ? 'Remote' : '');
  const employmentType = /\bpart-?time|contract|intern\b/i.test(text) ? (text.match(/part-?time|contract|intern/i)?.[0] ?? 'Full-time') : 'Full-time';

  const responsibilities = extractLines(text, /\b(build|design|develop|manage|own|lead|drive|deliver|create|maintain|collaborate|analyze|improve|implement|optimize|partner)\b/i);
  const outcomes = extractLines(text, /\b(deliver|improve|reduce|increase|grow|launch|scale|achieve|ensure|drive)\b/i).slice(0, 6);

  // Technical / domain competencies from taxonomy hits.
  const seen = new Map<string, Competency>();
  for (const t of TAXONOMY) {
    const m = text.match(t.kw);
    if (m && !seen.has(t.name)) {
      seen.set(t.name, {
        id: nanoid(8),
        name: t.name,
        definition: `Demonstrated, job-relevant capability in ${t.name.toLowerCase()}.`,
        category: t.category,
        classification: classify(t.name, text),
        weight: 0,
        requiredLevel: level.toLowerCase().includes('senior') || /lead|principal|staff/i.test(level) ? 3 : 2,
        targetLevel: 4,
        indicators: [`Explains real decisions involving ${t.name.toLowerCase()}`, 'Describes trade-offs and outcomes', 'Shows depth appropriate to level'],
        evidenceModes: ['technical_explanation', 'behavioral_example', 'work_sample'],
        sourceText: m[0],
        confidence: 0.7,
      });
    }
  }

  const behavioral: Competency[] = BEHAVIORAL.map((b) => ({ ...b, id: nanoid(8), weight: 0, confidence: 0.9 }));
  let competencies = [...seen.values(), ...behavioral];
  // Guarantee at least a couple technical/domain competencies for thin JDs.
  if (competencies.filter((c) => c.category === 'technical' || c.category === 'domain').length === 0) {
    competencies.unshift({
      id: nanoid(8), name: 'Role-Specific Expertise',
      definition: 'Core job-relevant knowledge and skills for this role.',
      category: 'domain', classification: 'essential', weight: 0, requiredLevel: 2, targetLevel: 4,
      indicators: ['Explains relevant real work', 'Shows depth for the level'],
      evidenceModes: ['behavioral_example', 'technical_explanation'], confidence: 0.5,
    });
  }
  competencies = normalizeWeights(competencies);

  const jdWarnings = EXCLUSIONARY_TERMS.filter((e) => e.re.test(text)).map((e) => ({
    term: text.match(e.re)?.[0] ?? '', suggestion: e.suggestion,
  }));

  const profile: RoleSuccessProfile = {
    roleContext: firstLine,
    outcomes: outcomes.length ? outcomes : ['Deliver on core role responsibilities to the expected standard.'],
    responsibilities: responsibilities.length ? responsibilities : ['Perform the core duties described in the job description.'],
    competencies,
    scoringRules: {
      mustPassCompetencyIds: competencies.filter((c) => c.classification === 'essential').slice(0, 3).map((c) => c.id),
      notEnoughEvidencePolicy: 'exclude',
      passThreshold: 65,
    },
    policyRules: {
      prohibitedTopics: ['age', 'religion', 'caste', 'marital status', 'nationality', 'health', 'political views'],
      requiredDisclosures: ['AI interviewer', 'recording/transcription (if enabled)', 'human review of results'],
      accommodationsEnabled: true,
      jurisdiction: 'IN',
    },
    redFlags: ['Unable to give any specific example', 'Contradicts resume claims without explanation'],
    seniority: level,
  };

  return { title, level, location, employmentType, profile, jdWarnings };
}

function normalizeWeights(competencies: Competency[]): Competency[] {
  const scored = competencies.filter((c) => c.classification !== 'non_scoring');
  const base = scored.map((c) => (c.classification === 'essential' ? 3 : c.classification === 'preferred' ? 1 : 0.5));
  const total = base.reduce((a, b) => a + b, 0) || 1;
  let i = 0;
  return competencies.map((c) => {
    if (c.classification === 'non_scoring') return { ...c, weight: 0 };
    const w = base[i++] / total;
    return { ...c, weight: Math.round(w * 1000) / 1000 };
  });
}

/** LLM-augmented extraction with heuristic fallback. */
export async function extractRole(sourceText: string, titleHint = ''): Promise<RoleExtraction> {
  const heuristic = extractRoleHeuristic(sourceText, titleHint);
  const llm = await generateJson<Partial<RoleSuccessProfile> & { title?: string }>({
    fn: 'role_parser',
    system:
      'You are Questor\'s role analyst. Convert a job description into a fair, job-related competency model. ' +
      'Never include protected traits. Output JSON with keys: outcomes[], responsibilities[], competencies[] ' +
      '(each: name, definition, category[technical|domain|behavioral|situational|communication], classification[essential|preferred|trainable], requiredLevel 1-5, targetLevel 1-5, indicators[]).',
    user: `JOB DESCRIPTION:\n${sourceText.slice(0, 6000)}`,
    validate: (raw: any) => {
      if (!raw || !Array.isArray(raw.competencies)) throw new Error('bad shape');
      return raw;
    },
  });
  if (!llm) return heuristic;

  // Merge LLM competencies, keeping deterministic ids/weights/policy.
  const merged: Competency[] = (llm.competencies as any[]).slice(0, 12).map((c) => ({
    id: nanoid(8),
    name: String(c.name).slice(0, 80),
    definition: String(c.definition ?? '').slice(0, 240),
    category: ['technical', 'domain', 'behavioral', 'situational', 'communication'].includes(c.category) ? c.category : 'domain',
    classification: ['essential', 'preferred', 'trainable', 'non_scoring'].includes(c.classification) ? c.classification : 'essential',
    weight: 0,
    requiredLevel: clampLevel(c.requiredLevel, 2),
    targetLevel: clampLevel(c.targetLevel, 4),
    indicators: Array.isArray(c.indicators) ? c.indicators.slice(0, 5).map(String) : [],
    evidenceModes: ['behavioral_example', 'technical_explanation'],
    confidence: 0.85,
  }));
  const competencies = normalizeWeights(merged.length >= 3 ? merged : heuristic.profile.competencies);
  return {
    ...heuristic,
    profile: {
      ...heuristic.profile,
      outcomes: Array.isArray(llm.outcomes) && llm.outcomes.length ? llm.outcomes.slice(0, 8).map(String) : heuristic.profile.outcomes,
      responsibilities: Array.isArray(llm.responsibilities) && llm.responsibilities.length ? llm.responsibilities.slice(0, 12).map(String) : heuristic.profile.responsibilities,
      competencies,
      scoringRules: {
        ...heuristic.profile.scoringRules,
        mustPassCompetencyIds: competencies.filter((c) => c.classification === 'essential').slice(0, 3).map((c) => c.id),
      },
    },
  };
}

function clampLevel(v: unknown, dflt: number): 0 | 1 | 2 | 3 | 4 | 5 {
  const n = Math.round(Number(v));
  if (Number.isNaN(n)) return dflt as any;
  return Math.max(1, Math.min(5, n)) as any;
}
