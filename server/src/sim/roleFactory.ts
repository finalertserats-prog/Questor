/**
 * Role generator — the agent that invents the jobs candidates apply for.
 *
 * Two paths, deliberately. `generateRole` asks a peer AI for a fresh job
 * description, which is what gives a sweep its variety. `templateRole` builds
 * one deterministically, which is what lets the harness be tested at all: a
 * fixture that changes every run cannot tell you whether the engine changed.
 */
import { nanoid } from 'nanoid';
import { bandById, type BandId } from './bands.js';
import { callPeerJson, type PeerId } from './peers.js';

export const ROLE_FAMILIES = [
  'data_engineering',
  'software_engineering',
  'product_management',
  'sales',
  'finance',
  'security',
  'marketing',
  'customer_success',
] as const;

export type RoleFamily = (typeof ROLE_FAMILIES)[number];

export interface RoleSpec {
  id: string;
  title: string;
  family: RoleFamily;
  band: BandId;
  organisation: string;
  jdText: string;
  generatedBy: PeerId | 'template';
}

interface FamilyProfile {
  stem: string;
  /** Skills line — also what `extractRoleHeuristic`'s taxonomy keys off. */
  skills: string;
  craft: string[];
  system: string[];
  organisation: string[];
}

const FAMILIES: Record<RoleFamily, FamilyProfile> = {
  data_engineering: {
    stem: 'Data Engineer',
    skills: 'SQL, Python, Airflow, dbt, Spark, Snowflake, AWS, data modeling',
    craft: [
      'Write and debug SQL transformations against the analytics warehouse.',
      'Build and maintain scheduled Python jobs that load source data.',
      'Add tests and data checks to existing pipelines.',
    ],
    system: [
      'Own the reliability of production data pipelines, including detection and backfill.',
      'Design dimensional models and reason about correctness at scale.',
      'Optimise warehouse cost and query performance against an agreed SLA.',
    ],
    organisation: [
      'Set the data platform architecture and the standards other groups build against.',
      'Decide build-versus-buy for platform components and own that budget.',
      'Shape the multi-year data strategy with analytics and product leadership.',
    ],
  },
  software_engineering: {
    stem: 'Software Engineer',
    skills: 'TypeScript, Node, React, API design, microservice, testing, Docker',
    craft: [
      'Implement well-specified features and fix defects in an existing codebase.',
      'Write unit and integration tests for the code you ship.',
      'Respond to code review and iterate on feedback.',
    ],
    system: [
      'Own a production service end to end, including its failure modes and on-call.',
      'Design APIs and data contracts other teams depend on.',
      'Lead incident response and drive the follow-up fixes.',
    ],
    organisation: [
      'Set engineering standards and architecture direction across multiple teams.',
      'Own platform investment decisions and their long-horizon consequences.',
      'Shape technical strategy with product and executive leadership.',
    ],
  },
  product_management: {
    stem: 'Product Manager',
    skills: 'roadmap, backlog, user stories, prioritisation, stakeholder management, analytics',
    craft: [
      'Write clear user stories and acceptance criteria from agreed requirements.',
      'Keep the backlog groomed and the team unblocked.',
      'Track feature adoption and report on it.',
    ],
    system: [
      'Own a product area, its roadmap and the trade-offs within it.',
      'Run discovery with customers and turn findings into prioritised work.',
      'Balance technical debt against feature delivery with engineering.',
    ],
    organisation: [
      'Own the portfolio roadmap and the bets the company declines to make.',
      'Align product strategy with commercial targets and the board narrative.',
      'Build and develop a product management practice.',
    ],
  },
  sales: {
    stem: 'Account Executive',
    skills: 'CRM, Salesforce, pipeline, quota, prospecting, closing deals, forecasting',
    craft: [
      'Work an assigned prospect list and qualify inbound leads.',
      'Keep CRM records current and accurate.',
      'Run first-call discovery against a defined script.',
    ],
    system: [
      'Own a territory and its full pipeline from prospecting to close.',
      'Negotiate commercial terms within an agreed discount framework.',
      'Forecast accurately and defend the number in review.',
    ],
    organisation: [
      'Own regional revenue, the P&L behind it and the headcount plan.',
      'Set the segmentation and coverage model across multiple teams.',
      'Build the sales organisation and its enablement practice.',
    ],
  },
  finance: {
    stem: 'Financial Analyst',
    skills: 'financial model, forecast, budget, GAAP, accounting, variance analysis, Excel, SQL',
    craft: [
      'Prepare recurring management reports and reconcile variances.',
      'Maintain financial models under supervision of the reporting lead.',
      'Support month-end close activities.',
    ],
    system: [
      'Own the forecast for a business unit and explain the variances.',
      'Design the financial model behind pricing or investment decisions.',
      'Partner with operational leaders on budget trade-offs.',
    ],
    organisation: [
      'Own company-wide planning, the budget of the group and capital allocation.',
      'Present the financial narrative to the board and external stakeholders.',
      'Build the finance function and its controls.',
    ],
  },
  security: {
    stem: 'Security Engineer',
    skills: 'security, compliance, risk, audit, SOC 2, ISO 27001, threat modeling, governance',
    craft: [
      'Triage vulnerability findings and track remediation.',
      'Run recurring access reviews and evidence collection.',
      'Apply agreed hardening baselines to systems.',
    ],
    system: [
      'Own threat modelling for a product area and drive the resulting fixes.',
      'Design detection and response for a class of attack.',
      'Own the control set behind an audit and defend it to the auditor.',
    ],
    organisation: [
      'Set the security architecture and risk appetite across the organisation.',
      'Own the compliance programme, its budget and its external commitments.',
      'Advise executives and the board on security risk.',
    ],
  },
  marketing: {
    stem: 'Marketing Manager',
    skills: 'campaign, SEO, content, brand, demand gen, analytics, attribution',
    craft: [
      'Execute campaigns against an agreed brief and calendar.',
      'Produce content and keep channel assets current.',
      'Report on campaign performance.',
    ],
    system: [
      'Own a channel end to end, including its budget and attribution model.',
      'Design the demand generation programme for a segment.',
      'Run experiments and act on what they show.',
    ],
    organisation: [
      'Own the brand and the company-wide marketing strategy.',
      'Allocate the marketing budget of the group across channels and bets.',
      'Build the marketing organisation.',
    ],
  },
  customer_success: {
    stem: 'Customer Success Manager',
    skills: 'CRM, onboarding, retention, churn, QBR, stakeholder management, escalation',
    craft: [
      'Run onboarding for new accounts against a defined playbook.',
      'Log account health and escalate risks to the account lead.',
      'Answer customer questions and coordinate support responses.',
    ],
    system: [
      'Own a book of accounts, their renewal risk and their expansion.',
      'Design the success plan for strategic customers and drive it.',
      'Turn recurring customer pain into prioritised product feedback.',
    ],
    organisation: [
      'Own retention across the customer base and the team delivering it.',
      'Set the coverage model and the success practice across teams.',
      'Own the renewal number and its commercial narrative.',
    ],
  },
};

