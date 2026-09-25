-- Self-serve organisation onboarding, and the business areas an organisation
-- hires in.
--
-- "Business area" reuses the shared role catalog's own "CatalogDomain" rather
-- than inventing a second taxonomy: the same 35 areas the role form already
-- calls "Domain". An organisation picks a few so the catalog it searches is
-- the part it hires in.
--
-- Every existing organisation gets zero rows in "TenantBusinessArea", which
-- means "no choice made": the catalog stays unfiltered for them and nothing
-- about their current roles changes. The limit defaults to 5 for everyone,
-- old and new, and only the platform owner can raise it.

-- AlterTable
ALTER TABLE "Tenant" ADD COLUMN     "businessAreaLimit" INTEGER NOT NULL DEFAULT 5;

-- AlterTable
--
-- Nullable on purpose: a join request and every request made before this
-- migration have no region, size or organisation name of their own, and a
-- default would put a guess in front of the owner as though it were an answer.
ALTER TABLE "SignupRequest" ADD COLUMN     "regionCode" TEXT;
ALTER TABLE "SignupRequest" ADD COLUMN     "orgSize" TEXT;
ALTER TABLE "SignupRequest" ADD COLUMN     "businessAreasJson" TEXT NOT NULL DEFAULT '[]';
ALTER TABLE "SignupRequest" ADD COLUMN     "orgNameKey" TEXT;
ALTER TABLE "SignupRequest" ADD COLUMN     "emailDomain" TEXT;

-- CreateTable
CREATE TABLE "TenantBusinessArea" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "domainId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TenantBusinessArea_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TenantBusinessArea_tenantId_domainId_key" ON "TenantBusinessArea"("tenantId", "domainId");

-- CreateIndex
CREATE INDEX "TenantBusinessArea_tenantId_idx" ON "TenantBusinessArea"("tenantId");

-- CreateIndex
--
-- The abuse checks read "recent requests for this key". Without these they are
-- sequential scans of the whole queue on every public form submission, which
-- is the flood they exist to stop.
--
-- Built without CONCURRENTLY, deliberately. CONCURRENTLY cannot run inside a
-- transaction, and every migration here is applied inside one, so using it
-- would mean a migration this deploy path cannot run. The lock it avoids is
-- also not one worth avoiding on this table: "SignupRequest" holds pending
-- account requests and a cap keeps it in the hundreds, so the build is
-- milliseconds. Revisit if that table ever stops being a short queue.
CREATE INDEX "SignupRequest_orgNameKey_createdAt_idx" ON "SignupRequest"("orgNameKey", "createdAt");

-- CreateIndex
CREATE INDEX "SignupRequest_emailDomain_createdAt_idx" ON "SignupRequest"("emailDomain", "createdAt");

-- AddForeignKey
--
-- Cascade from the tenant: deleting an organisation must not be blocked by the
-- list of areas it browsed. Restrict from the domain: a catalog domain that an
-- organisation is scoped to is retired by "status", never deleted out from
-- under it.
ALTER TABLE "TenantBusinessArea" ADD CONSTRAINT "TenantBusinessArea_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TenantBusinessArea" ADD CONSTRAINT "TenantBusinessArea_domainId_fkey" FOREIGN KEY ("domainId") REFERENCES "CatalogDomain"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
