// Who has to enter a code after their password, per organisation.
//
// It ships DORMANT. Every organisation, new ones included, starts at 'off' and
// an admin turns it on.
//
// That is the owner's call and it is the right one. A default of 'admins' would
// mean that the moment this deploys, the owner's own account starts needing an
// emailed code — before anybody has watched a single code arrive on this
// deployment's mail setup. And if mail turns out not to work, the way back in
// is the platform operator, who is the same person. A security control switched
// on by a deploy, whose failure mode is locking out the one account that could
// fix it, is not a safe default however good the control is.
//
// So the switch and everything behind it is built and tested; the organisation
// chooses the day. Once a code has been seen to arrive, 'admins' is the setting
// worth landing on — an admin account is the one that can add people, change
// roles, read the audit trail and reach candidate data in bulk.
//
// The platform operator is the exception and is asked for a code whenever the
// organisation has switched it on; see codeRequired below.

export const MFA_POLICIES = ['everyone', 'admins', 'off'] as const;
export type MfaPolicy = (typeof MFA_POLICIES)[number];

export const DEFAULT_MFA_POLICY: MfaPolicy = 'off';

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
 * 'off' means off for everyone, the platform operator included. That is what
 * makes "ships dormant" true: an operator override here would mean the deploy
 * itself starts asking the owner for an emailed code, which is precisely the
 * thing shipping dormant exists to avoid — and the owner is also the person the
 * break-glass path runs through, so they are the worst account to lock out
 * before anyone has watched a code arrive.
 *
 * Once an organisation HAS switched it on, the operator is always included and
 * cannot be carved out by role. That is the rule worth keeping: the operator
 * account reaches the shared role catalog and the question library across every
 * organisation, so an organisation choosing 'admins' does not get to decide
 * that the owner signing into it is exempt.
 *
 * The two readings differ only in the 'off' case, and only there does the
 * decision about the owner's own account belong to the owner.
 */
export function codeRequired(input: {
  readonly policy: MfaPolicy;
  readonly role: string;
  readonly platformOperator: boolean;
}): CodeRequirement {
  if (input.policy === 'off') return { required: false, reason: 'not_required' };
  if (input.platformOperator) return { required: true, reason: 'platform_operator' };
  if (input.policy === 'everyone') return { required: true, reason: 'policy' };
  if (ELEVATED_ROLES.has(input.role)) return { required: true, reason: 'role' };
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