const TITLE_PREFIX: Record<BandId, string> = {
  emerging: 'Junior ',
  developing: '',
  established: 'Senior ',
  senior: 'Lead ',
  principal: 'Principal ',
  executive: 'Director of ',
};

const LEVEL_LABEL: Record<BandId, string> = {
  emerging: 'Entry',
  developing: 'Mid',
  established: 'Senior',
  senior: 'Lead',
  principal: 'Principal',
  executive: 'Director',
};

const ORGS = [
  'Northwind Retail', 'Kestrel Health', 'Meridian Bank', 'Orbital Logistics',
  'Larkspur Media', 'Fenwick Insurance', 'Solstice Energy', 'Trellis Software',
];

/** Stable index from a string, so template output does not drift between runs. */
function stableIndex(seed: string, modulo: number): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return h % modulo;
}

export function roleTitleFor(family: RoleFamily, band: BandId): string {
  const stem = FAMILIES[family].stem;
  if (band === 'executive') {
    // "Director of Data Engineer" reads wrong; pluralise the discipline instead.
    const discipline = stem.replace(/ (Engineer|Manager|Executive|Analyst)$/, '');
    return `Director of ${discipline}`;
  }
  return `${TITLE_PREFIX[band]}${stem}`;
}

/** Deterministic JD. The fixture the harness can be tested against. */
export function templateRole(opts: { family: RoleFamily; band: BandId; organisation?: string }): RoleSpec {
  const { family, band } = opts;
  const profile = FAMILIES[family];
  const bandDef = bandById(band);
  const title = roleTitleFor(family, band);
  const organisation = opts.organisation ?? ORGS[stableIndex(`${family}:${band}`, ORGS.length)];

  const responsibilities = profile[bandDef.abstraction];
  const jdText = [
    title,
    `Organisation: ${organisation}  |  Location: Remote  |  Employment type: Full-time  |  Level: ${LEVEL_LABEL[band]}`,
    '',
    'About the role:',
    `${organisation} is hiring a ${title}. The work sits at the ${bandDef.abstraction} level: ${bandDef.evidenceBar}`,
    '',
    'Responsibilities:',
    ...responsibilities.map((r) => `- ${r}`),
    '',
    'What we look for:',
    ...bandDef.askAbout.slice(0, 3).map((a) => `- Evidence of ${a}.`),
    '',
    'Must have:',
    `- ${profile.skills}.`,
    '- Demonstrated, job-relevant experience at the level described above.',
    '',
    'Preferred:',
    '- Experience in a comparable operating environment.',
  ].join('\n');

  return { id: nanoid(8), title, family, band, organisation, jdText, generatedBy: 'template' };
}

