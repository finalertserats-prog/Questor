/**
 * Band calibration — deciding what level to interview someone at, and telling
 * the rest of the engine about it.
 *
 * Before this existed, the only seniority signal in the whole pipeline was one
 * binary check in `roleIntelligence`: senior/lead/principal got `requiredLevel:
 * 3`, everyone else got `2`. Candidate `totalYears` was parsed off the resume
 * and then used for nothing but a trajectory bonus in fit scoring. It never
 * reached the planner, the director or a single prompt.
 *
 * A two-valued dial cannot express six bands, so the interview collapsed toward
 * the middle: a simulated sweep found entry-level candidates questioned a band
 * high and executives two bands low, both drifting inward. That is the shape a
 * missing signal makes.
 *
 * Two rules govern what follows.
 *
 * The CANDIDATE sets the level, not the requisition. A junior applying to a
 * senior req is still a junior, and interviewing them at the req's level is
 * exactly how a one-year engineer gets asked how they architected a system.
 * The role level is a fallback for when the resume says nothing usable.
 *
 * Years are a prior, never the verdict. Banding on years-since-graduation is an
 * age proxy and `age` is already a prohibited topic, so the band comes from
 * evidenced scope with years as the starting guess — see `inferBand`.
 */
import {
  BANDS,
  bandById,
  inferBand,
  type BandId,
  type ExperienceBand,
} from './experienceBands.js';
import type { NormalizedProfile } from '../domain/types.js';

/** Level words a real job description uses, longest and most specific first. */
const SENIORITY_PATTERNS: Array<{ re: RegExp; band: BandId }> = [
  { re: /\b(chief|c-level|cto|cio|ciso|vp|vice president|head of|director|executive|partner)\b/i, band: 'executive' },
  { re: /\b(principal|distinguished|fellow|architect|manager|group lead)\b/i, band: 'principal' },
  { re: /\b(lead|staff|tech lead|team lead)\b/i, band: 'senior' },
  { re: /\b(senior|sr\.?)\b/i, band: 'established' },
  { re: /\b(mid|intermediate|ii|2)\b/i, band: 'developing' },
  { re: /\b(junior|jr\.?|entry|graduate|associate|intern|trainee)\b/i, band: 'emerging' },
];

/**
 * The band a role's own level string implies.
 *
 * Falls back to `established` rather than to either extreme: an unparseable
 * level is missing information, and the least damaging place to stand when you
 * do not know is the middle of the scale.
 */
export function bandForRoleSeniority(seniority: string): ExperienceBand {
  const s = (seniority ?? '').trim();
  for (const { re, band } of SENIORITY_PATTERNS) {
    if (re.test(s)) return bandById(band);
  }
  return bandById('established');
}

export interface BandResolution {
  band: ExperienceBand;
  /** Which signal decided it, so a reviewer can audit why the pitch was chosen. */
  source: 'candidate' | 'role';
  confidence: number;
  rationale: string;
}

/**
 * Decide the band to interview this candidate at.
 *
 * Prefers the candidate's own evidence and falls back to the role only when
 * there is nothing to read — no years, no scope markers. The fallback is a real
 * case, not a defensive one: a one-page CV of bare job titles parses to almost
 * nothing, and pitching at the requisition beats pitching at zero.
 */
export function resolveCandidateBand(opts: {
  profile: NormalizedProfile;
  resumeText: string;
  roleSeniority: string;
}): BandResolution {
  const years = opts.profile?.totalYears;
  const text = opts.resumeText ?? '';
  const hasYears = typeof years === 'number' && Number.isFinite(years) && years > 0;
  const inferred = inferBand({ totalYears: years, evidenceText: text });

  // Nothing to read: no tenure figure and no scope language at all.
  if (!hasYears && inferred.movedBy === 0 && text.trim().length < 40) {
    const band = bandForRoleSeniority(opts.roleSeniority);
    return {
      band,
      source: 'role',
      confidence: 0.3,
      rationale: `The resume gave no usable tenure or scope evidence, so the interview is pitched at the role's own level (${band.label}). This should be revised from what the candidate evidences in the conversation.`,
    };
  }

  return {
    band: inferred.band,
    source: 'candidate',
    confidence: inferred.confidence,
    rationale: inferred.reason,
  };
}

/**
 * The band, rendered for a prompt.
 *
 * One string rather than a structured object because every consumer is
 * ultimately pasting it into an LLM prompt or a plan block, and a shape that
 * each caller formats differently is a shape that drifts between callers.
 */
export function bandGuidanceFor(bandId: BandId): string {
  const b = bandById(bandId);
  return [
    `CANDIDATE LEVEL: ${b.label}. Their work sits at the ${b.abstraction} level.`,
    `Ask about: ${b.askAbout.join('; ')}.`,
    `Do NOT ask about: ${b.avoid.join('; ')}. These are wrong for this level — unanswerable for someone who has never had the scope, or insulting to someone who has long outgrown them.`,
    `A complete answer here looks like: ${b.evidenceBar}`,
  ].join('\n');
}

/**
 * Question shapes that presume a level of ownership, and the lowest band that
 * can plausibly answer them.
 *
 * Matched on the template text rather than a tag on the template, so a question
 * the LLM produces can be screened by the same rule as one from the static
 * bank — and the LLM is where the real miscalibration came from.
 */
const TEMPLATE_FLOORS: Array<{ re: RegExp; minBand: BandId; why: string }> = [
  {
    // The question that started this: asked of a one-year junior in the first
    // simulated interview ever run.
    re: /\binherited a .{0,40}(setup|system|platform|codebase)\b|\byou didn'?t build and nobody documented\b/i,
    minBand: 'established',
    why: 'presumes ownership of a system the candidate did not build',
  },
  {
    re: /\bacross (multiple|several|\w+) teams\b|\borg[- ]wide\b|\bcompany[- ]wide\b/i,
    minBand: 'senior',
    why: 'presumes influence beyond a single team',
  },
  {
    re: /\bbuild[- ]versus[- ]buy\b|\bcapital allocation\b|\bheadcount\b|\bp&l\b|\bportfolio\b/i,
    minBand: 'principal',
    why: 'presumes budget or organisational authority',
  },
  {
    re: /\bat ten times that scale\b|\bwhat would you have had to do differently from day one\b/i,
    minBand: 'established',
    why: 'presumes the candidate has operated something at scale',
  },
];

const BAND_ORDER = new Map<BandId, number>(BANDS.map((b, i) => [b.id, i]));

/**
 * Is this question fair to ask someone at this band?
 *
 * Only ever rules questions OUT for being too senior. There is deliberately no
 * ceiling rule: a basic question asked of an executive is a waste of a turn but
 * it is answerable, whereas a question that presumes authority the candidate
 * has never held cannot be answered honestly at all. The costs are not
 * symmetric, so the guard is not either.
 */
export function templateAllowedForBand(text: string, bandId: BandId): boolean {
  const idx = BAND_ORDER.get(bandId) ?? 0;
  for (const rule of TEMPLATE_FLOORS) {
    if (rule.re.test(text) && idx < (BAND_ORDER.get(rule.minBand) ?? 0)) return false;
  }
  return true;
}

/** Why a question was blocked, for the audit trail. */
export function templateBlockReason(text: string, bandId: BandId): string | null {
  const idx = BAND_ORDER.get(bandId) ?? 0;
  for (const rule of TEMPLATE_FLOORS) {
    if (rule.re.test(text) && idx < (BAND_ORDER.get(rule.minBand) ?? 0)) return rule.why;
  }
  return null;
}
