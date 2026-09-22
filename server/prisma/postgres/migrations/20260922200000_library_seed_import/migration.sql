-- Offline seed imports (server/src/library/seedImport.ts). Additive only.

-- AlterTable
ALTER TABLE "LibraryEntry" ADD COLUMN     "contentHash" TEXT,
ADD COLUMN     "provenanceJson" TEXT NOT NULL DEFAULT '{}';

-- CreateIndex
CREATE UNIQUE INDEX "LibraryEntry_contentHash_key" ON "LibraryEntry"("contentHash");
