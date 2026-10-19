-- AlterTable
ALTER TABLE "StoredFile" ADD COLUMN     "aiBatchId" TEXT,
ADD COLUMN     "batchQueuedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "AiBatch" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "anthropicId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'submitting',
    "model" TEXT NOT NULL,
    "fileCount" INTEGER NOT NULL DEFAULT 0,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "checkedAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "error" TEXT,

    CONSTRAINT "AiBatch_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AiBatch_anthropicId_key" ON "AiBatch"("anthropicId");

-- CreateIndex
CREATE INDEX "AiBatch_orgId_status_idx" ON "AiBatch"("orgId", "status");

-- CreateIndex
CREATE INDEX "StoredFile_orgId_batchQueuedAt_idx" ON "StoredFile"("orgId", "batchQueuedAt");

-- CreateIndex
CREATE INDEX "StoredFile_aiBatchId_idx" ON "StoredFile"("aiBatchId");

-- AddForeignKey
ALTER TABLE "StoredFile" ADD CONSTRAINT "StoredFile_aiBatchId_fkey" FOREIGN KEY ("aiBatchId") REFERENCES "AiBatch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiBatch" ADD CONSTRAINT "AiBatch_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

