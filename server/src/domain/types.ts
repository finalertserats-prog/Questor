// Questor domain types. These describe the JSON structures serialized into the
// DB's *Json columns and passed between engines. (BRD Sections 7, 10, 15, 16.)

import type { BandId } from '../engines/experienceBands.js';

export type Proficiency = 0 | 1 | 2 | 3 | 4 | 5;

export interface Competency {
  id: string;
  name: string;
  definition: string;
  category: 'behavioral' | 'technical' | 'domain' | 'situational' | 'communication';
  classification: 'essential' | 'preferred' | 'trainable' | 'non_scoring';
  weight: number;                 // 0..1, essential+preferred normalized to sum 1
  requiredLevel: Proficiency;     // minimum acceptable
  targetLevel: Proficiency;       // target
  indicators: string[];           // observable behavioral indicators
  evidenceModes: string[];        // behavioral_example | technical_explanation | work_sample | case | certification
  sourceText?: string;            // JD span the competency was derived from
  confidence?: number;            // extraction confidence 0..1
  /**
   * Kept for the record, no longer assessed. A competency with interview
   * history is retired rather than deleted so an older assessment, review or
   * feedback letter can still resolve its id to a name.
   */
  retired?: boolean;
}

export interface RoleSuccessProfile {
  roleContext: string;
  outcomes: string[];
  responsibilities: string[];
  competencies: Competency[];
  scoringRules: {
    mustPassCompetencyIds: string[];
    notEnoughEvidencePolicy: 'exclude' | 'penalize';
    passThreshold: number;        // 0..100 overall recommendation threshold for PROCEED
  };
  policyRules: {
    prohibitedTopics: string[];
    requiredDisclosures: string[];
    accommodationsEnabled: boolean;
    proctoringEnabled?: boolean;
    jurisdiction: string;
  };
  redFlags: string[];
  seniority: string;
}

// ---- Resume / fit ----
export interface NormalizedProfile {
  employment: Array<{ title: string; company: string; start?: string; end?: string; summary?: string; bullets: string[] }>;
  education: Array<{ degree: string; institution: string; year?: string }>;
  projects: Array<{ name: string; summary: string }>;
  certifications: string[];
  skills: string[];
  totalYears?: number;
}

export interface FitScoreComponent {
  key: string;
  label: string;
  weight: number;
  score: number;       // 0..100
  evidence: string[];  // resume spans supporting the score
  rule: string;        // human-readable rule applied
}

export interface FitScore {
  overall: number;              // 0..100
  confidence: number;           // 0..1
  components: FitScoreComponent[];
  missing: string[];            // competencies with no resume evidence
  probes: string[];             // neutral interview probes for validation
  excludedSignals: string[];    // protected/irrelevant signals deliberately ignored
}

// ---- Interview plan ----
export interface PlanBlock {
  competencyId: string;
  competencyName: string;
  intent: string;               // question intent
  targetMinutes: number;
  followupHints: string[];      // situation/action/reasoning/result/learning probes
  prohibited: string[];
  module?: 'coding' | 'case' | 'presentation' | 'roleplay' | 'document_review';
  /**
   * What to ask, and what not to ask, at this candidate's experience level.
   * Absent on process/close blocks, which are script rather than assessment.
   */
  bandGuidance?: string;
  /**
   * Where this block's questions come from when the Q&A library planned it
   * (library/planLadders.ts). Absent when the library is off, so a plan built
   * without it is byte-for-byte what it always was.
   */
  library?: PlanBlockLibrary;
  /**
   * Identity assurance L3, on the resume-validation block only: lines from the
   * candidate's own CV to ask about, one question each (engines/cvAnchors.ts).
   */
  cvAnchors?: CvAnchor[];
}

/**
 * One library question as it stood when the plan was made. Stored on the plan
 * so a later edit or retirement of the entry never changes a running or past
 * interview, and the evaluator grades against these anchors, not live rows.
 */
