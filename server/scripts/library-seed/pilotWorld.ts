import { prisma } from '../../src/db.js';
import { ensureCatalogSeeded } from '../../src/services/catalogSeed.js';
import { slugifyCatalogName } from '../../src/domain/catalogText.js';
import { platformCompetencyCatalog, type PlatformCompetency } from '../../src/engines/roleIntelligence.js';

/**
 * LOCAL PILOT ONLY. Builds the demand the 2026-09-22 pilot filled: a pilot
 * organisation hiring two catalog roles (Software Engineer, Enterprise
 * Account Executive) at two bands, each with an approved scorecard of four
 * platform competencies and a shared catalog JD draft per band. Refuses to run against
 * anything but a database on this machine.
 *
 *   DATABASE_URL=postgresql://...@127.0.0.1:.../questor_library_seed npx tsx scripts/library-seed/pilotWorld.ts
 */

const BANDS = ['developing', 'senior'] as const;

interface PilotRole {
  readonly title: string;
  readonly jd: string;
  /** Platform competency names (platformCompetencyCatalog): only these are ever exported for the offline seed. */
  readonly competencies: readonly string[];
}

const ROLES: readonly PilotRole[] = [
  {
    title: 'Software Engineer',
    jd: 'Software Engineer. Design, build and operate reliable software products and enterprise systems. Write, test and review production code; design APIs, services and data models; debug and resolve production incidents; automate builds, tests and deployments; work with product managers and designers to turn requirements into shipped features; share knowledge through code review and documentation.',
    competencies: ['Software Engineering', 'Reliability & Operations', 'Problem Solving', 'Collaboration'],
  },
  {
    title: 'Enterprise Account Executive',
    jd: 'Enterprise Account Executive. Create predictable revenue by developing opportunities with large organisations. Own a territory of enterprise accounts; prospect and qualify new opportunities; run multi-stakeholder sales cycles from discovery to signature; build business cases with champions and economic buyers; negotiate pricing and contract terms; forecast accurately and keep the CRM current; work with solutions engineers, customer success and marketing.',
    competencies: ['Sales Execution', 'Finance & Analysis', 'Communication', 'Ownership & Impact'],
  },
];

function platformCompetency(name: string): PlatformCompetency {
  const found = platformCompetencyCatalog().find((c) => c.name === name);
  if (!found) throw new Error(`not a platform competency: ${name}`);
  return found;
}

function assertLocal(): void {
  const url = process.env.DATABASE_URL ?? '';
  const host = url.startsWith('file:') ? 'localhost' : (() => { try { return new URL(url).hostname; } catch { return ''; } })();
  if (!['127.0.0.1', 'localhost', '::1'].includes(host)) throw new Error('pilotWorld runs only against a database on this machine');
}

function profileJson(role: PilotRole): string {
  return JSON.stringify({
    roleContext: role.title, outcomes: [], responsibilities: [],
    competencies: role.competencies.map((name) => platformCompetency(name)).map((c, i) => ({
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
