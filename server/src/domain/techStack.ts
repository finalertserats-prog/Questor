import { z } from 'zod';
import { cleanCompetencyText } from './scorecardEdits.js';

/**
 * The technologies a role is hired around: what they are, how deep the hire
 * needs to be in each, and whether the role can be done without them.
 *
 * Stored on Role.techStackJson. Older rows hold a bare list of names from the
 * catalog release; those read as required, working-level, uncategorised
 * entries so nothing written before this shape existed has to be migrated.
 *
 * Every name here is typed by HR and later put in front of a model — in the
 * interviewer's prompt, the grader's rubric and the competency drafts — so it
 * is cleaned to one line exactly as competency text is (cleanCompetencyText),
 * and every prompt that carries it declares it as employer configuration data.
 */

export const TECH_CATEGORIES = ['language', 'framework', 'platform', 'data', 'tooling', 'other'] as const;
export type TechCategory = (typeof TECH_CATEGORIES)[number];

export const TECH_LEVELS = ['familiar', 'working', 'strong', 'expert'] as const;
export type TechLevel = (typeof TECH_LEVELS)[number];

export interface TechStackItem {
  readonly name: string;
  readonly category: TechCategory;
  readonly level: TechLevel;
  readonly required: boolean;
}

export const TECH_STACK_MAX_ITEMS = 25;
export const TECH_NAME_MAX_LENGTH = 40;

const techName = z.string().trim().min(1).max(TECH_NAME_MAX_LENGTH).transform(cleanCompetencyText).refine((n) => n.length > 0, 'A technology needs a name.');

export const techStackItemSchema = z.object({
  name: techName,
  category: z.enum(TECH_CATEGORIES).default('other'),
  level: z.enum(TECH_LEVELS).default('working'),
  required: z.boolean().default(true),
}).strict();

/** A legacy name-only entry or a full item; both come out as items, duplicates dropped. */
export const techStackInputSchema = z.array(z.union([techName, techStackItemSchema]))
  .max(TECH_STACK_MAX_ITEMS, `A role lists at most ${TECH_STACK_MAX_ITEMS} technologies.`)
  .transform((items) => normaliseTechStack(items));

