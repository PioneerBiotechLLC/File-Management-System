-- Trading documents are filed by year, then customers or suppliers, then the company, then the document kind.
CREATE TYPE "PartySide" AS ENUM ('customer', 'supplier');
CREATE TYPE "FolderKind" AS ENUM ('regular', 'year', 'side', 'party', 'doc');

CREATE TABLE "Party" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "side" "PartySide" NOT NULL,
    "name" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "aliases" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Party_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Party_orgId_side_key_key" ON "Party"("orgId", "side", "key");
ALTER TABLE "Party" ADD CONSTRAINT "Party_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Folder" ADD COLUMN "kind" "FolderKind" NOT NULL DEFAULT 'regular';
ALTER TABLE "Folder" ADD COLUMN "year" INTEGER;
ALTER TABLE "Folder" ADD COLUMN "side" "PartySide";
ALTER TABLE "Folder" ADD COLUMN "partyId" TEXT;
ALTER TABLE "Folder" ADD COLUMN "docKind" TEXT;
ALTER TABLE "Folder" ADD CONSTRAINT "Folder_partyId_fkey" FOREIGN KEY ("partyId") REFERENCES "Party"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "StoredFile" ADD COLUMN "suggestedTrading" JSONB;
ALTER TABLE "StoredFile" ADD COLUMN "partyId" TEXT;
ALTER TABLE "StoredFile" ADD CONSTRAINT "StoredFile_partyId_fkey" FOREIGN KEY ("partyId") REFERENCES "Party"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "StoredFile_orgId_partyId_idx" ON "StoredFile"("orgId", "partyId");
