import { parseJsonStrict } from '../db.js';
import { techStackFromJson, type TechStackItem } from '../domain/techStack.js';
import { syncJdTechStack, type JdSyncResult } from '../domain/jdTechStackSection.js';
import type { RoleSuccessProfile } from '../domain/types.js';
import { BANDS, type BandId } from '../engines/experienceBands.js';
import { bandForRoleSeniority } from '../engines/bandCalibration.js';
import { lintJd } from '../engines/jdDraft.js';
import { proposeStackCompetencies, type StackCompetencyProposal } from '../engines/techStackCompetencies.js';

/**
 * Reading a role's tech stack and band off its row, for every place that
 * hands them to an engine: role creation, the plan, the live interviewer,
 * the grader and the fit score all go through here so none of them parses
 * the column its own way.
 */

export function roleTechStack(row: { readonly id: string; readonly techStackJson: string }): TechStackItem[] {
  return techStackFromJson(parseJsonStrict<unknown>(row.techStackJson, { model: 'Role', id: row.id, field: 'techStackJson' }));
}

const BAND_IDS = new Set<string>(BANDS.map((b) => b.id));

/** The role's chosen band, or the one its level string implies. */
export function roleBand(row: { readonly experienceBand: string | null }, seniority: string): BandId {
  return row.experienceBand && BAND_IDS.has(row.experienceBand) ? (row.experienceBand as BandId) : bandForRoleSeniority(seniority).id;
}

export interface TechStackChange {
  readonly jd: JdSyncResult & { readonly lint: ReturnType<typeof lintJd> };
  readonly proposals: StackCompetencyProposal[];
}

/**
 * What changing the stack would do: the JD section before and after, the
 * lint of the result, and the competencies it suggests. Pure, so the page
 * can show it for confirmation before anything is written.
 */
export function planTechStackChange(opts: {
  readonly sourceText: string;
  readonly next: readonly TechStackItem[];
  readonly profile: RoleSuccessProfile;
  readonly band: BandId;
}): TechStackChange {
  const sync = syncJdTechStack(opts.sourceText, opts.next);
  return {
    jd: { ...sync, lint: lintJd(sync.text) },
    proposals: proposeStackCompetencies({ techStack: opts.next, band: opts.band, competencies: opts.profile.competencies }),
  };
}
