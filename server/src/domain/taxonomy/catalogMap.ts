import { CANONICAL_COMPETENCIES, competenciesForDomain } from './index.js';
import type { CanonicalRoleProfile, DomainTag } from './types.js';

/**
 * The bridge between the shared role catalog and the competency vocabulary.
 *
 * The catalog names 492 roles in 35 domains but says nothing about what any of
 * them requires. This file supplies the missing half: which domain a catalog
 * role sits in, and — for the role shapes that recur across every industry —
 * what a hiring manager would ordinarily expect to see on the scorecard.
 *
 * The point is not to overrule the advert. It is so that a *missing* essential
 * is as visible on screen as a spurious extra: a Senior Data Engineer JD that
 * never mentions SQL is far more likely to be a thin advert than a job that
 * genuinely does not need it, and the human should be told.
 */

/** Catalog domain name, exactly as `roleCatalog.ts` spells it, to its short tag. */
const DOMAIN_TAGS: ReadonlyArray<readonly [string, DomainTag]> = [
  ['Frontier AI, Applied AI & Forward Deployed Engineering', 'frontier_ai'],
  ['Machine Learning Platforms, AI Infrastructure & MLOps', 'ml_platform'],
  ['Data, Analytics & Decision Science', 'data'],
  ['Software Engineering & Architecture', 'software'],
  ['Cloud, Platform Engineering, DevOps & Reliability', 'cloud'],
  ['Cybersecurity, Privacy, Trust & Safety', 'security'],
  ['Product Management, Design & Digital Experience', 'product'],
  ['Semiconductors, Electronics & Embedded Systems', 'semiconductor'],
  ['Robotics, Autonomous Systems & Industrial Automation', 'robotics'],
  ['BFSI, FinTech, Payments, Risk & Insurance', 'bfsi'],
  ['Healthcare, Clinical & HealthTech', 'healthcare'],
  ['Life Sciences, Biotech, Pharma & Bioinformatics', 'life_sciences'],
  ['Sustainability, Climate, ESG & Renewable Energy', 'sustainability'],
  ['Energy, Utilities, Power & Oil and Gas', 'energy'],
  ['Manufacturing, Quality & Industry 4.0', 'manufacturing'],
  ['Supply Chain, Procurement, Logistics & Mobility', 'supply_chain'],
  ['Sales, Solutions, GTM & Revenue Operations', 'sales'],
  ['Customer Success, Services & Partnerships', 'customer_success'],
  ['Marketing, Brand, Growth & Communications', 'marketing'],
  ['Human Resources, Talent, People Analytics & Learning', 'hr'],
  ['Strategy, Consulting, Transformation & Business Operations', 'strategy'],
  ['Finance, Accounting, FP&A & Corporate Treasury', 'finance'],
  ['Legal, Compliance, Governance & Regulatory', 'legal'],
  ['Construction, Real Estate, Urban & Infrastructure', 'construction'],
  ['Aerospace, Aviation, Space & Defence', 'aerospace'],
  ['Automotive, EV & Mobility Technology', 'automotive'],
  ['Agriculture, Food Systems & AgriTech', 'agriculture'],
  ['Retail, E-commerce & Consumer', 'retail'],
  ['Travel, Hospitality, Food Service & Events', 'hospitality'],
  ['Education, Learning, Research & EdTech', 'education'],
  ['Public Sector, International Development & Social Impact', 'public_sector'],
  ['Media, Gaming, Creator Economy & Entertainment', 'media'],
  ['Science, Deep Tech, Quantum & Advanced R&D', 'science'],
  ['Skilled Trades, Field Service & Asset Maintenance', 'trades'],
  ['Customer Service, Shared Services & Enterprise Operations', 'customer_service'],
];

const BY_DOMAIN_NAME = new Map(DOMAIN_TAGS.map(([name, tag]) => [name.toLowerCase(), tag]));

export function domainTagFor(domainName: string | null | undefined): DomainTag | null {
  const name = (domainName ?? '').trim().toLowerCase();
  if (!name) return null;
  return BY_DOMAIN_NAME.get(name) ?? guessDomainTag(name);
}

