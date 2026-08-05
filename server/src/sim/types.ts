import type { BandId } from './bands.js';
import type { PeerId } from './peers.js';
import type { RoleSpec } from './roleFactory.js';
import type { CandidateSpec } from './candidateFactory.js';

/** Who conducted the interview. `questor` is the engine under test. */
export type Interviewer = PeerId | 'questor';

export interface SimTurn {
  speaker: 'interviewer' | 'candidate';
  text: string;
  /**
   * The engine's own label for the turn ('disclosure', 'question', 'followup',
   * 'work_sample', 'signoff', …). Lane A records it; Lane B has no equivalent
   * and leaves it undefined. Blinding uses it to drop the consent opening, which
   * only one lane produces.
   */
  kind?: string;
}

export interface SimAssessment {
  recommendation: string;
  confidence: number;
  evidenceCoverage: number;
}

export interface SimTranscript {
  /** `questor` = Lane A (the engine under test); `peer` = Lane B (the benchmark). */
  lane: 'questor' | 'peer';
  interviewer: Interviewer;
  candidatePeer: PeerId;
  role: RoleSpec;
  candidate: CandidateSpec;
  turns: SimTurn[];
  /** Only Lane A produces one — Lane B is a conversation, not a scoring system. */
  assessment?: SimAssessment;
  /** The candidate withdrew, a safety stop fired, or the lane broke. */
  endedEarly: boolean;
  error?: string;
  /** Wall-clock, so a sweep can report what it cost in time. */
  durationMs: number;
}

/** What the harness is trying to measure, per interview. */
export interface JudgeVerdict {
  /** Band the questions were actually pitched at, as read from the transcript. */
  pitchedBand: BandId;
  /** 0-10 per dimension. */
  calibration: number;
  engagement: number;
  evidenceYield: number;
  fairness: number;
  /** Concrete quotes backing the scores, so a verdict can be checked. */
  notes: string[];
  /** Questions the judge considered wrong for the candidate's level. */
  misfitQuestions: string[];
}
