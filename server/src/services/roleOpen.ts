import { prisma } from '../db.js';
import { HttpError } from '../middleware/index.js';

/**
 * An archived role is closed: no new candidates, interviews or scorecard
 * changes until it is restored through PATCH /api/roles/:id/status, which is
 * audited. Without this, archiving only hid a role from the list.
 */
export async function assertRoleOpen(roleId: string): Promise<void> {
  const role = await prisma.role.findUnique({ where: { id: roleId }, select: { status: true } });
  if (role?.status === 'archived') {
    throw new HttpError(409, 'This role is archived. Restore it before adding candidates, interviews or scorecard changes.', 'role_archived');
  }
}
