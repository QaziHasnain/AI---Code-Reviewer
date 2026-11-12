import { Prisma, PrismaClient } from '@prisma/client';
import { ReviewJobQueue, MAX_REVIEW_JOB_ATTEMPTS, type ClaimedReviewJob } from './job-queue.js';
import { ProviderError, type ReviewProvider } from './provider.js';

interface InputRow { id: string; programmingLanguage: string; sourceCode: string; instructions: string | null }

export function retryDelayMs(attempt: number, retryAfterMs?: number, random = Math.random): number {
  const base = Math.min(60_000, 1_000 * 2 ** Math.max(0, attempt - 1));
  const jittered = Math.floor(base * (0.75 + random() * 0.5));
  return Math.max(jittered, Math.min(retryAfterMs ?? 0, 3_600_000));
}

export class ReviewWorker {
  private stopping = false;
  private active?: Promise<void>;
  constructor(private readonly prisma: PrismaClient, private readonly provider: ReviewProvider, private readonly queue = new ReviewJobQueue(prisma)) {}

  stop(): void { this.stopping = true; }
  async shutdown(): Promise<void> { this.stop(); await this.active; }

  async run(signal?: AbortSignal): Promise<void> {
    while (!this.stopping && !signal?.aborted) {
      try {
        await this.queue.recoverExpiredJobs();
        const job = await this.queue.claimNextJob();
        if (!job) { await new Promise((resolve) => setTimeout(resolve, 500)); continue; }
        this.active = this.process(job);
        try { await this.active; } catch { /* An unpersisted state remains lease-recoverable. */ }
        finally { this.active = undefined; }
      } catch {
        // Keep polling through transient database/queue errors without logging secrets or inputs.
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
    }
  }

  async process(job: ClaimedReviewJob): Promise<void> {
    const started = Date.now();
    try {
      const review = await this.prisma.codeReview.findUnique({ where: { id: job.codeReviewId }, select: { id: true, programmingLanguage: true, sourceCode: true, instructions: true } }) as InputRow | null;
      if (!review) { await this.fail(job, 'REVIEW_INPUT_MISSING'); return; }
      const result = await this.provider.analyze({ language: review.programmingLanguage, sourceCode: review.sourceCode, instructions: review.instructions });
      await this.complete(job, result, Math.max(0, Date.now() - started));
    } catch (error) {
      const providerError = error instanceof ProviderError ? error : new ProviderError('WORKER_UNEXPECTED_ERROR', true);
      if (providerError.retryable && job.attemptCount < MAX_REVIEW_JOB_ATTEMPTS) {
        await this.retry(job, providerError.code, retryDelayMs(job.attemptCount, providerError.retryAfterMs));
      } else await this.fail(job, job.attemptCount >= MAX_REVIEW_JOB_ATTEMPTS && providerError.retryable ? 'MAX_ATTEMPTS_EXCEEDED' : providerError.code);
    }
  }

  private async withLease<T>(job: ClaimedReviewJob, action: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T | null> {
    return this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`SELECT "id" FROM "ReviewJob" WHERE "id" = ${job.id}::uuid AND "status" = 'PROCESSING' AND "leaseToken" = ${job.leaseToken}::uuid AND "leaseExpiresAt" > clock_timestamp() FOR UPDATE`);
      if (!rows.length) return null;
      return action(tx);
    });
  }

  private async complete(job: ClaimedReviewJob, result: Awaited<ReturnType<ReviewProvider['analyze']>>, duration: number): Promise<void> {
    await this.withLease(job, async (tx) => {
      const created = await tx.reviewResult.create({ data: { codeReviewId: job.codeReviewId, outcome: result.review.outcome, score: result.review.score, summary: result.review.summary, detailedAnalysis: result.review.detailedAnalysis ?? null, aiProvider: result.provider, aiModel: result.model, promptTokenUsage: result.promptTokens, completionTokenUsage: result.completionTokens, processingDuration: duration }, select: { id: true } });
      if (result.review.issues.length) await tx.reviewIssue.createMany({ data: result.review.issues.map((issue) => ({ reviewResultId: created.id, title: issue.title, description: issue.description, severity: issue.severity, type: issue.type, filePath: issue.filePath ?? null, lineStart: issue.lineStart ?? null, lineEnd: issue.lineEnd ?? null, startColumn: issue.startColumn ?? null, endColumn: issue.endColumn ?? null, suggestedFix: issue.suggestedFix ?? null })) });
      const reviewChanged = await tx.$executeRaw(Prisma.sql`UPDATE "CodeReview" SET "reviewStatus"='COMPLETED', "completedAt"=clock_timestamp(), "failedAt"=NULL, "failureCode"=NULL, "updatedAt"=clock_timestamp() WHERE "id"=${job.codeReviewId}::uuid AND "reviewStatus"='PROCESSING'`);
      if (reviewChanged !== 1) throw new Error('Review completion state changed');
      const jobChanged = await tx.$executeRaw(Prisma.sql`UPDATE "ReviewJob" SET "status"='SUCCEEDED', "leaseToken"=NULL, "leaseExpiresAt"=NULL, "completedAt"=clock_timestamp(), "lastErrorCode"=NULL, "updatedAt"=clock_timestamp() WHERE "id"=${job.id}::uuid AND "status"='PROCESSING' AND "leaseToken"=${job.leaseToken}::uuid AND "leaseExpiresAt">clock_timestamp()`);
      if (jobChanged !== 1) throw new Error('Review job lease lost');
    });
  }

  private async retry(job: ClaimedReviewJob, code: string, delay: number): Promise<void> {
    await this.withLease(job, async (tx) => {
      const changed = await tx.$executeRaw(Prisma.sql`UPDATE "ReviewJob" SET "status"='RETRY_WAIT', "availableAt"=clock_timestamp()+(${delay} * INTERVAL '1 millisecond'), "leaseToken"=NULL, "leaseExpiresAt"=NULL, "lastErrorCode"=${code}, "updatedAt"=clock_timestamp() WHERE "id"=${job.id}::uuid AND "status"='PROCESSING' AND "leaseToken"=${job.leaseToken}::uuid AND "leaseExpiresAt">clock_timestamp()`);
      if (changed !== 1) throw new Error('Review job lease lost');
      const reviewChanged = await tx.$executeRaw(Prisma.sql`UPDATE "CodeReview" SET "reviewStatus"='SUBMITTED', "updatedAt"=clock_timestamp() WHERE "id"=${job.codeReviewId}::uuid AND "reviewStatus"='PROCESSING'`);
      if (reviewChanged !== 1) throw new Error('Review retry state changed');
    });
  }

  private async fail(job: ClaimedReviewJob, code: string): Promise<void> {
    await this.withLease(job, async (tx) => {
      const changed = await tx.$executeRaw(Prisma.sql`UPDATE "ReviewJob" SET "status"='DEAD', "leaseToken"=NULL, "leaseExpiresAt"=NULL, "completedAt"=clock_timestamp(), "lastErrorCode"=${code}, "updatedAt"=clock_timestamp() WHERE "id"=${job.id}::uuid AND "status"='PROCESSING' AND "leaseToken"=${job.leaseToken}::uuid AND "leaseExpiresAt">clock_timestamp()`);
      if (changed !== 1) throw new Error('Review job lease lost');
      const reviewChanged = await tx.$executeRaw(Prisma.sql`UPDATE "CodeReview" SET "reviewStatus"='FAILED', "failedAt"=clock_timestamp(), "failureCode"=${code}, "updatedAt"=clock_timestamp() WHERE "id"=${job.codeReviewId}::uuid AND "reviewStatus"='PROCESSING'`);
      if (reviewChanged !== 1) throw new Error('Review failure state changed');
    });
  }
}
