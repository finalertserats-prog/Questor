import { nanoid } from 'nanoid';
import type { Competency, Proficiency } from '../domain/types.js';
import { LEVEL_PHRASE, mentionsTechnology, type TechCategory, type TechLevel, type TechStackItem } from '../domain/techStack.js';
import { bandById, type BandId } from './experienceBands.js';
import { activeCompetencies } from '../domain/scorecardEdits.js';
import { COMPETENCY_MAX_COUNT } from '../domain/profileSchema.js';

/**
 * Technical competencies a role's tech stack implies.
 *
 * One per required technology the hire must at least work in; when the stack
 * is long, one per category instead, so a platform team's twelve tools do not
 * become twelve interview blocks. Each is graded twice over: the technology's
 * level sets how deep the hire must be in it, and the role's experience band
 * sets what "deep" looks like — usage and fundamentals for a junior, trade-
 * offs and debugging for a mid, architecture, scaling and mentoring for a
 * senior. Nothing here is added by itself: the role page shows these for HR
 * to confirm, and role creation seeds them where the JD says nothing better.
 */

export interface StackCompetencyProposal {
  readonly name: string;
  readonly definition: string;
  readonly category: 'technical';
  readonly classification: 'essential';
  readonly indicators: readonly string[];
  readonly requiredLevel: Proficiency;
  readonly targetLevel: Proficiency;
  /** The stack items this competency covers. */
  readonly technologies: readonly string[];
}

/** Above this many qualifying technologies, proposals group by category. */
export const GROUP_ABOVE = 5;

const QUALIFYING: ReadonlySet<TechLevel> = new Set<TechLevel>(['working', 'strong', 'expert']);

type Depth = 'junior' | 'mid' | 'senior';

/** What depth an experience band expects in a technology. */
export function depthForBand(band: BandId): Depth {
  if (band === 'emerging' || band === 'developing') return 'junior';
  if (band === 'established') return 'mid';
  return 'senior';
}

const DEPTH_INDICATORS: Record<Depth, (tech: string) => string[]> = {
  junior: (tech) => [
    `Describes how they have used ${tech} day to day on real work`,
    `Explains ${tech} fundamentals in their own words`,
    `Walks through a problem they fixed in ${tech} and how they found it`,
  ],
  mid: (tech) => [
    `Explains a trade-off they made with ${tech} and what they gave up`,
    `Describes debugging a production problem involving ${tech}`,
    `Shows ownership of a feature built with ${tech} from ambiguity to release`,
    `Knows where ${tech} fits poorly and what they used instead`,
  ],
  senior: (tech) => [
    `Describes how they architected or scaled a system built on ${tech}`,
    `Explains trade-offs made with ${tech} at team or platform level`,
    `Shows how they mentored others or set standards for ${tech}`,
    `Describes a production failure involving ${tech} and the change that followed`,
  ],
};

const BASE_LEVEL: Record<TechLevel, number> = { familiar: 1, working: 2, strong: 3, expert: 4 };
const BAND_SHIFT: Record<BandId, number> = { emerging: -1, developing: 0, established: 0, senior: 1, principal: 1, executive: 1 };

const clampLevel = (n: number): Proficiency => Math.max(1, Math.min(5, n)) as Proficiency;

export function requiredLevelFor(level: TechLevel, band: BandId): Proficiency {
  return clampLevel(BASE_LEVEL[level] + BAND_SHIFT[band]);
}

const LEVEL_ORDER: readonly TechLevel[] = ['familiar', 'working', 'strong', 'expert'];
const deepest = (items: readonly TechStackItem[]): TechLevel =>
  items.reduce<TechLevel>((top, t) => (LEVEL_ORDER.indexOf(t.level) > LEVEL_ORDER.indexOf(top) ? t.level : top), 'familiar');

const CATEGORY_NAME: Record<TechCategory, string> = {
  language: 'Programming languages',
  framework: 'Frameworks and libraries',
  platform: 'Platforms and infrastructure',
  data: 'Data and storage',
  tooling: 'Engineering tooling',
  other: 'Core technologies',
};

function proposal(name: string, items: readonly TechStackItem[], band: BandId): StackCompetencyProposal {
  const level = deepest(items);
  const depth = depthForBand(band);
  const named = items.map((t) => t.name).join(', ');
  const required = requiredLevelFor(level, band);
  const bandLabel = bandById(band).label.replace(/\s*\(.*\)$/, '').toLowerCase();
  const indicators = DEPTH_INDICATORS[depth](named);
  if (level === 'strong' || level === 'expert') {
    indicators.push(`Demonstrates depth beyond routine use of ${named}: internals, limits or performance`);
  }
  return {
    name,
    definition: `Builds and maintains production work with ${named} at ${LEVEL_PHRASE[level]}, as this ${bandLabel} role requires.`,
    category: 'technical',
    classification: 'essential',
    indicators,
    requiredLevel: required,
    targetLevel: clampLevel(required + 1),
    technologies: items.map((t) => t.name),
  };
}

/** The draft for one technology whatever its level or requirement, for HR naming it by hand. */
export function stackProposalFor(item: TechStackItem, band: BandId): StackCompetencyProposal {
  return proposal(item.name, [item], band);
}

/** Whether an active competency already names this technology. */
function covered(competencies: readonly Pick<Competency, 'name' | 'definition' | 'retired'>[], tech: string): boolean {
  return competencies.some((c) => c.retired !== true && mentionsTechnology(`${c.name} ${c.definition}`, tech));
}

export function proposeStackCompetencies(opts: {
  readonly techStack: readonly TechStackItem[];
  readonly band: BandId;
  readonly competencies?: readonly Pick<Competency, 'name' | 'definition' | 'retired'>[];
}): StackCompetencyProposal[] {
  const existing = opts.competencies ?? [];
  const qualifying = opts.techStack.filter((t) => t.required && QUALIFYING.has(t.level) && !covered(existing, t.name));
  if (!qualifying.length) return [];
  if (qualifying.length <= GROUP_ABOVE) return qualifying.map((t) => proposal(t.name, [t], opts.band));
  const groups = new Map<TechCategory, TechStackItem[]>();
  for (const t of qualifying) groups.set(t.category, [...(groups.get(t.category) ?? []), t]);
  return [...groups].map(([category, items]) => proposal(CATEGORY_NAME[category], items, opts.band));
}

/**
 * The proposals as scorecard competencies with no weight yet, for role
 * creation; the caller normalises weights with the rest of the draft. Skips
 * a name already on the scorecard and stops at the scorecard's limit.
 */
export function stackCompetencies(
  existing: readonly Competency[],
  techStack: readonly TechStackItem[],
  band: BandId,
): Competency[] {
  const names = new Set(activeCompetencies({ competencies: existing }).map((c) => c.name.toLowerCase()));
  const room = Math.max(0, COMPETENCY_MAX_COUNT - existing.length);
  return proposeStackCompetencies({ techStack, band, competencies: existing })
    .filter((p) => !names.has(p.name.toLowerCase()))
    .slice(0, room)
    .map((p) => ({
      id: nanoid(8),
      name: p.name,
      definition: p.definition,
      category: p.category,
      classification: p.classification,
      weight: 0,
      requiredLevel: p.requiredLevel,
      targetLevel: p.targetLevel,
      indicators: [...p.indicators],
      evidenceModes: ['technical_explanation', 'behavioral_example', 'work_sample'],
      sourceText: p.technologies.join(', '),
      confidence: 0.8,
    }));
}
