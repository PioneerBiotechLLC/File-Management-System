-- AI spend caps, overridable per company and per member.
ALTER TABLE "Organization" ADD COLUMN "aiDailyUsd" DOUBLE PRECISION, ADD COLUMN "aiMonthlyUsd" DOUBLE PRECISION;
ALTER TABLE "Membership" ADD COLUMN "aiDailyUsd" DOUBLE PRECISION, ADD COLUMN "aiMonthlyUsd" DOUBLE PRECISION;

-- A file is filed only after someone confirms its summary.
ALTER TABLE "StoredFile" ADD COLUMN "summaryConfirmedAt" TIMESTAMP(3), ADD COLUMN "summaryConfirmedBy" TEXT;
