-- Technical documents: Technical / <supplier> / <material> / <kind>
ALTER TYPE "FolderKind" ADD VALUE 'tech_root';
ALTER TYPE "FolderKind" ADD VALUE 'tech_party';
ALTER TYPE "FolderKind" ADD VALUE 'material';
ALTER TYPE "FolderKind" ADD VALUE 'tech_doc';

CREATE TABLE "Material" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "partyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "aliases" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Material_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Material_orgId_partyId_key_key" ON "Material"("orgId", "partyId", "key");
ALTER TABLE "Material" ADD CONSTRAINT "Material_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Material" ADD CONSTRAINT "Material_partyId_fkey" FOREIGN KEY ("partyId") REFERENCES "Party"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Folder" ADD COLUMN "materialId" TEXT;
ALTER TABLE "Folder" ADD CONSTRAINT "Folder_materialId_fkey" FOREIGN KEY ("materialId") REFERENCES "Material"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "StoredFile" ADD COLUMN "materialId" TEXT;
CREATE INDEX "StoredFile_orgId_materialId_idx" ON "StoredFile"("orgId", "materialId");
ALTER TABLE "StoredFile" ADD CONSTRAINT "StoredFile_materialId_fkey" FOREIGN KEY ("materialId") REFERENCES "Material"("id") ON DELETE SET NULL ON UPDATE CASCADE;
