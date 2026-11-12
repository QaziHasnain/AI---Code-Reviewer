import { randomUUID } from 'node:crypto';
import { describe, expect, it, beforeAll, afterAll, afterEach } from 'vitest';
import type { Prisma, PrismaClient } from '@prisma/client';
import { ReviewJobQueue } from '@/reviews/job-queue.js';
import { assertDedicatedTestDatabase } from '../security/database-safety.js';

const shouldRun = process.env.RUN_REVIEW_DB_INTEGRATION_TESTS === 'true'
  && Boolean(process.env.TEST_DATABASE_URL);

describe.skipIf(!shouldRun)('ReviewJobQueue PostgreSQL integration', () => {
  let prisma: PrismaClient;
  let queue: ReviewJobQueue;
  let userId: string;

  async function createQueuedJob() {
    const review = await prisma.codeReview.create({
      data: {
        userId,
        sourceCode: `const value = '${randomUUID()}';`,
        programmingLanguage: 'TYPESCRIPT',
      },
      select: { id: true },
    });
    const job = await prisma.reviewJob.create({ data: { codeReviewId: review.id } });
    return { reviewId: review.id, jobId: job.id };
  }

  beforeAll(async () => {
    if (process.env.DATABASE_URL) throw new Error('Review job integration refused: DATABASE_URL is present');
    if (!process.env.TEST_DATABASE_URL) throw new Error('Review job integration requires TEST_DATABASE_URL');
    const testDatabaseUrl = process.env.TEST_DATABASE_URL;
    process.env.DATABASE_URL = '';
    const { PrismaClient } = await import('@prisma/client');
    prisma = new PrismaClient({ datasources: { db: { url: testDatabaseUrl } } });
    delete process.env.DATABASE_URL;
    await assertDedicatedTestDatabase(prisma);
    queue = new ReviewJobQueue(prisma);
    const user = await prisma.user.create({
      data: {
        name: 'Review job integration user',
        email: `review-job-${randomUUID()}@example.test`,
        passwordHash: 'integration-test-only',
      },
      select: { id: true },
    });
    userId = user.id;
  });

  afterAll(async () => {
    if (userId) await prisma.user.delete({ where: { id: userId } });
    await prisma?.$disconnect();
  });

  afterEach(async () => {
    if (!userId) return;
    await prisma.codeReview.deleteMany({ where: { userId } });
  });

  it('claims a due job once across concurrent independent transactions', async () => {
    const { reviewId, jobId } = await createQueuedJob();
    const claims = await Promise.all([queue.claimNextJob(), queue.claimNextJob()]);
    const successful = claims.filter((claim) => claim !== null);
    expect(successful).toHaveLength(1);
    expect(successful[0]).toMatchObject({ id: jobId, codeReviewId: reviewId, attemptCount: 1 });
    expect(await prisma.reviewJob.count({ where: { id: jobId, status: 'PROCESSING' } })).toBe(1);
    expect(await prisma.codeReview.count({ where: { id: reviewId, reviewStatus: 'PROCESSING' } })).toBe(1);
    expect(claims.filter((claim) => claim === null)).toHaveLength(1);
  });

  it('increments attempts for each claim and advances the review status', async () => {
    const { reviewId, jobId } = await createQueuedJob();
    const first = await queue.claimNextJob();
    expect(first).toMatchObject({ id: jobId, attemptCount: 1 });
    await prisma.reviewJob.update({ where: { id: jobId }, data: { leaseExpiresAt: new Date(0) } });
    await expect(queue.recoverExpiredJobs()).resolves.toEqual({ retried: 1, dead: 0 });
    const second = await queue.claimNextJob();
    expect(second).toMatchObject({ id: jobId, attemptCount: 2 });
    expect(second?.leaseToken).not.toBe(first?.leaseToken);
    expect(await prisma.codeReview.findUniqueOrThrow({ where: { id: reviewId } })).toMatchObject({ reviewStatus: 'PROCESSING' });
  });

  it('renews a valid lease and rejects wrong-token and expired renewals', async () => {
    const { jobId } = await createQueuedJob();
    const claim = await queue.claimNextJob();
    expect(claim?.id).toBe(jobId);
    await expect(queue.renewLease(jobId, randomUUID())).resolves.toEqual({ renewed: false, reason: 'LEASE_LOST' });
    await expect(queue.renewLease(jobId, claim!.leaseToken)).resolves.toMatchObject({ renewed: true });
    await prisma.reviewJob.update({ where: { id: jobId }, data: { leaseExpiresAt: new Date(0) } });
    await expect(queue.renewLease(jobId, claim!.leaseToken)).resolves.toEqual({ renewed: false, reason: 'LEASE_LOST' });
  });

  it('recovers expired leases but leaves unexpired leases untouched', async () => {
    const expired = await createQueuedJob();
    const active = await createQueuedJob();
    const [expiredClaim, activeClaim] = await Promise.all([queue.claimNextJob(), queue.claimNextJob()]);
    expect([expiredClaim?.id, activeClaim?.id]).toContain(expired.jobId);
    expect([expiredClaim?.id, activeClaim?.id]).toContain(active.jobId);
    await prisma.reviewJob.update({ where: { id: expired.jobId }, data: { leaseExpiresAt: new Date(0) } });

    await expect(queue.recoverExpiredJobs(10)).resolves.toEqual({ retried: 1, dead: 0 });
    expect(await prisma.reviewJob.findUniqueOrThrow({ where: { id: expired.jobId } })).toMatchObject({ status: 'RETRY_WAIT', leaseToken: null, leaseExpiresAt: null });
    expect(await prisma.codeReview.findUniqueOrThrow({ where: { id: expired.reviewId } })).toMatchObject({ reviewStatus: 'SUBMITTED' });
    expect(await prisma.reviewJob.findUniqueOrThrow({ where: { id: active.jobId } })).toMatchObject({ status: 'PROCESSING' });
  });

  it('makes recovery concurrent-safe and fences stale workers after reclaim', async () => {
    const { jobId } = await createQueuedJob();
    const oldClaim = await queue.claimNextJob();
    expect(oldClaim?.id).toBe(jobId);
    await prisma.reviewJob.update({ where: { id: jobId }, data: { leaseExpiresAt: new Date(0) } });

    const recoveries = await Promise.all([queue.recoverExpiredJobs(1), queue.recoverExpiredJobs(1)]);
    expect(recoveries.reduce((sum, result) => sum + result.retried + result.dead, 0)).toBe(1);
    const newClaim = await queue.claimNextJob();
    expect(newClaim?.leaseToken).not.toBe(oldClaim?.leaseToken);
    await expect(queue.renewLease(jobId, oldClaim!.leaseToken)).resolves.toEqual({ renewed: false, reason: 'LEASE_LOST' });
  });

  it('marks a fifth expired claim DEAD and the review FAILED', async () => {
    const { reviewId, jobId } = await createQueuedJob();
    const claim = await queue.claimNextJob();
    expect(claim?.id).toBe(jobId);
    await prisma.reviewJob.update({
      where: { id: jobId },
      data: { attemptCount: 5, leaseExpiresAt: new Date(0) },
    });

    await expect(queue.recoverExpiredJobs()).resolves.toEqual({ retried: 0, dead: 1 });
    expect(await prisma.reviewJob.findUniqueOrThrow({ where: { id: jobId } })).toMatchObject({
      status: 'DEAD', leaseToken: null, leaseExpiresAt: null, lastErrorCode: 'MAX_ATTEMPTS_EXCEEDED',
    });
    expect(await prisma.codeReview.findUniqueOrThrow({ where: { id: reviewId } })).toMatchObject({
      reviewStatus: 'FAILED', failureCode: 'MAX_ATTEMPTS_EXCEEDED',
    });
  });

  it('rolls back a claim if the paired review transition fails', async () => {
    const { jobId } = await createQueuedJob();
    const failingQueue = new ReviewJobQueue({
      $transaction: (callback: (tx: Prisma.TransactionClient) => Promise<unknown>) => prisma.$transaction((transaction) => {
        const wrapped = new Proxy(transaction, {
          get(target, property, receiver) {
            if (property === '$executeRaw') return async () => { throw new Error('forced review update failure'); };
            return Reflect.get(target, property, receiver);
          },
        });
        return callback(wrapped);
      }),
    } as unknown as PrismaClient);

    await expect(failingQueue.claimNextJob()).rejects.toThrow('forced review update failure');
    expect(await prisma.reviewJob.count({ where: { id: jobId, status: 'QUEUED', attemptCount: 0 } })).toBe(1);
  });
});
