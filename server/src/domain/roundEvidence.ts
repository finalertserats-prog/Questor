/**
 * What a human interview round leaves behind, and who may read it.
 *
 * Silver and Gold hold as many rounds as the team wants, each conducted by a
 * person — an SME or a recruiter — in a meeting Questor does not host. Two
 * questions follow from that, and both are answered here rather than inside a
 * route, because both are rules about evidence rather than about HTTP.
 *
 * WHAT THE ROUND HOLDS
 * Questor can hold three records of a human round, and it must never imply a
 * stronger one than it has. `evidenceKindOf` names which it is, so a page — or
 * a certificate — says "the interviewer's written record" when that is all
 * there is, rather than "transcript".
 *
 *   notes       the interviewer's prose account, written afterwards. Always
 *               available and the weakest: it is a summary by the person whose
 *               judgement is the thing being evidenced.
 *   structured  one entry per competency, each claim carrying the words it
 *               rests on. Comparable with an AI assessment, because it is filed
 *               the same way — but the quotes are TYPED FROM RECOLLECTION and
 *               nothing checked them against audio. This module is careful, in
 *               the words it hands the UI, never to let that read as a
 *               recording.
 *   transcript  the AI observer captured the round. Every human round is
 *               observed and nobody is admitted to one without agreeing to be
 *               recorded (domain/observedRound.ts), so this is the ordinary
 *               case at Silver and Gold rather than the rare one — and it is
 *               the only one of the three that is a record of what was said
 *               rather than of what the interviewer made of it.
 *
 * WHO MAY READ IT
 * Two interviewers on the same candidate at the same stage are there to give
 * two readings. A second reader who has already read the first one's notes is
 * not giving a second opinion; they are agreeing with a first. `peerQuarantine`
 * withholds a peer's notes from them until the team has decided, which is the
 * same reasoning as services/shadowMode.ts applies to the AI's conclusion, for
 * the same reason: an opinion formed after reading another's measures
 * anchoring, not judgement.
 */

/** Whether the round holds a transcript, a structured record, prose, or nothing. */
export type RoundEvidenceKind = 'none' | 'notes' | 'structured' | 'transcript';

export interface RoundEvidenceView {
  readonly kind: RoundEvidenceKind;
  /** The short label beside the round. */
  readonly label: string;
  /** The sentence that says exactly what is and is not held. */
  readonly detail: string;
}

const EVIDENCE: Readonly<Record<RoundEvidenceKind, RoundEvidenceView>> = {
  none: {
    kind: 'none',
    label: 'Nothing recorded yet',
    detail: 'This round has not been closed with a record of what it showed.',
  },
  notes: {
    kind: 'notes',
    label: 'Interviewer\'s written account',
    detail: 'What the interviewer wrote after the round, in prose. It is one person\'s account of a '
      + 'conversation nothing else recorded, and it says what they concluded rather than what was said. '
      + 'Nothing here is quoted, so nothing here can be checked.',
  },
  structured: {
    kind: 'structured',
    label: 'Claims with quotes, by competency',
    detail: 'Each claim is filed under a scorecard competency and carries the words it rests on, which is how '
      + 'the AI assessment files its evidence too, so the two can be read side by side. The quotes were typed '
      + 'by the interviewer from what they remember, not transcribed: they are the interviewer\'s record of '
      + 'what was said, not a recording of it.',
  },
  transcript: {
    kind: 'transcript',
    label: 'Transcript of the round',
    detail: 'The AI observer captured this round. Everyone in the room agreed to that before they joined it, so '
      + 'the quotes are the words that were actually said rather than anyone\'s recollection. What the '
      + 'interviewers made of them is still theirs to say; the observer never scores or recommends.',
  },
};

export interface EvidenceInput {
  /** The interviewer's prose account; '' before completion and after retention clears it. */
  readonly notes: string;
  /** How many competency-filed claims-with-quotes the interviewer recorded. */
  readonly structuredCount: number;
  /** The observer's status, or null when nobody opened one. */
  readonly observationStatus: string | null;
  /** How many stretches of the round the observer actually captured. */
  readonly segmentCount: number;
  /**
   * Whether the recording heard one voice only — a headset, almost always
   * (domain/observedRound.ts). Absent on a round recorded before this was
   * measured, which is read as "not known to be", because relabelling old
   * rounds under today's threshold would invent a finding about them.
   */
  readonly oneSided?: boolean;
}

/**
 * Name the record a round holds, always at the STRONGEST thing it actually has
 * and never above it.
 *
 * A transcript counts only once the observer has ENDED with something captured:
 * a consented observer that heard nothing, or one still running, is not
 * evidence of anything, and offering it as "transcript" on a completed round
 * would overstate what the round produced — which is precisely the failure the
 * certificate's "Evidence of process, not a recommendation" exists to avoid.
 */
