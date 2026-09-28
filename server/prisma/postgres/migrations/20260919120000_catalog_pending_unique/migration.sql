-- Hand-written: Prisma's schema language cannot express a partial index.
-- A backstop against two writers queueing the same pending proposal: at most
-- one PENDING proposal per title, kind, target role and domain. Decided
-- proposals are not constrained, so a title can be proposed again later.
-- scripts/migrationDiff.mjs lists this index so the migration check expects
-- it to be absent from schema.prisma.
CREATE UNIQUE INDEX "CatalogProposal_pending_key" ON "CatalogProposal" ("normalizedTitle", "kind", COALESCE("targetRoleId", ''), COALESCE("domainId", '')) WHERE "status" = 'pending';