export function normaliseTechStack(items: ReadonlyArray<string | TechStackItem>): TechStackItem[] {
  const seen = new Set<string>();
  const out: TechStackItem[] = [];
  for (const raw of items) {
    const item: TechStackItem = typeof raw === 'string'
      ? { name: cleanCompetencyText(raw), category: knownTechnology(raw)?.category ?? 'other', level: 'working', required: true }
      : { ...raw, name: cleanCompetencyText(raw.name) };
    const key = item.name.toLowerCase();
    if (!item.name || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

/** The stored column as items. Throws on a shape no version of Questor ever wrote. */
export function techStackFromJson(raw: unknown): TechStackItem[] {
  return techStackInputSchema.parse(raw);
}

export const techStackNames = (stack: readonly TechStackItem[]): string[] => stack.map((t) => t.name);

// ---- Known technologies -----------------------------------------------------

export interface KnownTechnology {
  readonly name: string;
  readonly category: TechCategory;
  /** Other spellings a JD uses; matched like the name. */
  readonly aliases?: readonly string[];
}

/**
 * What the editor suggests and what a pasted JD is scanned for. Deliberately
 * the common names only: an unknown technology is still accepted by typing
 * it, this list just saves the typing and the categorising.
 */
export const TECHNOLOGIES: readonly KnownTechnology[] = [
  { name: 'TypeScript', category: 'language' }, { name: 'JavaScript', category: 'language', aliases: ['ES6', 'ECMAScript'] },
  { name: 'Python', category: 'language' }, { name: 'Java', category: 'language' }, { name: 'Kotlin', category: 'language' },
  { name: 'Go', category: 'language', aliases: ['Golang'] }, { name: 'Rust', category: 'language' }, { name: 'C#', category: 'language', aliases: ['C-Sharp'] },
  { name: 'C++', category: 'language' }, { name: 'C', category: 'language', aliases: [] }, { name: 'Ruby', category: 'language' },
  { name: 'PHP', category: 'language' }, { name: 'Swift', category: 'language' }, { name: 'Scala', category: 'language' },
  { name: 'SQL', category: 'language' }, { name: 'R', category: 'language', aliases: [] }, { name: 'Dart', category: 'language' },
  { name: 'React', category: 'framework', aliases: ['React.js', 'ReactJS'] }, { name: 'Angular', category: 'framework' },
  { name: 'Vue', category: 'framework', aliases: ['Vue.js', 'VueJS'] }, { name: 'Next.js', category: 'framework', aliases: ['NextJS'] },
  { name: 'Node.js', category: 'framework', aliases: ['Node', 'NodeJS'] }, { name: 'Express', category: 'framework', aliases: ['Express.js'] },
  { name: 'NestJS', category: 'framework', aliases: ['Nest.js'] }, { name: 'Django', category: 'framework' }, { name: 'Flask', category: 'framework' },
  { name: 'FastAPI', category: 'framework' }, { name: 'Spring', category: 'framework', aliases: ['Spring Boot'] }, { name: '.NET', category: 'framework', aliases: ['ASP.NET', 'dotnet'] },
  { name: 'Rails', category: 'framework', aliases: ['Ruby on Rails'] }, { name: 'Laravel', category: 'framework' }, { name: 'React Native', category: 'framework' },
  { name: 'Flutter', category: 'framework' }, { name: 'GraphQL', category: 'framework' }, { name: 'REST', category: 'framework', aliases: ['REST APIs', 'RESTful'] },
  { name: 'gRPC', category: 'framework' }, { name: 'TensorFlow', category: 'framework' }, { name: 'PyTorch', category: 'framework' },
  { name: 'Pandas', category: 'framework' }, { name: 'Spark', category: 'data', aliases: ['Apache Spark', 'PySpark'] },
  { name: 'AWS', category: 'platform', aliases: ['Amazon Web Services'] }, { name: 'Azure', category: 'platform', aliases: ['Microsoft Azure'] },
  { name: 'GCP', category: 'platform', aliases: ['Google Cloud'] }, { name: 'Kubernetes', category: 'platform', aliases: ['K8s'] },
  { name: 'Docker', category: 'platform' }, { name: 'Linux', category: 'platform' }, { name: 'Salesforce', category: 'platform' },
  { name: 'SAP', category: 'platform' }, { name: 'Snowflake', category: 'data' }, { name: 'Databricks', category: 'data' },
  { name: 'PostgreSQL', category: 'data', aliases: ['Postgres'] }, { name: 'MySQL', category: 'data' }, { name: 'SQL Server', category: 'data', aliases: ['MSSQL'] },
  { name: 'Oracle', category: 'data' }, { name: 'MongoDB', category: 'data', aliases: ['Mongo'] }, { name: 'Redis', category: 'data' },
  { name: 'Elasticsearch', category: 'data' }, { name: 'Kafka', category: 'data', aliases: ['Apache Kafka'] }, { name: 'BigQuery', category: 'data' },
  { name: 'Redshift', category: 'data' }, { name: 'Airflow', category: 'data', aliases: ['Apache Airflow'] }, { name: 'dbt', category: 'data' },
  { name: 'Terraform', category: 'tooling' }, { name: 'Ansible', category: 'tooling' }, { name: 'Git', category: 'tooling' },
  { name: 'GitHub Actions', category: 'tooling' }, { name: 'Jenkins', category: 'tooling' }, { name: 'GitLab CI', category: 'tooling' },
  { name: 'Jira', category: 'tooling' }, { name: 'Figma', category: 'tooling' }, { name: 'Tableau', category: 'tooling' },
  { name: 'Power BI', category: 'tooling', aliases: ['PowerBI'] }, { name: 'Excel', category: 'tooling' }, { name: 'Datadog', category: 'tooling' },
  { name: 'Grafana', category: 'tooling' }, { name: 'Prometheus', category: 'tooling' }, { name: 'Playwright', category: 'tooling' },
  { name: 'Cypress', category: 'tooling' }, { name: 'Jest', category: 'tooling' }, { name: 'Selenium', category: 'tooling' },
];

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * "React" in a sentence, not "reactive": a technology name is bounded by
 * characters that cannot continue an identifier. Letters, digits and the
 * symbols technology names end in (+ # .) count as continuing it, so "C" does
 * not match "C++" and "Go" does not match "Google".
 *
 * A hyphen continues one too, for short names only. It was left out, so "Go"
 * matched inside "go-to-market" and "go-live" — and on a marketing advert that
 * is not a stray word, it is most of the document. Short names alone, because
 * a hyphen genuinely separates for longer ones: "React-based" is React, and
 * "Python-first" is Python.
 */
export function technologyPattern(name: string): RegExp {
  const tail = name.length <= 3 ? '\\w+#\\-' : '\\w+#';
  return new RegExp(`(?<![\\w+#.${name.length <= 3 ? '\\-' : ''}])${escapeRegex(name)}(?![${tail}])`, 'i');
}

export function mentionsTechnology(text: string, name: string): boolean {
  return name.length > 0 && technologyPattern(name).test(text);
}

const byKey = new Map<string, KnownTechnology>();
for (const t of TECHNOLOGIES) {
  byKey.set(t.name.toLowerCase(), t);
  for (const alias of t.aliases ?? []) byKey.set(alias.toLowerCase(), t);
}

export function knownTechnology(name: string): KnownTechnology | undefined {
  return byKey.get(cleanCompetencyText(name).toLowerCase());
}

/** Single letters match too easily in prose ("C", "R"); only an explicit list-style mention counts. */
const SINGLE_LETTER = /^[A-Za-z]$/;
const SINGLE_LETTER_CONTEXT = (name: string) => new RegExp(`(?:^|[,;(/]|\\band\\b|\\bin\\b)\\s*${escapeRegex(name)}(?=\\s*(?:[,;)/]|\\band\\b|$))`, 'im');

/** The clause a mention sits in: from the previous line break, full stop or semicolon to the next. */
function clauseAround(text: string, at: number): string {
  const before = text.slice(0, at);
  const start = Math.max(before.lastIndexOf('\n'), before.lastIndexOf('.'), before.lastIndexOf(';')) + 1;
  const rest = text.slice(at);
  const stop = rest.search(/[\n.;]/);
  return text.slice(start, stop < 0 ? text.length : at + stop).toLowerCase();
}

function levelFromWindow(window: string): TechLevel {
  if (/\b(expert|deep|advanced|extensive|mastery)\b/.test(window)) return 'strong';
  if (/\b(familiar|familiarity|exposure|basic|awareness)\b/.test(window)) return 'familiar';
  return 'working';
}

const OPTIONAL_WINDOW = /\b(preferred|nice to have|bonus|a plus|plus|desirable|optional)\b/;

/**
 * The known technologies a job description names, read with the wording
 * around each in the same clause: "expert" raises the level, "nice to have"
 * makes it optional. A starting point for HR to confirm, never the record itself.
 */
export function detectTechStack(text: string): TechStackItem[] {
  const found: TechStackItem[] = [];
  for (const tech of TECHNOLOGIES) {
    const spellings = [tech.name, ...(tech.aliases ?? [])];
    let at = -1;
    for (const spelling of spellings) {
      const re = SINGLE_LETTER.test(spelling) ? SINGLE_LETTER_CONTEXT(spelling) : technologyPattern(spelling);
      const m = re.exec(text);
      if (m) { at = m.index; break; }
    }
    if (at < 0) continue;
    const window = clauseAround(text, at);
    found.push({ name: tech.name, category: tech.category, level: levelFromWindow(window), required: !OPTIONAL_WINDOW.test(window) });
    if (found.length >= TECH_STACK_MAX_ITEMS) break;
  }
  return found;
}

// ---- Prompt rendering --------------------------------------------------------

export const LEVEL_PHRASE: Record<TechLevel, string> = {
  familiar: 'familiarity',
  working: 'working knowledge',
  strong: 'strong experience',
  expert: 'expert level',
};

const PROMPT_MAX_ITEMS = 15;

/**
 * The stack as one bounded line for a prompt: names one-lined and capped,
 * required items first, the rest counted rather than listed. Callers wrap it
 * in the sentence that declares it employer configuration data.
 */
export function techStackPromptLine(stack: readonly TechStackItem[]): string {
  const ordered = [...stack].sort((a, b) => Number(b.required) - Number(a.required));
  const shown = ordered.slice(0, PROMPT_MAX_ITEMS).map((t) =>
    `${cleanCompetencyText(t.name).slice(0, TECH_NAME_MAX_LENGTH)} (${t.category}; ${t.required ? 'required' : 'nice to have'}; ${LEVEL_PHRASE[t.level]})`);
  const more = ordered.length - shown.length;
  return shown.join('; ') + (more > 0 ? `; and ${more} more` : '');
}

/** The required technologies a competency is about: named in its name, definition or indicators. */
export function stackItemsFor(
  competency: { readonly name: string; readonly definition?: string; readonly indicators?: readonly string[] },
  stack: readonly TechStackItem[],
): TechStackItem[] {
  const about = [competency.name, competency.definition ?? '', ...(competency.indicators ?? [])].join(' ');
  return stack.filter((t) => t.required && mentionsTechnology(about, t.name));
}