/**
 * A domain the catalog does not name — an organisation's own, or a renamed one.
 * Matched on the distinctive words rather than the whole string, so "Data &
 * Analytics" still finds the data domain.
 */
function guessDomainTag(name: string): DomainTag | null {
  const guesses: ReadonlyArray<readonly [RegExp, DomainTag]> = [
    [/frontier|applied ai|forward deployed/, 'frontier_ai'],
    [/mlops|ai infra|ml platform/, 'ml_platform'],
    [/\bdata\b|analytics|decision science/, 'data'],
    [/software|architecture/, 'software'],
    [/cloud|devops|platform engineering|reliability/, 'cloud'],
    [/security|privacy|trust & safety/, 'security'],
    [/product|design|digital experience/, 'product'],
    [/semiconductor|electronics|embedded/, 'semiconductor'],
    [/robotic|autonomous|industrial automation/, 'robotics'],
    [/bfsi|fintech|payments|insurance|banking/, 'bfsi'],
    [/health ?care|clinical|healthtech/, 'healthcare'],
    [/life science|biotech|pharma|bioinformatics/, 'life_sciences'],
    [/sustainability|climate|\besg\b|renewable/, 'sustainability'],
    [/energy|utilities|oil and gas|power/, 'energy'],
    [/manufactur|industry 4/, 'manufacturing'],
    [/supply chain|procurement|logistics/, 'supply_chain'],
    [/sales|gtm|revenue operations/, 'sales'],
    [/customer success|partnerships/, 'customer_success'],
    [/marketing|brand|growth|communications/, 'marketing'],
    [/human resources|\bhr\b|talent|people analytics/, 'hr'],
    [/strategy|consulting|transformation|business operations/, 'strategy'],
    [/finance|accounting|fp&a|treasury/, 'finance'],
    [/legal|compliance|governance|regulatory/, 'legal'],
    [/construction|real estate|infrastructure|urban/, 'construction'],
    [/aerospace|aviation|space|defence|defense/, 'aerospace'],
    [/automotive|\bev\b|mobility/, 'automotive'],
    [/agriculture|food systems|agritech/, 'agriculture'],
    [/retail|e-?commerce|consumer/, 'retail'],
    [/travel|hospitality|food service|events/, 'hospitality'],
    [/education|learning|edtech/, 'education'],
    [/public sector|international development|social impact/, 'public_sector'],
    [/media|gaming|creator|entertainment/, 'media'],
    [/deep tech|quantum|advanced r&d|\bscience\b/, 'science'],
    [/skilled trades|field service|asset maintenance/, 'trades'],
    [/customer service|shared services|enterprise operations/, 'customer_service'],
  ];
  return guesses.find(([re]) => re.test(name))?.[1] ?? null;
}

/**
 * Role shapes that recur across the catalog, with what they usually ask for.
 *
 * `core` is the subset worth interrupting a person about. A Data Engineer
 * advert with no mention of pipelines is a JD problem, not a job that does not
 * need them; a Data Engineer advert with no mention of data modelling might
 * genuinely be a narrower job, so modelling is `usual` but not `core`.
 *
 * Order matters: the first title that matches wins, so the more specific
 * patterns come first.
 */
