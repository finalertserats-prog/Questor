import type { PageMeta } from '../listPagingModel';
import type { GridCell } from './comparisonModel';

/**
 * The shapes the role page's comparison endpoints answer with.
 *
 * Every field the blind-review policy can withhold is optional rather than
 * nullable: the server LEAVES IT OUT for a viewer who owes their own verdict,
 * and `blindReviewPending` is what says so. A null would read as "no
 * assessment", which is a different fact.
 */

export interface RoleCandidateStage {
  readonly key: string;
  readonly label: string;
  /** 1-based position in the role's stage plan; null when the plan does not name the stage. */
  readonly order: number | null;
  /**
   * A decided pipeline, already said in the one vocabulary by the server
   * (Proceed / Consider / Do not progress / Candidate withdrew). Never the
   * stored enum, and null while the pipeline is running or while the
   * blind-review policy holds this viewer back.
   */
  readonly outcome: string | null;
}

export interface ComparabilityNote {
  readonly kind: 'scorecard_version' | 'interview_depth';
  readonly text: string;
}

export interface RoleCandidateRow {
  readonly id: string;
  readonly fullName: string;
  readonly email: string;
  readonly stage: RoleCandidateStage | null;
  readonly latestInterview: { readonly id: string; readonly state: string } | null;
  readonly assessmentId: string | null;
  readonly recommendation?: string | null;
  readonly humanRecommendation?: string | null;
  readonly blindReviewPending?: boolean;
  readonly overallScore?: number | null;
  readonly scorecardVersion: number | null;
  readonly competenciesGraded: number | null;
  readonly durationMinutes: number | null;
  readonly lastMovedAt: string;
  readonly shortlisted: boolean;
  readonly comparability: readonly ComparabilityNote[];
}

export interface RoleCandidatesPayload {
  readonly candidates: readonly RoleCandidateRow[];
  readonly meta?: PageMeta;
  readonly sort?: { readonly key: string; readonly dir: string };
}

export interface GridCompetency {
  readonly id: string;
  readonly name: string;
  readonly category: string;
  readonly requiredLevel: number;
  readonly targetLevel: number;
  readonly weight: number;
}

export interface GridRow {
  readonly candidateId: string;
  readonly fullName: string;
  readonly assessmentId: string | null;
  readonly blindReviewPending?: boolean;
  readonly levelSource: 'human' | 'ai' | null;
  readonly cells: Readonly<Record<string, GridCell>>;
  readonly comparability: readonly ComparabilityNote[];
}

export interface GridPayload {
  readonly competencies: readonly GridCompetency[];
  readonly rows: readonly GridRow[];
  readonly meta?: PageMeta;
  readonly scorecardVersion: number;
}

export interface ComparedEvidence {
  readonly quote: string;
  readonly turnId: string;
  readonly startMs: number;
}

export interface ComparedCompetency {
  readonly id: string;
  readonly cell: GridCell;
  readonly rationale: string;
  readonly evidence: readonly ComparedEvidence[];
}

export interface ComparedCandidate {
  readonly id: string;
  readonly fullName: string;
  readonly email: string;
  readonly stage: RoleCandidateStage | null;
  readonly latestInterview: { readonly id: string; readonly state: string } | null;
  readonly assessmentId: string | null;
  readonly blindReviewPending?: boolean;
  readonly recommendation?: string | null;
  readonly humanRecommendation?: string | null;
  readonly overallScore?: number | null;
  readonly levelSource: 'human' | 'ai' | null;
  readonly competencies: readonly ComparedCompetency[];
  readonly nextRoundAt: string | null;
  readonly nextRoundTimeZone: string | null;
  readonly comparability: readonly ComparabilityNote[];
}

export interface ComparisonPayload {
  readonly competencies: readonly GridCompetency[];
  readonly candidates: readonly ComparedCandidate[];
  readonly scorecardVersion: number;
  readonly availabilityRecorded: boolean;
}

export interface ShortlistPayload {
  readonly candidateIds: readonly string[];
  readonly max: number;
}
