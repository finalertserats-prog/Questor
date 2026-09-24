-- CreateTable
CREATE TABLE "DemoInterviewRun" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "demoGrantId" TEXT,
    "sessionId" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "scriptId" TEXT NOT NULL DEFAULT '',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "capAt" TIMESTAMP(3) NOT NULL,
    "extendedMs" INTEGER NOT NULL DEFAULT 0,
    "endedAt" TIMESTAMP(3),
    "endReason" TEXT,
    "stage" TEXT NOT NULL DEFAULT 'chose_mode',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DemoInterviewRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DemoFeedback" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "demoGrantId" TEXT,
    "runId" TEXT,
    "mode" TEXT NOT NULL DEFAULT 'none',
    "stage" TEXT NOT NULL DEFAULT 'chose_mode',
    "body" TEXT NOT NULL DEFAULT '',
    "source" TEXT NOT NULL DEFAULT 'typed',
    "injectionFlagged" BOOLEAN NOT NULL DEFAULT false,
    "injectionMatched" TEXT NOT NULL DEFAULT '[]',
    "ticketHash" TEXT NOT NULL,
    "ticketExpiresAt" TIMESTAMP(3) NOT NULL,
    "submittedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DemoFeedback_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DemoModelSpend" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "dayKey" TEXT NOT NULL,
    "fn" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DemoModelSpend_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DemoSpendDay" (
    "dayKey" TEXT NOT NULL,
    "calls" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DemoSpendDay_pkey" PRIMARY KEY ("dayKey")
);

-- CreateIndex
CREATE UNIQUE INDEX "DemoInterviewRun_sessionId_key" ON "DemoInterviewRun"("sessionId");

-- CreateIndex
CREATE INDEX "DemoInterviewRun_tenantId_startedAt_idx" ON "DemoInterviewRun"("tenantId", "startedAt");

-- CreateIndex
CREATE INDEX "DemoInterviewRun_demoGrantId_idx" ON "DemoInterviewRun"("demoGrantId");

-- CreateIndex
CREATE INDEX "DemoInterviewRun_endedAt_capAt_idx" ON "DemoInterviewRun"("endedAt", "capAt");

-- CreateIndex
CREATE UNIQUE INDEX "DemoFeedback_ticketHash_key" ON "DemoFeedback"("ticketHash");

-- CreateIndex
CREATE INDEX "DemoFeedback_tenantId_submittedAt_idx" ON "DemoFeedback"("tenantId", "submittedAt");

-- CreateIndex
CREATE INDEX "DemoFeedback_demoGrantId_idx" ON "DemoFeedback"("demoGrantId");

-- CreateIndex
CREATE INDEX "DemoModelSpend_runId_idx" ON "DemoModelSpend"("runId");

-- CreateIndex
CREATE INDEX "DemoModelSpend_tenantId_idx" ON "DemoModelSpend"("tenantId");

-- AddForeignKey
ALTER TABLE "DemoInterviewRun" ADD CONSTRAINT "DemoInterviewRun_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DemoFeedback" ADD CONSTRAINT "DemoFeedback_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

