-- Bind each user to the Microsoft account that first signed in as them.
ALTER TABLE "AppUser" ADD COLUMN "entraTid" TEXT;
ALTER TABLE "AppUser" ADD COLUMN "entraOid" TEXT;
CREATE UNIQUE INDEX "AppUser_entraTid_entraOid_key" ON "AppUser"("entraTid", "entraOid");

-- Never used: nothing from a file's contents is stored.
ALTER TABLE "StoredFile" DROP COLUMN "extractedText";

-- AI calls reserve an estimated cost until they finish, so parallel calls cannot slip past the caps.
ALTER TABLE "AiUsage" ADD COLUMN "finishedAt" TIMESTAMP(3);
UPDATE "AiUsage" SET "finishedAt" = "createdAt";
