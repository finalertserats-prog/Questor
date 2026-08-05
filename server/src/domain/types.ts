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
}

export interface InterviewPlan {
  durationMinutes: number;
  language: string;
  modules: string[];
  blocks: PlanBlock[];
  coverageTargets: Record<string, number>; // competencyId -> planned weight
  /**
   * The experience band this interview is pitched at (see engines/experienceBands).
   * Optional so plans persisted before calibration existed still deserialize.
   */
  band?: BandId;
  /** Why that band was chosen, for the audit trail behind the pitch. */
  bandRationale?: string;
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

export type Recommendation = 'PROCEED' | 'CONSIDER' | 'DO_NOT_PROGRESS';

export interface AssessmentResult {
  assessmentVersion: string;
  roleScorecardVersion: string;
  recommendation: Recommendation;
  confidence: number;
  evidenceCoverage: number;
  overallScore: number;         // 0..100
  competencies: CompetencyScore[];
  strengths: string[];
  concerns: string[];
  contradictions: string[];
  openQuestions: string[];
  limitations: string[];
  summary: string;
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