export const CANONICAL_ROLE_PROFILES: readonly CanonicalRoleProfile[] = [
  {
    id: 'data_engineer',
    title: /\b(data engineer|analytics engineer|etl developer|data platform engineer)\b/i,
    domains: ['data', 'ml_platform'],
    usual: ['sql & data warehousing', 'data engineering & pipelines', 'data modeling', 'cloud & platform architecture', 'reliability & operations', 'data governance & quality', 'software engineering'],
    core: ['sql & data warehousing', 'data engineering & pipelines'],
  },
  {
    id: 'data_scientist',
    title: /\b(data scientist|machine learning scientist|decision scientist|applied scientist)\b/i,
    domains: ['data', 'ml_platform', 'science'],
    usual: ['machine learning engineering', 'analytics & insight', 'sql & data warehousing', 'scientific research & experimentation', 'software engineering'],
    core: ['machine learning engineering'],
  },
  {
    id: 'ml_engineer',
    title: /\b(machine learning engineer|\bml engineer\b|mlops engineer|ai engineer)\b/i,
    domains: ['ml_platform', 'frontier_ai'],
    usual: ['machine learning engineering', 'mlops & model operations', 'software engineering', 'cloud & platform architecture', 'data engineering & pipelines'],
    core: ['machine learning engineering'],
  },
  {
    id: 'data_analyst',
    title: /\b(data analyst|business analyst|bi (developer|analyst)|insight analyst|reporting analyst)\b/i,
    domains: ['data', 'strategy'],
    usual: ['analytics & insight', 'sql & data warehousing', 'communication', 'data modeling', 'commercial acumen'],
    core: ['analytics & insight'],
  },
  {
    id: 'software_engineer',
    title: /\b(software (engineer|developer)|backend (engineer|developer)|full[- ]?stack|programmer|application developer)\b/i,
    domains: ['software', 'frontier_ai'],
    usual: ['software engineering', 'api & service design', 'testing & quality engineering', 'systems architecture', 'ci/cd & release engineering', 'cloud & platform architecture'],
    core: ['software engineering'],
  },
  {
    id: 'frontend_engineer',
    title: /\b(front[- ]?end (engineer|developer)|ui (engineer|developer)|web developer)\b/i,
    domains: ['software', 'product'],
    usual: ['frontend engineering', 'software engineering', 'testing & quality engineering', 'product & interaction design'],
    core: ['frontend engineering'],
  },
  {
    id: 'devops_engineer',
    title: /\b(devops|site reliability|\bsre\b|platform engineer|infrastructure engineer|cloud engineer)\b/i,
    domains: ['cloud'],
    usual: ['cloud & platform architecture', 'reliability & operations', 'ci/cd & release engineering', 'software engineering', 'security engineering', 'network engineering'],
    core: ['cloud & platform architecture', 'reliability & operations'],
  },
  {
    id: 'security_engineer',
    title: /\b(security (engineer|analyst|architect)|cyber ?security|penetration tester|soc analyst|appsec)\b/i,
    domains: ['security'],
    usual: ['security engineering', 'cloud & platform architecture', 'privacy & data protection', 'regulatory compliance', 'crisis & incident handling'],
    core: ['security engineering'],
  },
  {
    id: 'product_manager',
    title: /\b(product (manager|owner|lead)|\bpm\b|head of product|product director)\b/i,
    domains: ['product'],
    usual: ['product management', 'user research & discovery', 'analytics & insight', 'stakeholder & influence', 'prioritisation & judgement', 'commercial acumen'],
    core: ['product management'],
  },
  {
    id: 'designer',
    title: /\b(ux|ui|product designer|interaction designer|design lead|service designer)\b/i,
    domains: ['product', 'media'],
    usual: ['product & interaction design', 'user research & discovery', 'communication', 'collaboration'],
    core: ['product & interaction design'],
  },
  {
    id: 'project_manager',
    title: /\b(project manager|programme manager|program manager|delivery (manager|lead)|scrum master|agile coach)\b/i,
    domains: ['strategy', 'construction', 'public_sector'],
    usual: ['project & delivery management', 'stakeholder & influence', 'prioritisation & judgement', 'communication', 'people leadership'],
    core: ['project & delivery management'],
  },
  {
    id: 'account_executive',
    title: /\b(account executive|sales (manager|representative|director|executive)|business development)\b/i,
    domains: ['sales'],
    usual: ['sales execution', 'negotiation', 'commercial acumen', 'stakeholder & influence', 'customer success & retention'],
    core: ['sales execution'],
  },
  {
    id: 'customer_success_manager',
    title: /\b(customer success|account manager|client (partner|director)|relationship manager)\b/i,
    domains: ['customer_success'],
    usual: ['customer success & retention', 'stakeholder & influence', 'commercial acumen', 'communication'],
    core: ['customer success & retention'],
  },
  {
    id: 'marketing_manager',
    title: /\b(marketing (manager|lead|director)|growth (manager|lead)|demand generation|brand manager|content (manager|strategist))\b/i,
    domains: ['marketing'],
    usual: ['marketing & demand generation', 'brand & content', 'analytics & insight', 'commercial acumen'],
    core: ['marketing & demand generation'],
  },
  {
    id: 'finance_analyst',
    title: /\b(financial analyst|fp&a|finance (manager|business partner)|controller|management accountant)\b/i,
    domains: ['finance', 'bfsi'],
    usual: ['financial analysis & planning', 'accounting & controls', 'commercial acumen', 'stakeholder & influence', 'analytics & insight'],
    core: ['financial analysis & planning'],
  },
  {
    id: 'accountant',
    title: /\b(accountant|auditor|bookkeeper|tax (manager|specialist)|accounts (payable|receivable))\b/i,
    domains: ['finance'],
    usual: ['accounting & controls', 'regulatory compliance', 'financial analysis & planning'],
    core: ['accounting & controls'],
  },
  {
    id: 'risk_manager',
    title: /\b(risk (manager|analyst|officer)|credit (analyst|risk)|underwriter|actuar(y|ial)|compliance (officer|manager))\b/i,
    domains: ['bfsi', 'legal'],
    usual: ['risk & credit management', 'regulatory compliance', 'financial analysis & planning', 'analytics & insight'],
    core: ['risk & credit management'],
  },
  {
    id: 'lawyer',
    title: /\b(counsel|solicitor|lawyer|legal (manager|adviser|advisor)|paralegal|contract manager)\b/i,
    domains: ['legal'],
    usual: ['legal & contracting', 'regulatory compliance', 'negotiation', 'stakeholder & influence'],
    core: ['legal & contracting'],
  },
  {
    id: 'consultant',
    title: /\b(consultant|strategy (manager|analyst|associate)|transformation (lead|manager)|business operations)\b/i,
    domains: ['strategy'],
    usual: ['strategy & commercial analysis', 'stakeholder & influence', 'analytics & insight', 'project & delivery management', 'communication'],
    core: ['strategy & commercial analysis'],
  },
  {
    id: 'hr_manager',
    title: /\b(hr\b|human resources|people (partner|manager|operations)|talent (acquisition|manager)|recruiter|l&d)\b/i,
    domains: ['hr'],
    usual: ['talent & people management', 'stakeholder & influence', 'regulatory compliance', 'communication'],
    core: ['talent & people management'],
  },
  {
    id: 'supply_chain_manager',
    title: /\b(supply chain|logistics (manager|coordinator)|demand planner|procurement|buyer|sourcing manager|warehouse manager)\b/i,
    domains: ['supply_chain'],
    usual: ['supply chain & logistics', 'procurement & vendor management', 'operations management', 'analytics & insight', 'negotiation'],
    core: ['supply chain & logistics'],
  },
  {
    id: 'manufacturing_engineer',
    title: /\b(manufacturing engineer|production (engineer|manager|supervisor)|process engineer|industrial engineer|quality (engineer|manager))\b/i,
    domains: ['manufacturing', 'automotive', 'aerospace'],
    usual: ['manufacturing & process engineering', 'quality management', 'operations management', 'problem solving'],
    core: ['manufacturing & process engineering'],
  },
  {
    id: 'clinician',
    title: /\b(nurse|physician|doctor|clinician|clinical (specialist|manager|lead)|consultant (physician|surgeon)|therapist)\b/i,
    domains: ['healthcare'],
    usual: ['clinical & patient care', 'regulatory compliance', 'communication', 'crisis & incident handling'],
    core: ['clinical & patient care'],
  },
  {
    id: 'researcher',
    title: /\b(research (scientist|fellow|associate|engineer)|postdoc|principal investigator|scientist)\b/i,
    domains: ['science', 'life_sciences', 'frontier_ai'],
    usual: ['scientific research & experimentation', 'communication', 'problem solving'],
    core: ['scientific research & experimentation'],
  },
  {
    id: 'teacher',
    title: /\b(teacher|lecturer|instructor|tutor|trainer|professor|education (manager|lead))\b/i,
    domains: ['education'],
    usual: ['teaching & facilitation', 'communication', 'collaboration'],
    core: ['teaching & facilitation'],
  },
  {
    id: 'support_agent',
    title: /\b(customer (service|support) (agent|advisor|representative|manager)|service desk|help ?desk|technical support)\b/i,
    domains: ['customer_service'],
    usual: ['customer service delivery', 'communication', 'problem solving', 'prioritisation & judgement'],
    core: ['customer service delivery'],
  },
  {
    id: 'site_engineer',
    title: /\b(site (engineer|manager)|civil engineer|structural engineer|quantity surveyor|construction manager)\b/i,
    domains: ['construction'],
    usual: ['construction & project delivery', 'quality management', 'project & delivery management', 'stakeholder & influence'],
    core: ['construction & project delivery'],
  },
  {
    id: 'maintenance_technician',
    title: /\b(maintenance (technician|engineer)|field (service|engineer|technician)|electrician|fitter|mechanic)\b/i,
    domains: ['trades', 'energy', 'manufacturing'],
    usual: ['field service & maintenance', 'problem solving', 'quality management'],
    core: ['field service & maintenance'],
  },
];

