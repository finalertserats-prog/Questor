// One-shot backfill of object assignments for data that predates object scoping.
//
// RUN IT WITH (from the `server/` directory):
//
//     npx tsx src/seed/backfillAssignments.ts
//
// or from the repo root:
//
//     npm exec -w server -- tsx src/seed/backfillAssignments.ts
//
// (No npm script is added here — package.json is owned elsewhere. If one is
// added later, `"db:backfill-assignments": "tsx src/seed/backfillAssignments.ts"`
// is the equivalent.)
//
// WHY THIS EXISTS
//
// Object scoping resolves an unassigned object to admin-only. That is the right
// default for new data, but every row created before scoping existed has zero
// assignment rows, so switching scoping on makes the entire existing dataset
// invisible to the people who have been working it. The realistic failure is not
// that someone is blocked — it is that an admin unblocks everyone by handing out
// the admin role, which deletes scoping while leaving it apparently in place.
//
// WHY IT DOES NOT ASSIGN EVERYTHING
//
// The tempting shortcut is to assign every object to every user so nothing
// breaks. That reproduces exactly the exposure this work exists to close, and it
// does so invisibly: nothing looks wrong afterwards. So this script only ever
// infers ownership from evidence that already exists in the data —
// `Role.createdById`, and `Candidate.roleId` — and leaves everything else alone.
// Genuinely unowned objects stay unassigned, which means admin-only: visible to
// someone, reachable by nobody who was not already trusted tenant-wide. The
// printed unassigned queue is the handover, so an admin can grant deliberately.
//
// IDEMPOTENT: the assign helpers upsert on their unique (object, user) pair, so
// running this twice changes nothing the second time.

import { fileURLToPath } from 'node:url';
import { prisma } from '../db.js';
import { assignRole, assignCandidate } from '../services/access.js';

interface BackfillSummary {
  rolesAssigned: number;
  candidatesAssigned: number;
  /** Human-readable reasons, one line per object left alone. */
  unassignedRoles: string[];
  unassignedCandidates: string[];
}

export async function backfillAssignments(): Promise<BackfillSummary> {
  const summary: BackfillSummary = {
    rolesAssigned: 0, candidatesAssigned: 0, unassignedRoles: [], unassignedCandidates: [],
  };

  const roles = await prisma.role.findMany({
    select: { id: true, title: true, tenantId: true, createdById: true },
    orderBy: { createdAt: 'asc' },
  });

  for (const role of roles) {
    if (!role.createdById) {
      summary.unassignedRoles.push(`${role.id} "${role.title}" — no createdById recorded`);
      continue;
    }
    // The creator may have left since. `createdById` is a bare String with no
    // foreign key, so it can outlive the user it names — assigning a dangling id
    // would create a grant that can never be exercised or audited to a person.
    const creator = await prisma.user.findUnique({
      where: { id: role.createdById }, select: { id: true, tenantId: true, email: true },
    });
    if (!creator) {
      summary.unassignedRoles.push(`${role.id} "${role.title}" — creator ${role.createdById} no longer exists`);
      continue;
    }
    // Defensive: a cross-tenant createdById should be impossible, but this script
    // hands out access in bulk, so it verifies rather than assumes. Granting
    // across a tenant boundary here would be the worst possible bug to introduce
    // while closing a data-exposure gap.
    if (creator.tenantId !== role.tenantId) {
      summary.unassignedRoles.push(`${role.id} "${role.title}" — creator belongs to a different tenant, refusing to assign`);
      continue;
    }
    await assignRole(role.id, creator.id, 'owner');
    summary.rolesAssigned += 1;
  }

  // Candidates inherit from their role's owners. Read the assignment rows back
  // (rather than reusing the loop above) so pre-existing grants count too — that
  // is what makes a second run a no-op instead of a narrower re-do.
  const candidates = await prisma.candidate.findMany({
    select: { id: true, fullName: true, roleId: true },
    orderBy: { createdAt: 'asc' },
  });

  const ownersByRole = new Map<string, string[]>();
  async function ownersOf(roleId: string): Promise<string[]> {
    const cached = ownersByRole.get(roleId);
    if (cached) return cached;
    const rows = await prisma.roleAssignment.findMany({
      where: { roleId, relation: 'owner' }, select: { userId: true },
    });
    const owners = rows.map((r) => r.userId);
    ownersByRole.set(roleId, owners);
    return owners;
  }

  for (const candidate of candidates) {
    if (!candidate.roleId) {
      summary.unassignedCandidates.push(`${candidate.id} "${candidate.fullName}" — not linked to a role`);
      continue;
    }
    const owners = await ownersOf(candidate.roleId);
    if (owners.length === 0) {
      summary.unassignedCandidates.push(`${candidate.id} "${candidate.fullName}" — role ${candidate.roleId} has no owner`);
      continue;
    }
    for (const userId of owners) await assignCandidate(candidate.id, userId, 'owner');
    summary.candidatesAssigned += 1;
  }

  return summary;
}

/**
 * The unassigned lists are the point of the output, not a footnote: they are the
 * work queue an admin has to clear, and they are printed in full rather than
 * counted so that "3 candidates nobody owns" cannot be scrolled past.
 */
function report(summary: BackfillSummary): void {
  const lines: string[] = [
    '',
    'Assignment backfill complete.',
    `  Roles assigned to their creator:      ${summary.rolesAssigned}`,
    `  Candidates assigned via their role:   ${summary.candidatesAssigned}`,
    '',
  ];

  const section = (title: string, items: string[]): void => {
    if (items.length === 0) {
      lines.push(`${title}: none`);
      return;
    }
    lines.push(`${title}: ${items.length} (admin-only until assigned deliberately)`);
    for (const item of items) lines.push(`  - ${item}`);
  };

  section('Roles left unassigned', summary.unassignedRoles);
  lines.push('');
  section('Candidates left unassigned', summary.unassignedCandidates);
  lines.push('');
  lines.push('Unassigned objects are visible to admins only. That is the safe default:');
  lines.push('grant them with POST /api/admin/users/:id/roles/:roleId (or /candidates/:candidateId).');
  lines.push('');

  // console, not the app logger: this is an operator-facing CLI report meant to
  // be read on a terminal, not a structured event for log aggregation.
  // eslint-disable-next-line no-console
  console.log(lines.join('\n'));
}

// Only self-execute when run directly, so tests can import and call the function
// without a stray backfill firing as an import side effect.
const isDirectRun = process.argv[1] !== undefined
  && fileURLToPath(import.meta.url) === process.argv[1];

if (isDirectRun) {
  backfillAssignments()
    .then(report)
    .catch((err: unknown) => {
      // eslint-disable-next-line no-console
      console.error('Backfill failed:', err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}
