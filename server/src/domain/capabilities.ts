// Capability model.
//
// Lives in `domain/` rather than in `services/access.ts` because the middleware
// needs it too, and access.ts imports HttpError from the middleware — putting
// the map there would make that cycle.
//
// A capability answers "may this user perform this KIND of action?". It does
// NOT answer "may they touch THIS object" — that is object scope, in
// services/access.ts. Both are required; either alone leaves a hole.

export type Capability =
  | 'role:create'
  | 'role:edit_scorecard'
  | 'role:approve_scorecard'
  | 'candidate:create'
  | 'candidate:read'
  | 'candidate:erase'
  | 'interview:create'
  | 'interview:invite'
  | 'interview:schedule'
  | 'interview:drive'
  | 'assessment:read'
  | 'assessment:review'
  | 'assessment:export'
  | 'retention:configure'
  | 'audit:read'
  | 'admin:manage';

// A fixed set. `User.role` was a free string whose comment listed five values
// that nothing enforced; an unrecognised role now resolves to NO capabilities
// rather than silently behaving like a recruiter.
export const ROLES = ['recruiter', 'manager', 'reviewer', 'auditor', 'admin'] as const;
export type RoleName = (typeof ROLES)[number];

const CAPABILITIES: Record<RoleName, readonly Capability[]> = {
  // Runs requisitions and the candidates they are assigned. Deliberately cannot
  // approve the scorecard they authored, nor sign off an assessment.
  recruiter: ['role:create', 'role:edit_scorecard', 'candidate:create', 'candidate:read',
    'interview:create', 'interview:invite', 'interview:schedule', 'interview:drive', 'assessment:read'],
  // Hiring manager: approves what the recruiter drafted, and reviews outcomes.
  manager: ['role:create', 'role:edit_scorecard', 'role:approve_scorecard', 'candidate:read',
    'interview:create', 'interview:invite', 'interview:schedule', 'assessment:read', 'assessment:review', 'assessment:export'],
  // Exists so review can be separated from whoever ran the interview.
  reviewer: ['candidate:read', 'assessment:read', 'assessment:review'],
  // Compliance/audit: sees that things happened, not candidate detail.
  auditor: ['audit:read'],
  // Tenant-wide, and every grant is listed explicitly rather than being an
  // invisible bypass inside the permission check.
  admin: ['role:create', 'role:edit_scorecard', 'role:approve_scorecard', 'candidate:create',
    'candidate:read', 'candidate:erase', 'interview:create', 'interview:invite', 'interview:schedule', 'interview:drive',
    'assessment:read', 'assessment:review', 'assessment:export', 'retention:configure',
    'audit:read', 'admin:manage'],
};

export function isRoleName(v: string): v is RoleName {
  return (ROLES as readonly string[]).includes(v);
}

export function capabilitiesOf(role: string): readonly Capability[] {
  return isRoleName(role) ? CAPABILITIES[role] : [];
}