/** What the catalog would expect of this role, if it recognises the shape at all. */
export function canonicalRoleProfileFor(title: string, tag: DomainTag | null): CanonicalRoleProfile | null {
  const candidates = CANONICAL_ROLE_PROFILES.filter((p) => p.title.test(title));
  if (candidates.length === 0) return null;
  // A title that matches more than one shape is settled by the role's domain,
  // so "Data Engineer" in the security domain does not borrow the data one.
  return (tag ? candidates.find((p) => p.domains.includes(tag)) : null) ?? candidates[0];
}

/**
 * What this JD asks for, set against what the canonical role usually asks for.
 * `omitted` is the half people forget to look at.
 */
export interface CatalogComparison {
  readonly roleProfileId: string;
  readonly usual: readonly string[];
  /** Canonical keys this JD asks for that the canonical role usually does too. */
  readonly shared: readonly string[];
  /** Asked for here and not usual for the role — often right, always worth seeing. */
  readonly added: readonly string[];
  /** Usual for the role and absent here. */
  readonly omitted: readonly string[];
  /** Of those, the ones whose absence is worth interrupting someone about. */
  readonly missingCore: readonly string[];
}

export function compareToCanonicalRole(
  title: string,
  tag: DomainTag | null,
  proposedKeys: readonly string[],
): CatalogComparison | null {
  const profile = canonicalRoleProfileFor(title, tag);
  if (!profile) return null;
  const proposed = new Set(proposedKeys);
  const usual = new Set(profile.usual);
  return {
    roleProfileId: profile.id,
    usual: profile.usual,
    shared: profile.usual.filter((k) => proposed.has(k)),
    // Baseline competencies are on every role by construction, so listing them
    // as an unusual addition would be noise on every single scorecard.
    added: proposedKeys.filter((k) => !usual.has(k) && !isBaseline(k)),
    omitted: profile.usual.filter((k) => !proposed.has(k)),
    missingCore: profile.core.filter((k) => !proposed.has(k)),
  };
}

const BASELINE_KEYS = new Set(CANONICAL_COMPETENCIES.filter((c) => c.baseline === true).map((c) => c.key));

function isBaseline(key: string): boolean {
  return BASELINE_KEYS.has(key);
}

/** Exported for the taxonomy tests, which check every profile names real competencies. */
export function competencyKeysForDomain(tag: DomainTag): readonly string[] {
  return competenciesForDomain(tag).map((c) => c.key);
}
