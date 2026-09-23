/**
 * What the signed-in user may do, as the server reports it (GET /auth/me
 * returns the same list requireCapability checks). Buttons and links are
 * hidden or explained with this, so nobody fills in a form that can only end
 * in "permission denied". The server still enforces every one of them.
 */

export type Capability =
  | 'role:create'
  | 'role:read'
  | 'role:edit_scorecard'
  | 'role:approve_scorecard'
  | 'candidate:create'
  | 'candidate:read'
  | 'candidate:erase'
  | 'interview:create'
  | 'interview:read'
  | 'interview:invite'
  | 'interview:schedule'
  | 'interview:drive'
  | 'assessment:read'
  | 'assessment:review'
  | 'assessment:export'
  | 'retention:configure'
  | 'audit:read'
  | 'admin:manage';

export interface CapabilityHolder {
  readonly capabilities?: readonly string[];
}

/**
 * Whether the user holds a capability. A user object without the list comes
 * from an older server; the action is then shown and the server decides, which
 * is how the app behaved before the list existed.
 */
export function can(user: CapabilityHolder | null | undefined, capability: Capability): boolean {
  if (!user) return false;
  if (!user.capabilities) return true;
  return user.capabilities.includes(capability);
}

/** Who holds each capability that is not everyone's, in words for a hint beside a hidden action. */
const WHO_CAN: Partial<Record<Capability, string>> = {
  'role:approve_scorecard': 'a hiring manager or an admin',
  'assessment:review': 'a hiring manager, a reviewer or an admin',
  'candidate:create': 'a recruiter or an admin',
  'interview:create': 'a recruiter, a hiring manager or an admin',
  'interview:schedule': 'a recruiter, a hiring manager or an admin',
  'interview:invite': 'a recruiter, a hiring manager or an admin',
  'interview:drive': 'a recruiter or an admin',
  'admin:manage': 'an admin',
  'audit:read': 'an admin or an auditor',
};

/** "Only a hiring manager or an admin can approve the scorecard." */
export function onlyWhoCan(capability: Capability, action: string): string {
  const who = WHO_CAN[capability] ?? 'someone with permission';
  return `Only ${who} can ${action}.`;
}
