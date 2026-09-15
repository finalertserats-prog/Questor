/**
 * Account administration from the server console.
 *
 * WHY THIS EXISTS
 * `POST /api/admin/users` requires `admin:manage`, and `POST /api/auth/register`
 * mints a user only alongside a BRAND NEW tenant. On an install whose tenant
 * already exists — which is every install after the first five minutes — those
 * two facts close the loop: you cannot create an administrator without already
 * being one, and registering "just to get in" lands you in an empty
 * organisation that cannot see a single existing candidate. The seed script is
 * not the escape hatch either; it wipes, and it refuses to run in production
 * precisely because its password is published.
 *
 * So this is the bootstrap path, and it is deliberately the only thing here
 * that does not go through HTTP. It runs next to the database, with no session
 * and no capability check, because the operating-system account that can read
 * the database file can rewrite it anyway — the control protecting this is
 * filesystem permission (docs/DEPLOYMENT.md Step 1), not a password prompt.
 *
 * It never wipes, never deletes, and never touches candidate data.
 *
 *   npm run users -w server -- list
 *   npm run users -w server -- create --email a@b.com --name "A B" --role admin
 *   npm run users -w server -- reset-password --email a@b.com
 *   npm run users -w server -- set-role --email a@b.com --role manager
 */
import { randomInt } from 'node:crypto';
import { prisma } from '../db.js';
import { hashPassword } from '../services/auth.js';
import { logAudit } from '../services/audit.js';
import { ROLES, isRoleName, capabilitiesOf } from '../domain/capabilities.js';

/** Mirrors the 12-character floor the API enforces on both registration paths. */
const MIN_PASSWORD_LENGTH = 12;

/**
 * Generated passwords are handed over by voice, chat or on paper at least once,
 * so the alphabet omits the characters that get misread doing it: 0/O, 1/l/I,
 * 5/S, 2/Z. Four groups of five from a 29-character set is ~97 bits, which is
 * far past anything bcrypt-and-rate-limiting needs, and still transcribable.
 */
const ALPHABET = 'abcdefghjkmnpqrstuvwxyz346789';

function generatePassword(): string {
  const groups: string[] = [];
  for (let g = 0; g < 4; g++) {
    let chunk = '';
    // randomInt, not Math.random: this value is a credential on a system
    // holding candidate PII.
    for (let i = 0; i < 5; i++) chunk += ALPHABET[randomInt(ALPHABET.length)];
    groups.push(chunk);
  }
  return groups.join('-');
}

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    // A bare `--force` style flag must not swallow the following `--email`.
    out[key] = next && !next.startsWith('--') ? (i++, next) : 'true';
  }
  return out;
}

function fail(message: string): never {
  console.error(`\n✖ ${message}\n`);
  process.exit(1);
}

/**
 * Resolve which organisation to act in.
 *
 * Refuses to guess when there is more than one. Silently picking the first
 * would create an administrator in the wrong tenant — an account that logs in
 * successfully and then shows an empty console, which reads as "the data is
 * gone" rather than "wrong organisation".
 */
async function resolveTenant(explicitId?: string) {
  if (explicitId) {
    const t = await prisma.tenant.findUnique({ where: { id: explicitId } });
    if (!t) fail(`No organisation with id ${explicitId}. Run: npm run users -w server -- list`);
    return t;
  }
  const tenants = await prisma.tenant.findMany({ orderBy: { createdAt: 'asc' } });
  if (tenants.length === 0) {
    fail('This database has no organisation yet. Create the first account and organisation together through POST /api/auth/register, then use this tool.');
  }
  if (tenants.length > 1) {
    console.error('\nMore than one organisation exists. Re-run with --tenant <id>:\n');
    for (const t of tenants) console.error(`  ${t.id}  ${t.name}`);
    console.error('');
    process.exit(1);
  }
  return tenants[0];
}

function announceCredentials(email: string, password: string, url: string): void {
  console.log('\n  ────────────────────────────────────────────────');
  console.log(`   URL       ${url}`);
  console.log(`   Email     ${email}`);
  console.log(`   Password  ${password}`);
  console.log('  ────────────────────────────────────────────────');
  console.log('\n  Stored as a bcrypt hash — this is the only time it can be read.');
  console.log('  Hand it over outside email, and clear it from your scrollback.\n');
}

