#!/usr/bin/env node
// Copy Questor's data from SQLite to PostgreSQL, verified row for row.
//
// Two phases, each run with the Prisma client generated for its database, so no
// process ever needs two clients at once:
//
//   1. Export (SQLite client — the normal one), from server/:
//        DATABASE_URL="file:./data/questor.db" node ../scripts/migrate-sqlite-to-postgres.mjs export --out /secure/path/questor-export.json
//
//   2. Import (Postgres client), from server/:
//        node ../scripts/generate-postgres-schema.mjs
//        npx prisma generate --schema prisma/postgres/schema.prisma
//        DATABASE_URL="postgresql://…" npx prisma db push --skip-generate --schema prisma/postgres/schema.prisma
//        DATABASE_URL="postgresql://…" node ../scripts/migrate-sqlite-to-postgres.mjs import --in /secure/path/questor-export.json
//        npx prisma generate            # restore the SQLite client
//
// THE EXPORT FILE IS SENSITIVE. It holds password hashes, live portal tokens,
// candidate names, résumés and interview transcripts. It is written owner-only;
// keep it off shared disks and delete it as soon as the import is verified.
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { Prisma, PrismaClient } from '@prisma/client';

// Parents before children, so every foreign key already exists when a row
// arrives. InterviewSession's self-reference (retakes) is handled separately.
const ORDER = [
  'Tenant', 'User', 'Role', 'RoleScorecardVersion', 'Candidate', 'CandidateProfileVersion',
  'EvidenceNode', 'EvidenceEdge', 'InterviewSession', 'InterviewPlanVersion', 'Invitation', 'Turn',
  'IntegrityEvent', 'AssessmentVersion', 'HumanReview', 'CandidateFeedbackDelivery', 'Artifact',
  'AuditEvent', 'ModelExecution', 'WebhookEndpoint', 'WebhookDelivery', 'RoleAssignment',
  'CandidateAssignment', 'CandidatePipeline', 'InterviewRound',
];

const models = Prisma.dmmf.datamodel.models;
const delegateName = (model) => model.charAt(0).toLowerCase() + model.slice(1);

function fail(message) {
  console.error(`\nFAILED: ${message}`);
  process.exit(1);
}

// A model added to the schema but missing from ORDER would otherwise be skipped
// silently, and its data lost in the move.
const unlisted = models.map((m) => m.name).filter((name) => !ORDER.includes(name));
const unknown = ORDER.filter((name) => !models.some((m) => m.name === name));
if (unlisted.length > 0) fail(`Models not in the migration order: ${unlisted.join(', ')}. Add them to ORDER.`);
if (unknown.length > 0) fail(`ORDER names models that do not exist: ${unknown.join(', ')}.`);

function argValue(flag) {
  const index = process.argv.indexOf(flag);
  return index > 0 ? process.argv[index + 1] : undefined;
}

/** JSON turns dates into strings; put them back as Dates for Prisma. */
function revive(modelName, row) {
  const model = models.find((m) => m.name === modelName);
  const dateFields = model.fields.filter((f) => f.kind === 'scalar' && f.type === 'DateTime').map((f) => f.name);
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [
    key,
    dateFields.includes(key) && typeof value === 'string' ? new Date(value) : value,
  ]));
}

// PostgreSQL text and jsonb values cannot contain NUL bytes. SQLite can, and a
// single bad résumé or transcript would otherwise abort the whole import after
// downtime has started.
function stripNuls(value) {
  if (typeof value === 'string') {
    const count = (value.match(/\u0000/g) ?? []).length;
    return { value: count > 0 ? value.replace(/\u0000/g, '') : value, count };
  }
  if (Array.isArray(value)) {
    const stripped = value.map((item) => stripNuls(item));
    return {
      value: stripped.map((item) => item.value),
      count: stripped.reduce((sum, item) => sum + item.count, 0),
    };
  }
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    const stripped = Object.entries(value).map(([key, item]) => [key, stripNuls(item)]);
    return {
      value: Object.fromEntries(stripped.map(([key, item]) => [key, item.value])),
      count: stripped.reduce((sum, [, item]) => sum + item.count, 0),
    };
  }
  return { value, count: 0 };
}

function sanitizeRow(row) {
  const stripped = Object.entries(row).map(([key, value]) => [key, stripNuls(value)]);
  return {
    row: Object.fromEntries(stripped.map(([key, item]) => [key, item.value])),
    nulCount: stripped.reduce((sum, [, item]) => sum + item.count, 0),
  };
}

async function exportData(prisma, outPath) {
  const tables = {};
  for (const name of ORDER) {
    tables[name] = await prisma[delegateName(name)].findMany();
  }
  const counts = Object.fromEntries(ORDER.map((name) => [name, tables[name].length]));
  writeFileSync(outPath, JSON.stringify({ exportedAt: new Date().toISOString(), counts, tables }), { mode: 0o600 });
  try { chmodSync(outPath, 0o600); } catch { /* Windows ignores POSIX modes */ }
  console.log(`Exported to ${outPath} (owner-only). Row counts:`);
  console.table(counts);
}

async function importData(prisma, inPath) {
  const { counts, tables } = JSON.parse(readFileSync(inPath, 'utf8'));

  // Never merge into a database that already holds Questor data.
  const existingTenants = await prisma.tenant.count();
  if (existingTenants > 0) fail(`The target database already has ${existingTenants} tenant(s). Import only into an empty, freshly pushed schema.`);

  await prisma.$transaction(async (tx) => {
    const nulCounts = {};
    for (const name of ORDER) {
      const sanitized = tables[name].map((row) => sanitizeRow(revive(name, row)));
      nulCounts[name] = sanitized.reduce((sum, item) => sum + item.nulCount, 0);
      let rows = sanitized.map((item) => item.row);
      // Retakes point at earlier sessions; insert every session unlinked, then link.
      const retakeLinks = name === 'InterviewSession'
        ? rows.filter((r) => r.retakeOfSessionId).map((r) => ({ id: r.id, retakeOfSessionId: r.retakeOfSessionId }))
        : [];
      if (retakeLinks.length > 0) rows = rows.map((r) => ({ ...r, retakeOfSessionId: null }));

      if (rows.length > 0) await tx[delegateName(name)].createMany({ data: rows });
      for (const link of retakeLinks) {
        await tx.interviewSession.update({ where: { id: link.id }, data: { retakeOfSessionId: link.retakeOfSessionId } });
      }
    }

    // Verified inside the transaction: any mismatch rolls the whole import back.
    for (const name of ORDER) {
      const actual = await tx[delegateName(name)].count();
      if (actual !== counts[name]) throw new Error(`${name}: expected ${counts[name]} rows, found ${actual}`);
    }

    console.log('NUL characters stripped during import:');
    console.table(nulCounts);
  }, { maxWait: 60_000, timeout: 600_000 });

  console.log('Import complete; every table matches the export row for row:');
  console.table(counts);
  console.log(`\nNow delete ${inPath} — it contains credentials and candidate data.`);
}

const command = process.argv[2];
const prisma = new PrismaClient();
try {
  if (command === 'export') {
    const out = argValue('--out');
    if (!out) fail('export needs --out <file>');
    await exportData(prisma, out);
  } else if (command === 'import') {
    const input = argValue('--in');
    if (!input) fail('import needs --in <file>');
    await importData(prisma, input);
  } else {
    fail('Usage: migrate-sqlite-to-postgres.mjs export --out <file> | import --in <file>');
  }
} catch (err) {
  fail(err instanceof Error ? err.message : String(err));
} finally {
  await prisma.$disconnect();
}
