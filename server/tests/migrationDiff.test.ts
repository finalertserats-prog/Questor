import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
// The migration check's own filter, imported so the rule it applies is tested.
import { RAW_SQL_INDEXES, unexpectedMigrationSql } from '../../scripts/migrationDiff.mjs';

/**
 * Some indexes (partial ones) exist only as hand-written SQL, because
 * schema.prisma cannot express them. Prisma's diff from the migrations to the
 * schema therefore always proposes dropping them; the check must tolerate
 * exactly those and nothing else.
 */
describe('the migration check', () => {
  it('ignores the drop of a known hand-written index', () => {
    expect(unexpectedMigrationSql('-- DropIndex\nDROP INDEX "CatalogProposal_pending_key";\n')).toBe('');
  });

  it('still reports any other difference', () => {
    expect(unexpectedMigrationSql('-- DropIndex\nDROP INDEX "CatalogProposal_pending_key";\n\n-- AlterTable\nALTER TABLE "User" ADD COLUMN "x" TEXT;\n')).toContain('ALTER TABLE "User"');
  });

  it('still reports the drop of an index that is not hand-written', () => {
    expect(unexpectedMigrationSql('DROP INDEX "User_email_key";')).toContain('User_email_key');
  });

  it('knows every index a hand-written migration creates', () => {
    const dir = join(process.cwd(), 'prisma', 'postgres', 'migrations');
    const created = readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .flatMap((entry) => readFileSync(join(dir, entry.name, 'migration.sql'), 'utf8').match(/CREATE UNIQUE INDEX "([^"]+)"[^;]*\bWHERE\b/g) ?? [])
      .map((statement) => /"([^"]+)"/.exec(statement)?.[1]);
    expect(created).toEqual([...RAW_SQL_INDEXES]);
  });
});
