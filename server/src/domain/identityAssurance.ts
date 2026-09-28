// Candidate identity assurance: the level an organisation runs at and the
// checks each level switches on. See the Candidate Identity Assurance plan
// (phase 5b.1 builds Standard).
//
// Owner decision 2026-09-22: Standard is on for every organisation and no
// organisation can go below it. There is deliberately no "off" level. Enhanced
// (start photo) and Verified (ID + liveness) are listed so Settings can show
// them as coming later; neither can be chosen until they are built.

export type AssuranceLevel = 'standard' | 'enhanced' | 'verified';

export interface AssuranceLevelInfo {
  readonly id: AssuranceLevel;
  readonly label: string;
  readonly description: string;
  readonly available: boolean;
}

export const ASSURANCE_LEVELS: readonly AssuranceLevelInfo[] = [
  {
    id: 'standard', label: 'Standard', available: true,
    description: 'A one-time code emailed to the applicant before the interview, and one or two questions about specifics on their own CV.',
  },
  {
    id: 'enhanced', label: 'Enhanced', available: false,
    description: 'Standard, plus a single start photo shown to the person running the next round. Coming later.',
  },
  {
    id: 'verified', label: 'Verified', available: false,
    description: 'Enhanced, plus an ID and liveness check through a specialist provider. Coming later.',
  },
];

/** Every organisation runs at this level unless it has chosen a higher one that is available. */
export const DEFAULT_ASSURANCE_LEVEL: AssuranceLevel = 'standard';

/** Tenant policy key the level is stored under. */
export const ASSURANCE_POLICY_KEY = 'identityAssuranceLevel';

export function isSelectableLevel(value: unknown): value is AssuranceLevel {
  return ASSURANCE_LEVELS.some((l) => l.id === value && l.available);
}

/**
 * The level an organisation's policy puts it at. Anything missing, unknown or
 * not yet available reads as the default: a stored value can never switch the
 * checks off or claim a level the product cannot run.
 */
export function assuranceLevelOf(policy: Record<string, unknown>): AssuranceLevel {
  const stored = policy[ASSURANCE_POLICY_KEY];
  return isSelectableLevel(stored) ? stored : DEFAULT_ASSURANCE_LEVEL;
}

export function assuranceLevelLabel(level: AssuranceLevel): string {
  return ASSURANCE_LEVELS.find((l) => l.id === level)?.label ?? level;
}

export interface AssuranceChecks {
  /** L1: a one-time code emailed before the interview. */
  readonly emailCode: boolean;
  /** L3: questions anchored in the candidate's own CV. */
  readonly cvFollowUps: boolean;
}

/** Every level includes Standard's checks; the higher levels add layers not built yet. */
export function checksFor(_level: AssuranceLevel): AssuranceChecks {
  return { emailCode: true, cvFollowUps: true };
}

/**
 * What the candidate's consent recorded about the identity check, stamped on
 * the session's consent at the moment they agreed. Frozen there so a change of
 * setting or of email delivery afterwards cannot move the goalposts on someone
 * already on their way into the interview.
 */
export type IdentityCheckRecord =
  | { readonly level: AssuranceLevel; readonly method: 'email_code'; readonly channel: 'email' }
  | { readonly level: AssuranceLevel; readonly method: 'none'; readonly reason: IdentityCheckSkipReason };

/**
 * Why a code could not be asked for: the deployment does not deliver email,
 * or this is a demo sandbox, whose mail goes only to the visitor.
 */
export type IdentityCheckSkipReason = 'email_not_configured' | 'demo_address';

export function readIdentityCheck(consent: Record<string, unknown>): IdentityCheckRecord | null {
  const raw = consent.identityCheck;
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  const level = isKnownLevel(record.level) ? record.level : DEFAULT_ASSURANCE_LEVEL;
  if (record.method === 'email_code') return { level, method: 'email_code', channel: 'email' };
  if (record.method === 'none') return { level, method: 'none', reason: record.reason === 'demo_address' ? 'demo_address' : 'email_not_configured' };
  return null;
}

function isKnownLevel(value: unknown): value is AssuranceLevel {
  return ASSURANCE_LEVELS.some((l) => l.id === value);
}
