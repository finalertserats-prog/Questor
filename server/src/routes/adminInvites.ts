import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { asyncHandler, requireCapability, HttpError } from '../middleware/index.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { isPlatformOperator, isReservedOperatorEmail } from '../middleware/platformOperator.js';
import { ROLES } from '../domain/capabilities.js';
import { inviteUser, pendingInvites, revokeInvite } from '../services/userInvite.js';
import { normalizeEmail } from '../services/userEmail.js';

/**
 * /api/admin/invites — adding a colleague.
 *
 * This is the only way to add one. `POST /api/admin/users` still exists and is
 * still not offered anywhere in the product: it requires the admin to choose
 * the colleague's password, and an admin who can do that can sign in as that
 * person, which makes everything the account then does unattributable. The SME
 * review is built entirely out of attribution — "this named expert recommended
 * this" — so the cheap path is the one that quietly destroys the feature.
 *
 * Authentication, the demo-tenant block and the ordering against `adminRouter`
 * are all handled where this is mounted (app.ts).
 */
export const adminInvitesRouter = Router();

/**
 * Keyed on the inviting user rather than the address.
 *
 * Mounted here rather than in app.ts on purpose: in app.ts it would sit before
 * `authenticate` and key on IP, which throttles a whole office behind one
 * address for the actions of one person. Twenty an hour is far above what
 * adding colleagues looks like and far below what sending mail to a list looks
 * like — the abuse this bounds is an admin account being used to post
 * Questor-branded mail at arbitrary addresses.
 */
const inviteSendLimit = rateLimit({
  name: 'admin-invite', windowMs: 60 * 60_000, max: 20, failClosed: true,
  keyOf: (req) => req.auth?.userId ?? req.ip ?? 'unknown',
});

const inviteSchema = z.object({
  email: z.string().trim().email().transform(normalizeEmail),
  name: z.string().trim().min(1).max(120),
  // z.enum over ROLES, exactly as POST /api/admin/users does: an unrecognised
  // role resolves to NO capabilities, so a typo would mail someone an
  // invitation to an account that is silently powerless rather than refuse the
  // admin's typo while they are still looking at it.
  role: z.enum(ROLES),
});

/** POST /api/admin/invites — mail a colleague a link to set their own password. */
adminInvitesRouter.post('/', requireCapability('admin:manage'), inviteSendLimit, asyncHandler(async (req, res) => {
  const body = inviteSchema.parse(req.body);

  // An account for a platform-owner address makes its holder the owner. Only an
  // owner may create one; to anyone else it looks like an address that is
  // already taken, the same answer POST /api/admin/users gives.
  if (isReservedOperatorEmail(body.email) && !isPlatformOperator(req.auth)) {
    throw new HttpError(409, 'Email already registered');
  }

  const [inviter, tenant] = await Promise.all([
    prisma.user.findUnique({ where: { id: req.auth!.userId }, select: { name: true } }),
    prisma.tenant.findUnique({ where: { id: req.auth!.tenantId }, select: { name: true } }),
  ]);

  const outcome = await inviteUser({
    tenantId: req.auth!.tenantId,
    email: body.email,
    name: body.name,
    role: body.role,
    invitedByUserId: req.auth!.userId,
    invitedByName: inviter?.name ?? 'A colleague',
    organisationName: tenant?.name ?? '',
    requestId: req.requestId,
  });

  if (outcome.kind === 'already_a_user') {
    // Deliberately not "in your organisation". User.email is globally unique,
    // so this collides across tenants too, and naming which one holds it would
    // confirm an address to an outsider.
    throw new HttpError(409, 'Email already registered');
  }
  if (outcome.kind === 'raced') {
    // Two invitations for the same address were being written at the same
    // moment and the database refused one of them, so exactly one link exists.
    // Told rather than retried silently: the other press may have chosen a
    // different role, and an admin who pressed Send twice needs to know which
    // of the two is the one that was sent.
    throw new HttpError(409, 'Another invitation for that address was sent at the same moment. Check the list below before sending again.');
  }
  if (outcome.kind === 'not_delivered') {
    throw new HttpError(503, `We could not email ${body.email}. Nothing was sent; try again shortly.`);
  }

  // The invitation row, never the token. It is not in this response, not in the
  // log and not in the audit record — the colleague's mailbox is the only place
  // it exists, which is the entire point of sending it there.
  res.status(201).json({
    invite: {
      id: outcome.invite.id, name: outcome.invite.name, email: outcome.invite.email,
      role: outcome.invite.role, expiresAt: outcome.invite.expiresAt, createdAt: outcome.invite.createdAt,
      expired: false,
    },
    message: `An invitation is on its way to ${body.email}. They choose their own password from the link.`,
  });
}));

/** GET /api/admin/invites — colleagues who have been invited and have not yet joined. */
adminInvitesRouter.get('/', requireCapability('admin:manage'), asyncHandler(async (req, res) => {
  res.json({ invites: await pendingInvites(req.auth!.tenantId) });
}));

/** DELETE /api/admin/invites/:id — withdraw one. */
adminInvitesRouter.delete('/:id', requireCapability('admin:manage'), asyncHandler(async (req, res) => {
  // Tenant-scoped inside `revokeInvite`, so an admin cannot aim this at another
  // organisation's invitation; a miss answers 404 rather than confirming that
  // the id exists somewhere else.
  const revoked = await revokeInvite(req.auth!.tenantId, req.params.id, req.auth!.userId, req.requestId);
  if (!revoked) throw new HttpError(404, 'Invitation not found');
  res.json({ ok: true, message: 'The invitation no longer works.' });
}));
