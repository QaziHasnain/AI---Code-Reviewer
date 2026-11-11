-- The confirmed preflight found no existing reviews or results, so no backfill is needed.
CREATE TYPE "ReviewJobStatus" AS ENUM (
    'QUEUED',
    'PROCESSING',
    'RETRY_WAIT',
    'SUCCEEDED',
    'DEAD'
);

CREATE TABLE "ReviewJob" (
    "id" UUID NOT NULL,
    "codeReviewId" UUID NOT NULL,
    "status" "ReviewJobStatus" NOT NULL DEFAULT 'QUEUED',
    "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "leaseToken" UUID,
    "leaseExpiresAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "lastErrorCode" VARCHAR(128),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReviewJob_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ReviewJob_attemptCount_nonnegative" CHECK ("attemptCount" >= 0),
    CONSTRAINT "ReviewJob_lease_fields_consistent" CHECK (("leaseToken" IS NULL) = ("leaseExpiresAt" IS NULL)),
    CONSTRAINT "ReviewJob_processing_requires_lease" CHECK (("status" = 'PROCESSING') = ("leaseToken" IS NOT NULL AND "leaseExpiresAt" IS NOT NULL))
);

CREATE UNIQUE INDEX "ReviewJob_codeReviewId_key" ON "ReviewJob"("codeReviewId");
CREATE INDEX "ReviewJob_status_availableAt_createdAt_idx" ON "ReviewJob"("status", "availableAt", "createdAt");
CREATE INDEX "ReviewJob_status_leaseExpiresAt_idx" ON "ReviewJob"("status", "leaseExpiresAt");

ALTER TABLE "ReviewJob"
    ADD CONSTRAINT "ReviewJob_codeReviewId_fkey"
    FOREIGN KEY ("codeReviewId") REFERENCES "CodeReview"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Preflight confirmed no duplicate result groups; retain the existing lookup index.
CREATE UNIQUE INDEX "ReviewResult_codeReviewId_key" ON "ReviewResult"("codeReviewId");