async function list() {
  const tenants = await prisma.tenant.findMany({ orderBy: { createdAt: 'asc' } });
  for (const t of tenants) {
    const users = await prisma.user.findMany({
      where: { tenantId: t.id },
      select: { email: true, name: true, role: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
    });
    console.log(`\n${t.name}  (${t.id})`);
    if (users.length === 0) {
      console.log('  — no users —');
      continue;
    }
    for (const u of users) {
      // An unrecognised role resolves to zero capabilities, which presents as a
      // user who signs in fine and can then do nothing. Say so here rather than
      // leaving it to be debugged as a permissions bug.
      const broken = isRoleName(u.role) ? '' : '   ⚠ unrecognised role — this account has NO permissions';
      console.log(`  ${u.email.padEnd(34)} ${u.role.padEnd(10)} ${u.name}${broken}`);
    }
  }
  console.log('');
}

async function create(args: Record<string, string>, webOrigin: string) {
  const email = (args.email ?? '').trim().toLowerCase();
  const name = (args.name ?? '').trim();
  const role = (args.role ?? 'admin').trim();

  if (!email.includes('@')) fail('--email is required, and must be an email address.');
  if (!name) fail('--name is required.');
  if (!isRoleName(role)) fail(`--role must be one of: ${ROLES.join(', ')}`);

  const password = args.password ?? generatePassword();
  if (password.length < MIN_PASSWORD_LENGTH) {
    fail(`A password must be at least ${MIN_PASSWORD_LENGTH} characters. Omit --password to have one generated.`);
  }

  // Email is globally unique, not per-tenant, so this collides across
  // organisations too.
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    fail(`${email} already has an account. To give them a new password: npm run users -w server -- reset-password --email ${email}`);
  }

  const tenant = await resolveTenant(args.tenant);
  const user = await prisma.user.create({
    data: { tenantId: tenant.id, email, name, passwordHash: hashPassword(password), role },
    select: { id: true, email: true, role: true },
  });

  await logAudit({
    tenantId: tenant.id, actorType: 'system', actorId: 'cli',
    action: 'user.created', entityType: 'User', entityId: user.id,
    after: { email: user.email, role: user.role },
  });

  console.log(`\n✔ ${role} account created in ${tenant.name}.`);
  announceCredentials(email, password, webOrigin);
  console.log(`  This role can: ${capabilitiesOf(role).join(', ')}\n`);

  if (role !== 'admin') {
    console.log('  Note: this user sees only the roles and candidates they are assigned to.');
    console.log('  Assign them with POST /api/admin/users/:id/roles/:roleId\n');
  }
}

async function resetPassword(args: Record<string, string>, webOrigin: string) {
  const email = (args.email ?? '').trim().toLowerCase();
  if (!email) fail('--email is required.');

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) fail(`No account for ${email}. Run: npm run users -w server -- list`);

  const password = args.password ?? generatePassword();
  if (password.length < MIN_PASSWORD_LENGTH) {
    fail(`A password must be at least ${MIN_PASSWORD_LENGTH} characters. Omit --password to have one generated.`);
  }

  await prisma.user.update({ where: { id: user.id }, data: { passwordHash: hashPassword(password) } });
  await logAudit({
    tenantId: user.tenantId, actorType: 'system', actorId: 'cli',
    action: 'user.password_reset', entityType: 'User', entityId: user.id,
  });

  console.log(`\n✔ New password set for ${user.name}.`);
  announceCredentials(email, password, webOrigin);
  // Sessions are stateless JWTs with no revocation list, so one already issued
  // outlives the password it was issued against. Worth saying out loud when the
  // reason for the reset is a suspected compromise.
  console.log('  Any session already open stays valid until it expires (within the hour).\n');
}

async function setRole(args: Record<string, string>) {
  const email = (args.email ?? '').trim().toLowerCase();
  const role = (args.role ?? '').trim();
  if (!email) fail('--email is required.');
  if (!isRoleName(role)) fail(`--role must be one of: ${ROLES.join(', ')}`);

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) fail(`No account for ${email}.`);

  // Same guard as PATCH /api/admin/users/:id/role. Demoting the last admin
  // locks the organisation out of user management permanently, and nothing
  // short of this tool could grant it back.
  if (user.role === 'admin' && role !== 'admin') {
    const admins = await prisma.user.count({ where: { tenantId: user.tenantId, role: 'admin' } });
    if (admins <= 1) fail('This is the only administrator. Promote someone else first.');
  }

  await prisma.user.update({ where: { id: user.id }, data: { role } });
  await logAudit({
    tenantId: user.tenantId, actorType: 'system', actorId: 'cli',
    action: 'user.role_changed', entityType: 'User', entityId: user.id,
    before: { role: user.role }, after: { role },
  });

  console.log(`\n✔ ${email} is now ${role}.`);
  console.log('  Their current session keeps the old role until it expires (within the hour).\n');
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  const { config } = await import('../config.js');

  switch (command) {
    case 'list': await list(); break;
    case 'create': await create(args, config.webOrigin); break;
    case 'reset-password': await resetPassword(args, config.webOrigin); break;
    case 'set-role': await setRole(args); break;
    default:
      console.log(`
Questor account administration

  npm run users -w server -- list
  npm run users -w server -- create --email <e> --name "<n>" [--role <r>] [--password <p>] [--tenant <id>]
  npm run users -w server -- reset-password --email <e> [--password <p>]
  npm run users -w server -- set-role --email <e> --role <r>

Roles: ${ROLES.join(' · ')}   (default for create: admin)
A password is generated for you unless you pass --password. Minimum ${MIN_PASSWORD_LENGTH} characters.
`);
      if (command) process.exitCode = 1;
  }
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
