import { prisma, parseJsonOptional } from '../db.js';

/**
 * The interleaved trial's paired report: library blocks against built-in
 * blocks of the same interviews, compared on evidence yield, non-answers,
 * confusion markers, probes and — once a reviewer has been through the
 * assessment — reviewer agreement. Pure first; the loader reads the trial
 * rows (LibraryUsage.trial) and the review differences for their sessions.
 *
 * A pair is an interview with at least one library block and one built-in
 * block on the trial. Library rungs of one block count as one block.
 */

/** The plan's bar: two weeks or this many library blocks, whichever is later. */
export const TRIAL_TARGET_BLOCKS = 100;

export interface TrialRow {
  readonly interviewSessionId: string;
  readonly competencyId: string;
  readonly blockSource: string;
  readonly outcome: string;
  readonly evidenceYield: number | null;
  readonly probeCount: number;
  readonly confusionMarkers: number;
  readonly askedAt: Date;
}

/** Per session, per competency: did the reviewer leave the AI's level as it was? */
export type ReviewerAgreement = ReadonlyMap<string, ReadonlyMap<string, boolean>>;

export interface SideStats {
  readonly blocks: number;
  readonly meanYield: number | null;
  readonly nonAnswerRate: number | null;
  readonly confusionRate: number | null;
  readonly meanProbes: number | null;
  /** Share of reviewed blocks whose level the reviewer did not change; null until any are reviewed. */
  readonly reviewerAgreement: number | null;
  readonly reviewedBlocks: number;
}

export interface TrialReport {
  readonly interviews: number;
  readonly library: SideStats;
  readonly builtin: SideStats;
  /** Mean over paired interviews of (library yield − built-in yield); positive favours the library. */
  readonly pairedYieldDifference: number | null;
  readonly firstAskedAt: string | null;
  readonly targetBlocks: number;
}

interface BlockOutcome {
  readonly session: string;
  readonly competencyId: string;
  readonly source: 'library' | 'builtin';
  readonly yield: number | null;
  readonly nonAnswer: boolean;
  readonly confused: boolean;
  readonly probes: number;
}

function mean(values: readonly number[]): number | null {
  return values.length ? Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 1000) / 1000 : null;
}

function blocksOf(rows: readonly TrialRow[]): BlockOutcome[] {
  const groups = new Map<string, TrialRow[]>();
  for (const row of rows) {
    const key = `${row.interviewSessionId}|${row.competencyId}|${row.blockSource}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  return [...groups.values()].map((group) => {
    const yields = group.flatMap((r) => (r.evidenceYield === null ? [] : [r.evidenceYield]));
    return {
      session: group[0].interviewSessionId,
      competencyId: group[0].competencyId,
      source: group[0].blockSource === 'library' ? 'library' : 'builtin',
      yield: mean(yields),
      nonAnswer: group.every((r) => r.outcome !== 'answered'),
      confused: group.some((r) => r.confusionMarkers > 0),
      probes: group.reduce((sum, r) => sum + r.probeCount, 0),
    };
  });
}

function sideStats(blocks: readonly BlockOutcome[], agreement: ReviewerAgreement): SideStats {
  const reviewed = blocks.flatMap((b) => {
    const agreed = agreement.get(b.session)?.get(b.competencyId);
    return agreed === undefined ? [] : [agreed ? 1 : 0];
  });
  const rate = (pick: (b: BlockOutcome) => boolean) => (blocks.length ? mean(blocks.map((b) => (pick(b) ? 1 : 0))) : null);
  return {
    blocks: blocks.length,
    meanYield: mean(blocks.flatMap((b) => (b.yield === null ? [] : [b.yield]))),
    nonAnswerRate: rate((b) => b.nonAnswer),
    confusionRate: rate((b) => b.confused),
    meanProbes: blocks.length ? mean(blocks.map((b) => b.probes)) : null,
    reviewerAgreement: mean(reviewed),
    reviewedBlocks: reviewed.length,
  };
}

export function buildTrialReport(rows: readonly TrialRow[], agreement: ReviewerAgreement = new Map()): TrialReport {
  const blocks = blocksOf(rows);
  const bySession = new Map<string, BlockOutcome[]>();
  for (const b of blocks) bySession.set(b.session, [...(bySession.get(b.session) ?? []), b]);
  const paired = [...bySession.values()].filter((bs) => bs.some((b) => b.source === 'library') && bs.some((b) => b.source === 'builtin'));
  const pairedBlocks = paired.flat();
  const differences = paired.flatMap((bs) => {
    const lib = mean(bs.filter((b) => b.source === 'library' && b.yield !== null).map((b) => b.yield as number));
    const bank = mean(bs.filter((b) => b.source === 'builtin' && b.yield !== null).map((b) => b.yield as number));
    return lib === null || bank === null ? [] : [lib - bank];
  });
  const first = rows.reduce<Date | null>((min, r) => (min === null || r.askedAt < min ? r.askedAt : min), null);
  return {
    interviews: paired.length,
    library: sideStats(pairedBlocks.filter((b) => b.source === 'library'), agreement),
    builtin: sideStats(pairedBlocks.filter((b) => b.source === 'builtin'), agreement),
    pairedYieldDifference: mean(differences),
    firstAskedAt: first ? first.toISOString() : null,
    targetBlocks: TRIAL_TARGET_BLOCKS,
  };
}

interface DifferenceEntry {
  readonly competencyId?: unknown;
  readonly changed?: unknown;
}

/** Reviewer agreement per trial block, from the review differences of each session's assessment. */
async function loadAgreement(sessionIds: readonly string[]): Promise<ReviewerAgreement> {
  if (sessionIds.length === 0) return new Map();
  const diffs = await prisma.reviewDifference.findMany({
    where: { assessment: { sessionId: { in: [...sessionIds] } } },
    select: { id: true, competenciesJson: true, createdAt: true, assessment: { select: { sessionId: true } } },
    orderBy: { createdAt: 'asc' },
  });
  const out = new Map<string, Map<string, boolean>>();
  for (const diff of diffs) {
    const entries = parseJsonOptional<DifferenceEntry[]>(diff.competenciesJson, [], { model: 'ReviewDifference', id: diff.id, field: 'competenciesJson' });
    // The latest review of a session wins: a superseded review is not the verdict.
    const perCompetency = new Map<string, boolean>();
    for (const e of Array.isArray(entries) ? entries : []) {
      if (typeof e.competencyId === 'string') perCompetency.set(e.competencyId, e.changed !== true);
    }
    out.set(diff.assessment.sessionId, perCompetency);
  }
  return out;
}

export async function loadTrialReport(opts: { readonly tenantId?: string } = {}): Promise<TrialReport> {
  const rows = await prisma.libraryUsage.findMany({
    where: { trial: true, ...(opts.tenantId ? { tenantId: opts.tenantId } : {}) },
    select: { interviewSessionId: true, competencyId: true, blockSource: true, outcome: true, evidenceYield: true, probeCount: true, confusionMarkers: true, askedAt: true },
  });
  const agreement = await loadAgreement([...new Set(rows.map((r) => r.interviewSessionId))]);
  return buildTrialReport(rows, agreement);
}
