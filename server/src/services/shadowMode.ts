// Shadow mode: a scoring-validity harness AND a compliance safeguard.
//
// WHY THIS EXISTS
// Questor's score is advisory. That framing is what keeps the employer outside
// GDPR Art. 22 ("decision based solely on automated processing") and NYC LL144's
// automated-employment-decision rules — but ONLY while the human review is
// genuinely meaningful. A reviewer who opens the AI's PROCEED/CONSIDER call and
// then agrees with it is anchoring, not reviewing; regulators read that as a
// rubber stamp and treat the pipeline as fully automated.
//
// Shadow mode inverts the order: the reviewer records their own verdict from the
// evidence and transcript BEFORE the AI's conclusions are shown. That single
// change buys two things at once:
//   1. Validity  — the blind human verdict is an independent measurement, so
//                  human/AI agreement actually means something. Agreement
//                  measured after the human saw the AI's answer measures
//                  anchoring, not accuracy.
//   2. Compliance — a documented independent-first review is evidence that human
//                  oversight was real.
//
// WHAT THIS FILE DOES NOT DO
// It MEASURES agreement. It does not establish validity, and no function here
// should ever return a number that flatters the system. When there is no data,
// say so.

// LAYOUT
// This file is the public entry point; callers import from here. The code lives in:
//   shadowModeCommon.ts    — dispositions, status markers, gate constants
//   shadowModeKappa.ts     — Cohen's kappa
//   shadowModeBlind.ts     — the blind view, recording the verdict, reveal gates
//   shadowModeAgreement.ts — the agreement report and the sample it is built from

export {
  AGREEMENT_GATE, BLIND_BYPASS_ACTION, BLIND_REVIEW_STATUS, DISPOSITIONS, MINIMUM_N,
  type Disposition,
} from './shadowModeCommon.js';
export { computeCohenKappa, type KappaResult } from './shadowModeKappa.js';
export {
  assertBlindVerdictRecorded, assertUnblindedReadAllowed, getBlindView, hasUnblindedAccess,
  recordBlindVerdict, SELF_REVIEW_NOTE,
  type BlindAssessmentView, type BlindCompetency, type BlindCompetencyVerdict, type BlindEvidenceSpan,
  type BlindTurn, type BlindVerdictInput,
} from './shadowModeBlind.js';
export {
  computeAgreementReport, getAgreementReport,
  type AgreementReport, type CompetencyBreakdown, type ShadowObservation,
} from './shadowModeAgreement.js';
