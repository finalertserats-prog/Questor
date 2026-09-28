-- Hand-written data migration; the schema is unchanged.
-- Adds the Global catalog region: a role open in every region. The boot seed
-- (server/src/services/catalogSeed.ts) inserts the same row, so whichever runs
-- first wins and the other does nothing. An existing GLOBAL row, including
-- one an owner renamed or retired, is left exactly as it is.
-- Plain INSERT ... ON CONFLICT DO NOTHING, so server/tests/globalRegion.test.ts
-- can run this same statement against SQLite.

INSERT INTO "CatalogRegion" ("id", "code", "name", "sortOrder", "status", "createdAt", "updatedAt")
VALUES ('catalog-region-global', 'GLOBAL', 'Global (all regions)', 0, 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("code") DO NOTHING;