export interface LibraryQuestionSnapshot {
  readonly entryId: string;
  readonly standardId: string | null;
  readonly questionText: string;
  /** What a strong answer covers; handed to the evaluator, never said aloud. */
  readonly anchors: readonly string[];
  /** The engine's QuestionForm; feeds the runtime's no-repeat window. */
  readonly form: string;
  readonly difficultyTag: number;
  /**
   * Suggested follow-ups (L2 fills them; empty until then). Each is a
   * suggestion the interviewer may phrase in its own words, offered when its
   * `when` flags match the engine's answerQuality() reading of the answer.
   */
  readonly probes?: readonly LibraryProbeSnapshot[];
}

/** A suggested follow-up on a library question. Never spoken as written. */
export interface LibraryProbeSnapshot {
  readonly text: string;
  /** answerQuality() flags that make this probe apt, e.g. { hasAction: true, hasResult: false }. */
  readonly when?: Readonly<Partial<Record<'hasSituation' | 'hasAction' | 'hasResult' | 'specific', boolean>>>;
}

/** What the CV says about a competency, used only to pitch the ladder, never to score. */
export type CvSignal = 'strong' | 'thin' | 'neutral';

export type LibraryBlockReason = 'trial_control' | 'no_ladder' | 'select_failed';

export interface PlanBlockLibrary {
  /** Who supplies the block's questions: a library ladder, or the built-in bank as before. */
  readonly source: 'library' | 'builtin';
  /** Why a built-in block is built-in; absent on a library block. */
  readonly reason?: LibraryBlockReason;
  /** The pool key this block was selected under. */
  readonly competencyKey: string;
  /** Planned under the interleaved trial: the block is one side of a paired comparison. */
  readonly trial: boolean;
  /** Easiest to hardest; two or three rungs. Present only on a library block. */
  readonly ladder?: readonly LibraryQuestionSnapshot[];
  /** The rung asked first (the middle one unless the CV moved it). */
  readonly startRung?: number;
  readonly cvSignal?: CvSignal;
}

/** The library's part in a plan: stored once, so the interview can be audited later. */
export interface PlanLibrary {
  readonly mode: 'on' | 'trial';
  /** The scorecard version the anchors were chosen against (the evaluator's rubricVersion). */
  readonly rubricVersion: string;
  readonly roleSlug: string;
  readonly band: string;
  readonly windowDays: number;
  /** Share of eligible blocks drawn from the library in trial mode, 0-100. */
  readonly trialPercent?: number;
  readonly selectedAt: string;
  /** Set when no ladder could be requested at all; every block is then built-in. */
  readonly unavailable?: 'role_not_in_catalog' | 'select_failed';
}

/** A specific line from the candidate's CV and the question that asks about it. */
export interface CvAnchor {
  source: 'employment' | 'project';
  /** The CV line, as written (trimmed and, if very long, shortened). */
  fact: string;
  /** What the interviewer asks, quoting the line. */
  question: string;
}

export interface InterviewPlan {
  durationMinutes: number;
  language: string;
  modules: string[];
  blocks: PlanBlock[];
  coverageTargets: Record<string, number>; // competencyId -> planned weight
  /**
   * Competencies the role defines but the interview had no time to assess.
   * Recorded so an assessment can say "not asked" rather than "no evidence" —
   * the difference between a gap in the plan and a gap in the candidate.
   */
  notAssessed?: string[];
  /**
   * The experience band this interview is pitched at (see engines/experienceBands).
   * Optional so plans persisted before calibration existed still deserialize.
   */
  band?: BandId;
  /** Why that band was chosen, for the audit trail behind the pitch. */
  bandRationale?: string;
  /** Present only when the Q&A library planned this interview. */
  library?: PlanLibrary;
}