export function evidenceKindOf(input: EvidenceInput): RoundEvidenceKind {
  // A one-sided recording is NOT a transcript, and this is the line that stops
  // it being read as one. What the device captured is the interviewer talking;
  // the candidate is missing from it entirely, and nothing downstream — a
  // scorecard, a certificate, the transcript-read gate — may treat a record of
  // one person as evidence of what two people said. It falls through to the
  // interviewer's own account below, which is what it actually is.
  if (input.observationStatus === 'ENDED' && input.segmentCount > 0 && input.oneSided !== true) return 'transcript';
  if (input.structuredCount > 0) return 'structured';
  return input.notes.trim().length > 0 ? 'notes' : 'none';
}

export function evidenceView(kind: RoundEvidenceKind): RoundEvidenceView {
  return EVIDENCE[kind];
}

// ---------------------------------------------------------------------------
// Peer quarantine

export const PEER_NOTES_WITHHELD =
  'You are interviewing this candidate at this stage yourself, so another interviewer\'s record of their own '
  + 'round stays closed until the hiring team has decided. Two readings are only worth having while neither '
  + 'was formed from the other.';

/** One round of a candidate's pipeline, as the quarantine rules need to see it. */
export interface PipelineRoundRef {
  readonly id: string;
  readonly stageKey: string;
  readonly conductedBy: string;
  /** The Questor users seated on it; a typed name is nobody for this purpose. */
  readonly panelUserIds: readonly string[];
  /** Whether it has a record to be anchored by at all. */
  readonly hasNotes: boolean;
}

export interface QuarantineInput {
  /** The round being read. */
  readonly round: { readonly id: string; readonly stageKey: string; readonly conductedBy: string };
  /** The reader. */
  readonly viewerUserId: string;
  /**
   * True for someone who decides — assessment:review. The quarantine exists to
   * protect the independence of the opinions HR weighs up, so it must never be
   * applied to HR: a decider who cannot read the evidence cannot decide on it,
   * and would simply ask a colleague to read it out.
   */
  readonly viewerDecides: boolean;
  /** Every round on this pipeline, with the Questor users seated on each. */
  readonly rounds: readonly PipelineRoundRef[];
  /** The pipeline's state, which is how "the team has decided" is read. */
  readonly pipeline: { readonly status: string; readonly currentStageKey: string };
}

export interface QuarantineResult {
  readonly withheld: boolean;
  /** Why, in words a recruiter can act on; '' when nothing is withheld. */
  readonly reason: string;
}

const OPEN: QuarantineResult = { withheld: false, reason: '' };

/**
 * Whether this reader must be kept from this round's notes and transcript.
 *
 * Deliberately narrow. It bites only someone who is themselves seated on
 * ANOTHER round at the SAME stage for this candidate — a second SME, a second
 * recruiter — and only while the candidate is still sitting at that stage with
 * no decision recorded. A colleague who is merely assigned the candidate and
 * conducting nothing reads everything, as they always did; widening it to them
 * would be a different feature (and would break the people who staff the stage
 * without sitting in the room).
 *
 * "The team has decided" is read as the pipeline having left the stage or
 * closed. Both are a person's action — nothing in the process moves a candidate
 * out of a human-interview stage on its own — so the gate can only ever be
 * opened by a decision, never by the passage of time.
 */
export function peerQuarantine(input: QuarantineInput): QuarantineResult {
  if (input.viewerDecides) return OPEN;
  if (input.round.conductedBy !== 'HUMAN') return OPEN;

  const thisRound = input.rounds.find((r) => r.id === input.round.id);
  // Their own round: always theirs to read. They wrote it.
  if (thisRound?.panelUserIds.includes(input.viewerUserId)) return OPEN;

  const sitsOnAPeerRound = input.rounds.some((r) =>
    r.id !== input.round.id && r.stageKey === input.round.stageKey && r.panelUserIds.includes(input.viewerUserId));
  if (!sitsOnAPeerRound) return OPEN;

  const decided = input.pipeline.status !== 'ACTIVE' || input.pipeline.currentStageKey !== input.round.stageKey;
  return decided ? OPEN : { withheld: true, reason: PEER_NOTES_WITHHELD };
}

/**
 * Whether a PEER round's record at this same stage was readable by the person
 * writing this one, at the moment they wrote it.
 *
 * Asked about the peers, never about their own round — their own is always
 * theirs to read, so asking `peerQuarantine` about it would answer "visible"
 * for everybody and the field would say nothing. False when there is no peer
 * record to be anchored by, which is the honest reading of "saw none".
 *
 * Stored on the round rather than inferred later: the policy and the pipeline's
 * position both move on, and a record of independence that can be recomputed
 * under tomorrow's rules is a record of tomorrow's rules, not of what happened.
 */
