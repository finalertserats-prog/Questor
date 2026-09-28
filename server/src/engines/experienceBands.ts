/**
 * Experience calibration bands.
 *
 * The brief asked for roughly eighteen year-ranges (0-2, 2+, 3, 3-5, 5+, 6-8,
 * 8-10, 10+, …). They overlap, so they cannot be buckets — and more importantly,
 * a new question per year is not what actually changes with experience. What
 * changes is the ABSTRACTION the question sits at: the craft itself, the system
 * around it, or the organisation around that. Six non-overlapping bands carry
 * that axis; anything finer is a distinction the questions cannot express.
 *
 * Years are a PRIOR, not the answer. Banding on years-since-graduation is an age
 * proxy, and `policyRules.prohibitedTopics` already lists `age` — so the band is
 * set by evidenced SCOPE (what the candidate has demonstrably owned) with years
 * as the starting guess. That is fairer, survives a career-changer, and is the
 * version we can defend if anyone asks how the decision was made.
 */

export type BandId = 'emerging' | 'developing' | 'established' | 'senior' | 'principal' | 'executive';

/** Where a question sits: the craft, the system around it, or the organisation. */
export type Abstraction = 'craft' | 'system' | 'organisation';

export interface ExperienceBand {
  id: BandId;
  label: string;
  /** Inclusive lower bound, exclusive upper. The prior, before evidence adjusts it. */
  yearsPrior: { min: number; max: number };
  abstraction: Abstraction;
  /** Legitimate subject matter at this band. */
  askAbout: string[];
  /**
   * Subject matter that makes the interview feel wrong at this band — asked of a
   * fresher it is unanswerable, asked of a veteran it is insulting. This list is
   * the whole reason the band exists.
   */
  avoid: string[];
  /** Which rung of the follow-up ladder this band opens on. */
  startTier: 1 | 2 | 3;
  /** What a complete answer looks like here. */
  evidenceBar: string;
}

export const BANDS: readonly ExperienceBand[] = [
  {
    id: 'emerging',
    label: 'Emerging (0–2 yrs)',
    yearsPrior: { min: 0, max: 2 },
    abstraction: 'craft',
    askAbout: [
      'something they built or fixed themselves, in detail',
      'how they debugged a problem they did not immediately understand',
      'what confused them at first and how they got unstuck',
      'how they learn a tool or codebase that is new to them',
      'how they respond to review feedback',
    ],
    avoid: [
      'how they architected a system',
      'core business strategy or commercial trade-offs',
      'leading, mentoring or hiring a team',
      'multi-team or org-wide decisions',
      'budget, headcount or vendor selection',
      'what they would do differently across a multi-year programme',
    ],
    startTier: 1,
    evidenceBar: 'One concrete thing they personally did, with the reasoning behind it and what they learned.',
  },
  {
    id: 'developing',
    label: 'Developing (2–5 yrs)',
    yearsPrior: { min: 2, max: 5 },
    abstraction: 'craft',
    askAbout: [
      'a feature they owned end to end, from ambiguity to production',
      'a production problem they diagnosed under time pressure',
      'a technical choice they made and what they gave up',
      'how they handle review disagreement with someone more senior',
      'where their work touched other people and how they coordinated',
    ],
    avoid: [
      'organisational design or headcount planning',
      'multi-team technical strategy',
      'P&L, budget ownership or vendor negotiation',
      'setting engineering standards for a whole company',
    ],
    startTier: 1,
    evidenceBar: 'End-to-end ownership of something real, with a decision they can defend and a measured outcome.',
  },
  {
    id: 'established',
    label: 'Established (5–8 yrs)',
    yearsPrior: { min: 5, max: 8 },
    abstraction: 'system',
    askAbout: [
      'a system they own, including how it fails',
      'a design trade-off where both options were defensible',
      'an incident they led the response to',
      'how they have raised the standard of work around them',
      'what they would rebuild now and why',
    ],
    avoid: [
      'syntax recall or language trivia',
      'textbook definitions',
      'single-function implementation detail',
      'tooling preference questions with no decision behind them',
    ],
    startTier: 2,
    evidenceBar: 'System-level reasoning: the failure modes, the trade-off they chose, and the evidence it worked.',
  },
  {
    id: 'senior',
    label: 'Senior / Lead (8–12 yrs)',
    yearsPrior: { min: 8, max: 12 },
    abstraction: 'system',
    askAbout: [
      'a design that spanned teams and how they got agreement',
      'technical direction they set and how they justified it',
      'influencing an outcome they had no authority over',
      'a call they got wrong at scale and what it cost',
      'how they develop the people around them',
    ],
    avoid: [
      'syntax recall or language trivia',
      'textbook definitions',
      'how to implement a single well-known function',
      'whether they have used a specific tool, with no decision attached',
    ],
    startTier: 2,
    evidenceBar: 'Cross-team impact with the reasoning, the resistance encountered, and what it produced.',
  },
  {
    id: 'principal',
    label: 'Principal / Manager (12–18 yrs)',
    yearsPrior: { min: 12, max: 18 },
    abstraction: 'organisation',
    askAbout: [
      'architecture spanning multiple systems and its long-horizon consequences',
      'a build-versus-buy or platform bet and how it was evaluated',
      'a practice they changed across an organisation and how it stuck',
      'how they choose what NOT to do',
      'a technically correct decision that failed organisationally',
    ],
    avoid: [
      'syntax recall or language trivia',
      'individual ticket-level execution',
      'textbook definitions',
      'tool familiarity checklists',
    ],
    startTier: 3,
    evidenceBar: 'Org-level consequence: the bet, the alternatives rejected, the second-order effects they anticipated.',
  },
  {
    id: 'executive',
    label: 'Executive / Distinguished (18+ yrs)',
    yearsPrior: { min: 18, max: Infinity },
    abstraction: 'organisation',
    askAbout: [
      'strategy across a portfolio rather than a single system',
      'building an organisation and what they got wrong doing it',
      'capital allocation and the bets they declined',
      'external stakeholders, regulators, board or customers at scale',
      'how they know when their own model of the business is out of date',
    ],
    avoid: [
      'syntax recall or language trivia',
      'implementation detail',
      'tool familiarity checklists',
      'anything that treats decades of judgement as a knowledge quiz',
    ],
    startTier: 3,
    evidenceBar: 'Strategic judgement under uncertainty, with the trade-off owned and the outcome faced honestly.',
  },
] as const;

