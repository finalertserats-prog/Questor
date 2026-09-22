-- AlterTable: a built-in block has no library entry; the interleaved trial records both sides.
ALTER TABLE "LibraryUsage" ALTER COLUMN "entryId" DROP NOT NULL,
ADD COLUMN     "competencyId" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "competencyKey" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "trial" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "confusionMarkers" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "rungIndex" INTEGER,
ADD COLUMN     "rungMove" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "blockKey" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "LibraryUsage_interviewSessionId_blockKey_key" ON "LibraryUsage"("interviewSessionId", "blockKey");
