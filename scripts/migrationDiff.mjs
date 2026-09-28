// What the Postgres migration check may ignore in Prisma's diff from the
// committed migrations to schema.prisma.
//
// Partial indexes cannot be written in schema.prisma, so they live only in
// hand-written migrations, and Prisma's diff always proposes dropping them.
// Those drops, and only those, are expected. Add an index here in the same
// commit as the migration that creates it (server/tests/migrationDiff.test.ts
// checks the two agree).

export const RAW_SQL_INDEXES = ['CatalogProposal_pending_key'];

function isExpectedDrop(statement) {
  const match = /^DROP INDEX\s+"([^"]+)"\s*;?$/i.exec(statement.trim());
  return match !== null && RAW_SQL_INDEXES.includes(match[1]);
}

/** The diff's SQL with comments, blank lines and expected drops removed. */
export function unexpectedMigrationSql(sql) {
  return sql
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('--') && !isExpectedDrop(line))
    .join('\n')
    .trim();
}