// ---- Turns / evidence ----
export interface TurnRecord {
  id: string;
  index: number;
  speaker: 'agent' | 'candidate' | 'system';
  text: string;
  startMs: number;
  endMs: number;
  confidence: number;
  competencyId?: string;
  /**
   * What an agent turn was ('question', 'pause', 'postponed', …), from the
   * turn's stored metadata. Lets the conversation tell a real question from a
   * pause or a re-ask of it. Absent on candidate turns and older records.
   */
  kind?: string;
  /**
   * On a 'postponed' sign-off: the candidate has since been invited again, so
   * this sign-off closes a sitting and the conversation starts over after it.
   * Unset while the session is still settling into RESCHEDULE_REQUIRED, when
   * the sign-off is still the current turn. Set by closeSittingForReinvite.
   */
  sittingClosed?: boolean;
  /** For an agent turn: the question it asked, without any lead-in, to put again after a pause. */
  question?: string;
  /** For an agent turn that asked a library question: the entry it came from. */
  libraryEntryId?: string;
  /** For an agent turn: the question form it was stored with, when known (a library question's tag). */
  form?: string;
  /** For an agent turn that asked a library question: the rung of the block's ladder it drew on. */
  rungIndex?: number;
  /** For an agent turn that asked a library question: how it got to that rung. */
  rungMove?: 'start' | 'up' | 'down';
}

export interface EvidenceSpan {
  turnId: string;
  startMs: number;
  endMs: number;
  quote: string;
}

// ---- Assessment ----
export interface CompetencyScore {
  id: string;
  name: string;
  level: Proficiency | null;    // null => Not Enough Evidence
  requiredLevel: Proficiency;
  confidence: number;
  notEnoughEvidence: boolean;
  evidence: EvidenceSpan[];
  rationale: string;
  rubricVersion: string;
  /** True when rubric grading was configured but failed, so no score was produced. */
  gradingUnavailable?: boolean;
}

/**
 * SCORING_UNAVAILABLE is not a verdict on the candidate.
 *
 * It says the instrument failed: every competency that was put to the grader
 * came back ungraded, so there is no score and no recommendation to give. It
 * exists as its own value because the alternative — falling through to the
 * ordinary thresholds with a weighted mean over an empty set — produced
 * "DO_NOT_PROGRESS, 0/100" out of a vendor outage.
 */
export type Recommendation = 'PROCEED' | 'CONSIDER' | 'DO_NOT_PROGRESS' | 'SCORING_UNAVAILABLE';

export interface AssessmentResult {
  assessmentVersion: string;
  roleScorecardVersion: string;
  recommendation: Recommendation;
  confidence: number;
  evidenceCoverage: number;
  /** 0..100, or null when nothing could be graded — never 0 as a stand-in. */
  overallScore: number | null;
  competencies: CompetencyScore[];
  strengths: string[];
  concerns: string[];
  contradictions: string[];
  openQuestions: string[];
  limitations: string[];
  summary: string;
  /**
   * Which of the role's required technologies the interview produced
   * evidence for. Absent on assessments written before roles had a stack.
   */
  techStackCoverage?: TechStackCoverageItem[];
}

export interface TechStackCoverageItem {
  name: string;
  /** familiar | working | strong | expert — the depth the role asked for. */
  level: string;
  evidenced: boolean;
  /** The graded competencies whose evidence named the technology. */
  competencies: string[];
}

// ---- Live interview director signals ----
export interface DirectorSignal {
  nextCompetencyId: string | null;
  action: 'ask' | 'followup' | 'move_on' | 'close';
  depthInstruction: 'increase' | 'hold' | 'decrease';
  timeRemainingMinutes: number;
  coverageState: Record<string, number>; // competencyId -> answered turns count
  reason: string;
}

// ---- Tenant policy ----
export interface TenantPolicy {
  disclosureText: string;
  recordingDefault: boolean;
  retentionDaysRecording: number;
  retentionDaysTranscript: number;
  allowedModules: string[];
  languages: string[];
  humanReviewRequired: boolean;
}