const BY_ID = new Map<BandId, ExperienceBand>(BANDS.map((b) => [b.id, b]));

export function bandById(id: BandId): ExperienceBand {
  const b = BY_ID.get(id);
  if (!b) throw new Error(`Unknown band: ${id}`);
  return b;
}

/** The years prior on its own. Missing or nonsense input lands on the entry band. */
export function bandForYears(years: number | undefined | null): ExperienceBand {
  const y = typeof years === 'number' && Number.isFinite(years) && years > 0 ? years : 0;
  return BANDS.find((b) => y >= b.yearsPrior.min && y < b.yearsPrior.max) ?? BANDS[BANDS.length - 1];
}

/**
 * Scope markers, graded by the abstraction they evidence.
 *
 * Graded rather than absolute because "architected across three teams" means
 * something different on a four-year CV than on a twenty-year one. On the first
 * it is evidence of reach beyond the years; on the second it is simply the job.
 * So a marker promotes only when it evidences scope ABOVE the band's own
 * abstraction — otherwise every senior CV would inflate itself indefinitely.
 */
const ABSTRACTION_RANK: Record<Abstraction, number> = { craft: 0, system: 1, organisation: 2 };

/** Ownership of a system: above the craft, below the organisation. */
const SYSTEM_MARKERS: RegExp[] = [
  /\barchitect(ed|ure|ing)\b/i,
  /\bmentor(ed|ing) \d+/i,
  /\bled a team of\b/i,
  /\bowned the [\w\s]{0,30}(platform|system|service|pipeline)\b/i,
  /\bset the (technical |engineering )?(standard|direction)\b/i,
  /\bon-call\b/i,
  /\bincident (command|response|lead)\b/i,
  /\bhiring (loop|panel|committee)\b/i,
];

