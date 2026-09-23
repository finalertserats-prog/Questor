// Who has to enter a code after their password, per organisation.
//
// The default is "admins" rather than "everyone" because an organisation that
// finds the code step painful will turn it off entirely, and losing it for the
// admins is the loss that matters: an admin account is the one that can add
// people, change roles, read the audit trail and reach candidate data in bulk.
// A default nobody switches off is worth more than a stricter one everybody does.

export const MFA_POLICIES = ['everyone', 'admins', 'off'] as const;
export type MfaPolicy = (typeof MFA_POLICIES)[number];

export const DEFAULT_MFA_POLICY: MfaPolicy = 'admins';

/** The roles a policy of 'admins' covers. */
const ELEVATED_ROLES = new Set(['admin']);

export function isMfaPolicy(value: unknown): value is MfaPolicy {
  return typeof value === 'string' && (MFA_POLICIES as readonly string[]).includes(value);
}

/** The organisation's setting, read out of Tenant.policyJson. */
export function mfaPolicyOf(policy: Record<string, unknown> | null | undefined): MfaPolicy {
  const value = policy?.mfaPolicy;
  return isMfaPolicy(value) ? value : DEFAULT_MFA_POLICY;
}

export interface CodeRequirement {
  readonly required: boolean;
  /** Why, for the audit trail and for what the page says. */
  readonly reason: 'policy' | 'role' | 'platform_operator' | 'not_required';
}

/**
 * Whether this sign-in has to be met with a code.
 *
 * The platform operator is always asked, whatever an organisation has chosen:
 * that account can reach the shared role catalog and the question library, so
 * it is not an organisation's decision to make. An organisation may not turn
 * the code step off for the owner's account by turning it off for their own.
 */
export function codeRequired(input: {
  readonly policy: MfaPolicy;
  readonly role: string;
  readonly platformOperator: boolean;
}): CodeRequirement {
  if (input.platformOperator) return { required: true, reason: 'platform_operator' };
  if (input.policy === 'everyone') return { required: true, reason: 'policy' };
  if (input.policy === 'admins' && ELEVATED_ROLES.has(input.role)) return { required: true, reason: 'role' };
  return { required: false, reason: 'not_required' };
}

/**
 * Whether a trusted device may stand in for the code.
 *
 * The platform owner is asked every time. That account reaches every
 * organisation's shared catalog and the question library, and a browser
 * remembered a week ago says nothing about who is sitting at it now.
 *
 * Escalation is not listed here because it is handled a layer down and more
 * exactly: a grant records the role it was made under, so a recruiter who asked
 * to be remembered and is later made an admin holds a grant that a less
 * powerful account agreed to — and services/trustedDevice.ts refuses it. A rule
 * here would only be able to guess at that.
 */
export function deviceMayStandIn(reason: CodeRequirement['reason']): boolean {
  return reason !== 'platform_operator';
}
