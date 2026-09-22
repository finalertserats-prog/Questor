import { prisma } from '../../src/db.js';
import { ensureCatalogSeeded } from '../../src/services/catalogSeed.js';
import { slugifyCatalogName } from '../../src/domain/catalogText.js';

/**
 * LOCAL PILOT ONLY. Builds the demand the 2026-09-22 pilot filled: a pilot
 * organisation hiring two catalog roles (Software Engineer, Enterprise
 * Account Executive) at two bands, each with an approved scorecard of four
 * competencies and a shared catalog JD draft per band. Refuses to run against
 * anything but a database on this machine.
 *
 *   DATABASE_URL=postgresql://...@127.0.0.1:.../questor_library_seed npx tsx scripts/library-seed/pilotWorld.ts
 */

const BANDS = ['developing', 'senior'] as const;

interface PilotCompetency {
  readonly name: string;
  readonly category: 'technical' | 'domain' | 'behavioral' | 'situational' | 'communication';
  readonly definition: string;
  readonly indicators: readonly string[];
}

interface PilotRole {
  readonly title: string;
  readonly jd: string;
  readonly competencies: readonly PilotCompetency[];
}

const ROLES: readonly PilotRole[] = [
  {
    title: 'Software Engineer',
    jd: 'Software Engineer. Design, build and operate reliable software products and enterprise systems. Write, test and review production code; design APIs, services and data models; debug and resolve production incidents; automate builds, tests and deployments; work with product managers and designers to turn requirements into shipped features; share knowledge through code review and documentation.',
    competencies: [
      { name: 'Software Design & Architecture', category: 'technical', definition: 'Designs services, APIs and data models that are simple, reliable and easy to change.', indicators: ['Explains the trade-offs behind an API or schema design', 'Breaks a system into components with clear boundaries', 'Plans for failure, scale and change'] },
      { name: 'Code Quality & Testing', category: 'technical', definition: 'Writes readable, well-tested production code and reviews code constructively.', indicators: ['Chooses the right level of automated tests', 'Gives and acts on specific code review feedback', 'Refactors to reduce risk before adding features'] },
      { name: 'Debugging & Incident Response', category: 'situational', definition: 'Finds the root cause of production problems methodically and prevents recurrence.', indicators: ['Forms and tests hypotheses from logs and metrics', 'Keeps people informed during an incident', 'Follows through on fixes and postmortem actions'] },
      { name: 'Cross-functional Collaboration', category: 'behavioral', definition: 'Works with product, design and other engineers to ship the right thing.', indicators: ['Clarifies ambiguous requirements before building', 'Negotiates scope and trade-offs with product', 'Shares context and unblocks teammates'] },
    ],
  },
  {
    title: 'Enterprise Account Executive',
    jd: 'Enterprise Account Executive. Create predictable revenue by developing opportunities with large organisations. Own a territory of enterprise accounts; prospect and qualify new opportunities; run multi-stakeholder sales cycles from discovery to signature; build business cases with champions and economic buyers; negotiate pricing and contract terms; forecast accurately and keep the CRM current; work with solutions engineers, customer success and marketing.',
    competencies: [
      { name: 'Pipeline Generation & Prospecting', category: 'domain', definition: 'Builds and qualifies enterprise pipeline in an assigned territory.', indicators: ['Researches accounts and maps the buying committee', 'Qualifies with a consistent framework such as MEDDICC', 'Balances new logos with expansion in existing accounts'] },
      { name: 'Complex Deal Management', category: 'domain', definition: 'Runs long, multi-stakeholder enterprise sales cycles through to signature.', indicators: ['Builds and runs a mutual close plan', 'Engages the economic buyer and develops champions', 'Manages procurement, legal and security reviews'] },
      { name: 'Negotiation & Commercial Acumen', category: 'domain', definition: 'Negotiates pricing and contract terms that protect value for both sides.', indicators: ['Trades concessions for commitments', "Grounds price in the customer's business case", 'Knows when to walk away from a deal'] },
      { name: 'Forecasting & Territory Planning', category: 'situational', definition: 'Plans territory coverage and forecasts the number accurately.', indicators: ['Calls the forecast with evidence from the deal', 'Keeps CRM data accurate and current', 'Prioritises accounts by potential and fit'] },
    ],
  },
];

function assertLocal(): void {
  const url = process.env.DATABASE_URL ?? '';
  const host = url.startsWith('file:') ? 'localhost' : (() => { try { return new URL(url).hostname; } catch { return ''; } })();
  if (!['127.0.0.1', 'localhost', '::1'].includes(host)) throw new Error('pilotWorld runs only against a database on this machine');
}

function profileJson(role: PilotRole): string {
  return JSON.stringify({
    roleContext: role.title, outcomes: [], responsibilities: [],
    competencies: role.competencies.map((c, i) => ({
      id: `c${i + 1}`, name: c.name, category: c.category, definition: c.definition, indicators: [...c.indicators],
      classification: 'essential', weight: 1 / role.competencies.length, requiredLevel: 3, targetLevel: 4, evidenceModes: [],
    })),
    scoringRules: { mustPassCompetencyIds: [], notEnoughEvidencePolicy: 'exclude', passThreshold: 65 },
    policyRules: { prohibitedTopics: [], requiredDisclosures: [], accommodationsEnabled: true, jurisdiction: '' },
    redFlags: [], seniority: 'mid',
  });
}

async function main(): Promise<void> {
  assertLocal();
  await ensureCatalogSeeded();
  const tenant = await prisma.tenant.upsert({ where: { id: 'library-seed-pilot' }, create: { id: 'library-seed-pilot', name: 'Library seed pilot' }, update: {} });
  const region = await prisma.catalogRegion.findFirst({ where: { status: 'active' }, orderBy: { sortOrder: 'asc' }, select: { code: true } });
  if (!region) throw new Error('catalog has no region');
  for (const role of ROLES) {
    const catalogRole = await prisma.catalogRole.findFirst({ where: { normalizedTitle: role.title.toLowerCase(), status: 'active' }, select: { id: true } });
    if (!catalogRole) throw new Error(`catalog role missing: ${role.title}`);
    for (const band of BANDS) {
      await prisma.catalogJdDraft.upsert({
        where: { catalogRoleId_experienceBand_regionCode: { catalogRoleId: catalogRole.id, experienceBand: band, regionCode: region.code } },
        create: { catalogRoleId: catalogRole.id, experienceBand: band, regionCode: region.code, status: 'ready', text: role.jd, generator: 'pilot' },
        update: { status: 'ready', text: role.jd },
      });
      const existing = await prisma.role.findFirst({ where: { tenantId: tenant.id, catalogRoleId: catalogRole.id, experienceBand: band } });
      if (existing) continue;
      await prisma.role.create({
        data: {
          tenantId: tenant.id, catalogRoleId: catalogRole.id, experienceBand: band, title: role.title, status: 'approved', sourceText: role.jd,
          scorecards: { create: { version: 1, status: 'approved', profileJson: profileJson(role) } },
        },
      });
    }
    process.stdout.write(`${slugifyCatalogName(role.title)}: ${BANDS.length} bands x ${role.competencies.length} competencies\n`);
  }
}

main().then(() => prisma.$disconnect(), async (err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  await prisma.$disconnect();
  process.exit(1);
});
