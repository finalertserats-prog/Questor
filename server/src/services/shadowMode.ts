// Shadow mode: a scoring-validity harness, and a compliance safeguard an
// organisation can switch on (tenant policy `requireBlindReview`).
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
// evidence and transcript BEFORE the AI's conclusions are shown.
//
// WHETHER IT IS REQUIRED IS THE ORGANISATION'S CHOICE
// `requireBlindReview` (tenant policy, default OFF) decides whether an
// unblinded read is refused until a verdict exists. Off, the assessment opens
// at once, "Review the evidence blind" stays an option on the page, and the
// first unblinded read by each reviewer is audited
// (UNBLINDED_READ_ACTION) so the compliance record still shows the order in
// which the two judgements were formed. On, the gate applies as it always did.
// The reveal endpoint is gated either way.
//
// Where it IS used, that single change buys two things at once:
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
  recordBlindVerdict, BLIND_REVIEW_REQUIRED, SELF_REVIEW_NOTE, UNBLINDED_READ_ACTION,
  type BlindAssessmentView, type BlindCompetency, type BlindCompetencyVerdict, type BlindEvidenceSpan,
  type BlindTurn, type BlindVerdictInput,
} from './shadowModeBlind.js';
export {
  computeAgreementReport, getAgreementReport,
  type AgreementReport, type CompetencyBreakdown, type ShadowObservation,
} from './shadowModeAgreement.js';
