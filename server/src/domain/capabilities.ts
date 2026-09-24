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
  | 'admin:manage'
  // The subject-matter expert's two grants, and the one that puts work in front
  // of them. Named apart from `assessment:*` on purpose: an SME's opinion is
  // advice, a reviewer's is a decision the pipeline acts on, and giving the two
  // the same capability name would be the first step towards giving them the
  // same effect.
  | 'sme:assigned_read'
  | 'sme:review'
  | 'sme:assign';

// A fixed set. `User.role` was a free string whose comment listed five values
// that nothing enforced; an unrecognised role now resolves to NO capabilities
// rather than silently behaving like a recruiter.
export const ROLES = ['recruiter', 'manager', 'reviewer', 'auditor', 'admin', 'sme'] as const;
export type RoleName = (typeof ROLES)[number];

const CAPABILITIES: Record<RoleName, readonly Capability[]> = {
  // Runs requisitions and the candidates they are assigned. Deliberately cannot
  // approve the scorecard they authored, nor sign off an assessment.
  recruiter: ['role:create', 'role:read', 'role:edit_scorecard', 'candidate:create', 'candidate:read',
    'interview:create', 'interview:read', 'interview:invite', 'interview:schedule', 'interview:drive', 'assessment:read', 'sme:assign'],
  // Hiring manager: approves what the recruiter drafted, and reviews outcomes.
  manager: ['role:create', 'role:read', 'role:edit_scorecard', 'role:approve_scorecard', 'candidate:read',
    'interview:create', 'interview:read', 'interview:invite', 'interview:schedule', 'assessment:read', 'assessment:review', 'assessment:export',
    'sme:assign'],
  // Exists so review can be separated from whoever ran the interview. No
  // `sme:assign`: choosing who assesses a candidate is running the process, and
  // this role is deliberately only the second opinion on its output.
  reviewer: ['role:read', 'candidate:read', 'interview:read', 'assessment:read', 'assessment:review'],
  // Compliance/audit: sees that things happened, not candidate detail — nor
  // requisition content, which can disclose unannounced hiring.
  auditor: ['audit:read'],
  // The subject-matter expert. Narrower than every role above, and narrower
  // than `reviewer`: not one of the capabilities the rest of the product is
  // gated on, so every existing route refuses them by default and a route added
  // tomorrow cannot open to them by accident. What they may see arrives through
  // /api/sme alone, and only for a candidate they were assigned.
  //
  // Note what is absent: `interview:create` and `interview:schedule` gate
  // POST /api/pipelines/:id/advance and the round endpoints, `assessment:review`
  // gates /finalize and /decision. Those are every way a candidate moves
  // between stages, so "an SME recommendation never moves anyone" is enforced
  // by this list rather than by remembering not to call them.
  sme: ['sme:assigned_read', 'sme:review'],
  // Tenant-wide, and every grant is listed explicitly rather than being an
  // invisible bypass inside the permission check.
  //
  // With one deliberate exception, which is `sme:assigned_read` and
  // `sme:review`. An admin holds `sme:assign` — they decide who is asked — but
  // not the expert's own two, and this is the only place in the map where admin
  // is not a superset. The expert lane is defined by having been assigned a
  // named person, not by power over the tenant, so a tenant-wide grant over it
  // is a contradiction: it would put the admin's own (empty) worklist behind
  // /api/sme and nothing else.
  //
  // It also closes a real hole. `CandidateAssignment` rows outlive a role
  // change, so an expert who is later made an admin would otherwise keep
  // writing recommendations through this lane — with the review attributed to
  // an account that is no longer anybody's subject-matter expert. Withholding
  // the capability ends that for every role at once; an admin reads what the
  // experts said on the hiring team's surface, which is where it belongs.
  admin: ['role:create', 'role:read', 'role:edit_scorecard', 'role:approve_scorecard', 'candidate:create',
    'candidate:read', 'candidate:erase', 'interview:create', 'interview:read', 'interview:invite', 'interview:schedule', 'interview:drive',
    'assessment:read', 'assessment:review', 'assessment:export', 'retention:configure',
    'audit:read', 'admin:manage', 'sme:assign'],
};

export function isRoleName(v: string): v is RoleName {
  return (ROLES as readonly string[]).includes(v);
}

/**
 * A demo sandbox's visitor: a hiring manager who may also add candidates, so
 * the demo can show a pipeline filling up. Not in ROLES, so no admin can grant
 * it to a real account; the admin area is closed to demo tenants separately.
 */
export const DEMO_ROLE = 'demo';
const DEMO_CAPABILITIES: readonly Capability[] = [...CAPABILITIES.manager, 'candidate:create'];

export function capabilitiesOf(role: string): readonly Capability[] {
  if (role === DEMO_ROLE) return DEMO_CAPABILITIES;
  return isRoleName(role) ? CAPABILITIES[role] : [];
}
