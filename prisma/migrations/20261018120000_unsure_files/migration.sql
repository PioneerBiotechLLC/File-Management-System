-- Files the AI put in General because it found no place for them in the tree.
ALTER TABLE "StoredFile" ADD COLUMN "unsure" BOOLEAN NOT NULL DEFAULT false;
