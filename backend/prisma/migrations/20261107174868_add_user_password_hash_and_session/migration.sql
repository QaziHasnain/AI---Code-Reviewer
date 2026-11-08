-- Add passwordHash column to "User" (required)
ALTER TABLE "User" ADD COLUMN "passwordHash" TEXT NOT NULL;

-- Create "Session" table
CREATE TABLE "Session" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "userId" UUID NOT NULL,
  "tokenHash" VARCHAR(64) NOT NULL UNIQUE,
  "expiresAt" TIMESTAMP WITH TIME ZONE NOT NULL,
  "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  "lastSeenAt" TIMESTAMP WITH TIME ZONE,
  "revokedAt" TIMESTAMP WITH TIME ZONE,
  "userAgent" TEXT,
  "ipHash" VARCHAR(64),
  CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE
);

CREATE INDEX "Session_userId_idx" ON "Session" ("userId");
CREATE INDEX "Session_expiresAt_idx" ON "Session" ("expiresAt");
