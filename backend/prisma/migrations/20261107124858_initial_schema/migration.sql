-- CreateEnum
CREATE TYPE "ProgrammingLanguage" AS ENUM ('TYPESCRIPT', 'JAVASCRIPT', 'PYTHON', 'JAVA', 'CPP', 'CSHARP', 'GO', 'RUST', 'RUBY', 'PHP', 'SWIFT', 'KOTLIN', 'R', 'MATLAB', 'SCALA', 'HASKELL', 'ELM', 'OCAML', 'PERL', 'LUA', 'DART');

-- CreateEnum
CREATE TYPE "ReviewStatus" AS ENUM ('PENDING', 'SUBMITTED', 'PROCESSING', 'COMPLETED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ReviewOutcome" AS ENUM ('PASS', 'FAIL', 'NEEDS_REVIEW');

-- CreateEnum
CREATE TYPE "IssueSeverity" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');

-- CreateEnum
CREATE TYPE "IssueType" AS ENUM ('SECURITY', 'PERFORMANCE', 'STYLE', 'LOGIC', 'TYPE_SAFETY', 'DOCUMENTATION', 'TESTING', 'MAINTAINABILITY');

-- CreateEnum
CREATE TYPE "IssueStatus" AS ENUM ('OPEN', 'FIXED', 'IGNORED');

-- CreateTable
CREATE TABLE "User" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CodeReview" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "sourceCode" TEXT NOT NULL,
    "programmingLanguage" "ProgrammingLanguage" NOT NULL,
    "reviewStatus" "ReviewStatus" NOT NULL DEFAULT 'PENDING',
    "repository" TEXT,
    "branch" TEXT,
    "commitHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CodeReview_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReviewResult" (
    "id" UUID NOT NULL,
    "codeReviewId" UUID NOT NULL,
    "outcome" "ReviewOutcome" NOT NULL,
    "score" INTEGER NOT NULL,
    "summary" TEXT NOT NULL,
    "detailedAnalysis" TEXT,
    "aiProvider" TEXT NOT NULL,
    "aiModel" TEXT NOT NULL,
    "promptTokenUsage" INTEGER NOT NULL,
    "completionTokenUsage" INTEGER NOT NULL,
    "processingDuration" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReviewResult_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReviewIssue" (
    "id" UUID NOT NULL,
    "reviewResultId" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "severity" "IssueSeverity" NOT NULL,
    "type" "IssueType" NOT NULL,
    "status" "IssueStatus" NOT NULL DEFAULT 'OPEN',
    "filePath" TEXT,
    "startLine" INTEGER,
    "endLine" INTEGER,
    "startColumn" INTEGER,
    "endColumn" INTEGER,
    "suggestedFix" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReviewIssue_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "CodeReview_userId_createdAt_idx" ON "CodeReview"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "ReviewResult_codeReviewId_createdAt_idx" ON "ReviewResult"("codeReviewId", "createdAt");

-- CreateIndex
CREATE INDEX "ReviewIssue_reviewResultId_severity_idx" ON "ReviewIssue"("reviewResultId", "severity");

-- AddForeignKey
ALTER TABLE "CodeReview" ADD CONSTRAINT "CodeReview_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReviewResult" ADD CONSTRAINT "ReviewResult_codeReviewId_fkey" FOREIGN KEY ("codeReviewId") REFERENCES "CodeReview"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReviewIssue" ADD CONSTRAINT "ReviewIssue_reviewResultId_fkey" FOREIGN KEY ("reviewResultId") REFERENCES "ReviewResult"("id") ON DELETE CASCADE ON UPDATE CASCADE;
