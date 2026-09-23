-- The candidates list's state summary: the NEWEST interview per candidate.
--
-- It read every interview in the organisation on every request, whichever page
-- was asked for, and deduplicated 20,000 rows in the application — 582 ms of a
-- 940 ms page at 5,000 candidates / 20,000 interviews
-- (docs/qa/resilience-2026-09-23.md §2.2).
--
-- With this index the database can walk one organisation's interviews in
-- candidate order and take the first row of each run, so what crosses the wire
-- is one row per CANDIDATE rather than one per INTERVIEW.

-- CreateIndex
CREATE INDEX "InterviewSession_tenantId_candidateId_createdAt_idx" ON "InterviewSession"("tenantId", "candidateId", "createdAt");
