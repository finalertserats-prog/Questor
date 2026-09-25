-- A month of one organisation's outcome statistics, frozen.
--
-- Candidate data is erased, on request and on the retention sweep. That is
-- right, and it also means last quarter's funnel stops being computable once
-- the people in it are gone. This table keeps the aggregate so a trend
-- survives the erasure of what it was computed from.
--
-- It holds counts and rates over a whole organisation-month and nothing about
-- an individual: no candidate id, no session id, no name, no one person's
-- score. It is therefore not personal data, and a candidate erasure neither
-- reads nor writes it — erasure must never be blocked by this table.
--
-- Written only when OUTCOME_SNAPSHOT_ENABLED is on. One row per
-- organisation-month.

-- CreateTable
CREATE TABLE "OutcomeSnapshot" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "month" TEXT NOT NULL,
    "statsJson" TEXT NOT NULL DEFAULT '{}',
    "interviews" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OutcomeSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "OutcomeSnapshot_tenantId_month_key" ON "OutcomeSnapshot"("tenantId", "month");

-- CreateIndex
CREATE INDEX "OutcomeSnapshot_tenantId_month_idx" ON "OutcomeSnapshot"("tenantId", "month");

-- AddForeignKey
ALTER TABLE "OutcomeSnapshot" ADD CONSTRAINT "OutcomeSnapshot_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