/** Ownership across an organisation rather than a system. */
const ORG_MARKERS: RegExp[] = [
  /\bp&l\b/i,
  /\bheadcount\b/i,
  // Plural only. "across the team" means WITHIN one team — the opposite of what
  // this marker is for — and matching it promoted an entry-level fixture.
  /\bacross [\w-]+ teams\b/i,
  /\borg[- ]wide\b/i,
  /\bcompany[- ]wide\b/i,
  /\bboard\b/i,
  /\bbudget of\b/i,
  /\bmulti-team\b/i,
  /\bportfolio\b/i,
  /\broadmap for the (org|company|business)\b/i,
  /\bset the (company |org )?strategy\b/i,
];

/** Markers of work that never rose above task level, whatever the tenure. */
const TASK_MARKERS: RegExp[] = [
  /\bassigned tickets\b/i,
  /\bunder supervision\b/i,
  /\bas directed\b/i,
  /\bassisted\b/i,
  /\bshadowed\b/i,
  /\bsupported the team\b/i,
  /\bhelped with\b/i,
];

function countMatches(text: string, patterns: RegExp[]): number {
  return patterns.filter((re) => re.test(text)).length;
}

/** The highest abstraction the text actually evidences, or null if it says nothing. */
function evidencedRank(text: string): number | null {
  if (countMatches(text, ORG_MARKERS) > 0) return ABSTRACTION_RANK.organisation;
  if (countMatches(text, SYSTEM_MARKERS) > 0) return ABSTRACTION_RANK.system;
  return null;
}

export interface BandInference {
  band: ExperienceBand;
  /** 0 = the years prior stood, +1 = evidence promoted, -1 = evidence demoted. */
  movedBy: -1 | 0 | 1;
  /** How much to trust this band. Evidence contradicting the prior lowers it. */
  confidence: number;
  reason: string;
}

/**
 * Band a candidate from evidenced scope, using years only as the starting guess.
 *
 * Evidence moves the band by at most one step in either direction. That cap is
 * deliberate: evidence should REFINE the prior, not override it. A resume that
 * name-drops "P&L" and "board" is not thereby an executive, and a modest
 * description of genuinely senior work should not collapse to entry level.
 */
export function inferBand(opts: { totalYears?: number | null; evidenceText?: string }): BandInference {
  const text = opts.evidenceText ?? '';
  const hasYears = typeof opts.totalYears === 'number' && Number.isFinite(opts.totalYears) && opts.totalYears > 0;
  const prior = bandForYears(opts.totalYears);
  const priorIdx = BANDS.indexOf(prior);

  const evidenced = evidencedRank(text);
  const priorRank = ABSTRACTION_RANK[prior.abstraction];
  const down = countMatches(text, TASK_MARKERS);

  // Promote only when the evidence sits ABOVE this band's own abstraction. A
  // principal who mentions P&L is describing the job, not exceeding it.
  const promotes = evidenced !== null && evidenced > priorRank;
  // Demotion needs a pattern, not a single modest verb — "assisted" appears in
  // plenty of CVs written by people who led the work.
  const demotes = !promotes && evidenced === null && down >= 2;

  let movedBy: -1 | 0 | 1 = 0;
  let idx = priorIdx;
  if (promotes && priorIdx < BANDS.length - 1) { idx = priorIdx + 1; movedBy = 1; }
  else if (demotes && priorIdx > 0) { idx = priorIdx - 1; movedBy = -1; }

  let confidence = hasYears ? 0.6 : 0.3;
  if (movedBy !== 0) confidence -= 0.2; // evidence and prior disagreed
  if (!text.trim()) confidence -= 0.1;
  confidence = Math.max(0.05, Math.min(0.95, confidence));

  const reason = movedBy === 1
    ? `Years suggested ${prior.id} (${prior.abstraction}-level); evidence reaches ${evidenced === 2 ? 'organisation' : 'system'} level, moving it up one band.`
    : movedBy === -1
      ? `Years suggested ${prior.id}; evidence describes task-level work only (${down} markers), moving it down one band.`
      : hasYears
        ? `Years prior of ${prior.id} stood; evidence neither exceeded nor contradicted it.`
        : 'No usable years figure; defaulted to the entry band pending evidence from the interview.';

  return { band: BANDS[idx], movedBy, confidence, reason };
}

/** Steps between two bands. The calibration metric the judge scores against. */
export function bandDistance(a: BandId, b: BandId): number {
  return Math.abs(BANDS.findIndex((x) => x.id === a) - BANDS.findIndex((x) => x.id === b));
}
