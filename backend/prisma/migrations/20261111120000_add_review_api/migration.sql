-- Add review request metadata needed by the authenticated API.
ALTER TABLE "CodeReview"
    ADD COLUMN "instructions" TEXT,
    ADD COLUMN "completedAt" TIMESTAMP(3),
    ADD COLUMN "failedAt" TIMESTAMP(3),
    ADD COLUMN "failureCode" TEXT;

ALTER TABLE "CodeReview"
    ALTER COLUMN "reviewStatus" SET DEFAULT 'SUBMITTED';

-- The initial migration used startLine/endLine while the Prisma model has
-- lineStart/lineEnd. Keep the model and the recorded database history aligned.
ALTER TABLE "ReviewIssue" RENAME COLUMN "startLine" TO "lineStart";
ALTER TABLE "ReviewIssue" RENAME COLUMN "endLine" TO "lineEnd";

DROP INDEX "CodeReview_userId_createdAt_idx";
CREATE INDEX "CodeReview_userId_createdAt_id_idx" ON "CodeReview"("userId", "createdAt", "id");

CREATE TABLE "ReviewIdempotencyKey" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "key" VARCHAR(128) NOT NULL,
    "requestHash" VARCHAR(64) NOT NULL,
    "codeReviewId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),

    CONSTRAINT "ReviewIdempotencyKey_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ReviewIdempotencyKey_userId_key_key" ON "ReviewIdempotencyKey"("userId", "key");
CREATE INDEX "ReviewIdempotencyKey_codeReviewId_idx" ON "ReviewIdempotencyKey"("codeReviewId");
CREATE INDEX "ReviewIdempotencyKey_expiresAt_idx" ON "ReviewIdempotencyKey"("expiresAt");

ALTER TABLE "ReviewIdempotencyKey"
    ADD CONSTRAINT "ReviewIdempotencyKey_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ReviewIdempotencyKey"
    ADD CONSTRAINT "ReviewIdempotencyKey_codeReviewId_fkey"
    FOREIGN KEY ("codeReviewId") REFERENCES "CodeReview"("id") ON DELETE CASCADE ON UPDATE CASCADE;