/** Shape check for a peer-generated role. Throwing here triggers one repair ask. */
export function validateRoleSpec(raw: unknown): { title: string; jdText: string } {
  const r = raw as { title?: unknown; jdText?: unknown };
  if (typeof r?.title !== 'string' || r.title.trim().length < 3) throw new Error('title missing or too short');
  if (typeof r?.jdText !== 'string' || r.jdText.trim().length < 200) throw new Error('jdText missing or too short (need a real JD, not a stub)');
  return { title: r.title.trim().slice(0, 120), jdText: r.jdText.trim().slice(0, 8000) };
}

/** Ask a peer for a fresh job description at a given family and band. */
export async function generateRole(opts: {
  family: RoleFamily;
  band: BandId;
  peer: PeerId;
  organisation?: string;
}): Promise<RoleSpec> {
  const { family, band, peer } = opts;
  const bandDef = bandById(band);
  const organisation = opts.organisation ?? ORGS[stableIndex(`${family}:${band}:${peer}`, ORGS.length)];
  const title = roleTitleFor(family, band);

  const prompt = [
    'You are generating a realistic job description for an interview simulation. It will be read by an automated interviewer, so it must be concrete.',
    '',
    `Discipline: ${family.replace(/_/g, ' ')}`,
    `Suggested title: ${title}`,
    `Hiring organisation: ${organisation} (invented company — do not use a real one)`,
    `Target level: ${bandDef.label} — work sits at the ${bandDef.abstraction} level.`,
    `What good looks like at this level: ${bandDef.evidenceBar}`,
    '',
    'The JD must:',
    '- state a title, level, location and employment type on one line near the top',
    '- list 4-6 responsibilities that genuinely belong at this level and NOT at a higher or lower one',
    `- never ask for any of these, which are wrong for this level: ${bandDef.avoid.join('; ')}`,
    '- list concrete must-have skills by name',
    '- contain no age-coded, gendered or exclusionary language',
    '- be 250-500 words',
    '',
    'Return: {"title": "...", "jdText": "..."}',
  ].join('\n');

  const out = await callPeerJson(peer, prompt, {
    validate: validateRoleSpec,
    label: `generateRole(${family}/${band})`,
  });

  return { id: nanoid(8), title: out.title, family, band, organisation, jdText: out.jdText, generatedBy: peer };
}