export function peerNotesWereVisible(input: QuarantineInput): boolean {
  const peers = input.rounds.filter((r) =>
    r.id !== input.round.id && r.stageKey === input.round.stageKey && r.hasNotes);
  return peers.some((peer) => !peerQuarantine({ ...input, round: peer }).withheld);
}

// ---------------------------------------------------------------------------
// The structured record

/** A claim the interviewer made, filed under a competency, with the words it rests on. */
export interface RoundEvidenceEntry {
  readonly competencyId: string;
  /** Resolved from the scorecard at write time, never taken from the client. */
  readonly competencyName: string;
  /** What the interviewer concluded about this competency. */
  readonly claim: string;
  /** What the candidate said that the claim rests on, as the interviewer heard it. */
  readonly quote: string;
}

export const MAX_EVIDENCE_ENTRIES = 20;
export const MIN_CLAIM_CHARS = 10;
export const MIN_QUOTE_CHARS = 10;
export const MAX_ENTRY_CHARS = 2000;

export interface EvidenceEntryInput {
  readonly competencyId: string;
  readonly claim: string;
  readonly quote: string;
}

export type EvidenceCheck =
  | { readonly ok: true; readonly entries: readonly RoundEvidenceEntry[] }
  | { readonly ok: false; readonly problem: string };

/**
 * Check a structured record before it is stored.
 *
 * Three refusals, each closing a way the record could end up looking like
 * evidence while containing none:
 *
 *   an unknown competency — a claim filed under something the role is not
 *     assessed on cannot be compared with the AI's reading of the same
 *     scorecard, which is the entire reason for filing it this way;
 *   one competency twice — two claims under one heading read as one finding
 *     with two supports, and a reader cannot tell which quote belongs to which;
 *   a quote that merely repeats the claim — the failure this product exists to
 *     prevent. Pasting a conclusion into the quote box produces a record whose
 *     every claim is "supported", and nothing in it is.
 */
export function checkEvidenceEntries(
  input: readonly EvidenceEntryInput[],
  competencies: readonly { readonly id: string; readonly name: string }[],
): EvidenceCheck {
  if (input.length > MAX_EVIDENCE_ENTRIES) {
    return { ok: false, problem: `Record at most ${MAX_EVIDENCE_ENTRIES} competencies for one round.` };
  }
  const names = new Map(competencies.map((c) => [c.id, c.name]));
  const seen = new Set<string>();
  const entries: RoundEvidenceEntry[] = [];
  for (const raw of input) {
    const name = names.get(raw.competencyId);
    if (name === undefined) {
      return { ok: false, problem: 'One of the competencies is not on this role\'s approved scorecard.' };
    }
    if (seen.has(raw.competencyId)) {
      return { ok: false, problem: `You have recorded ${name} twice. Put everything about one competency in a single entry.` };
    }
    seen.add(raw.competencyId);

    const claim = raw.claim.trim();
    const quote = raw.quote.trim();
    if (claim.length < MIN_CLAIM_CHARS) return { ok: false, problem: `Say what ${name} showed.` };
    if (quote.length < MIN_QUOTE_CHARS) {
      return { ok: false, problem: `Quote what the candidate said about ${name}. A claim with nothing under it is not evidence.` };
    }
    if (claim.length > MAX_ENTRY_CHARS || quote.length > MAX_ENTRY_CHARS) {
      return { ok: false, problem: `Keep each claim and quote under ${MAX_ENTRY_CHARS} characters.` };
    }
    if (claim.toLowerCase() === quote.toLowerCase()) {
      return {
        ok: false,
        problem: `The quote for ${name} repeats your claim. The quote is what the candidate said; the claim is what you made of it.`,
      };
    }
    entries.push({ competencyId: raw.competencyId, competencyName: name, claim, quote });
  }
  return { ok: true, entries };
}

/** Read a stored record back, dropping anything that is no longer the right shape. */
export function parseEvidenceEntries(value: unknown): RoundEvidenceEntry[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((row) => {
    if (typeof row !== 'object' || row === null) return [];
    const { competencyId, competencyName, claim, quote } = row as Record<string, unknown>;
    const strings = [competencyId, competencyName, claim, quote];
    return strings.every((v) => typeof v === 'string' && v.length > 0)
      ? [{ competencyId, competencyName, claim, quote } as RoundEvidenceEntry]
      : [];
  });
}
