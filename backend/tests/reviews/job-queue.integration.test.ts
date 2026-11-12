import { randomUUID } from 'node:crypto';
import { describe, expect, it, beforeAll, afterAll, afterEach } from 'vitest';
import type { Prisma, PrismaClient } from '@prisma/client';
import { ReviewJobQueue } from '@/reviews/job-queue.js';
import { ReviewWorker } from '@/reviews/worker.js';
import { FakeReviewProvider, ProviderError, type ProviderResult } from '@/reviews/provider.js';
import { assertDedicatedTestDatabase } from '../security/database-safety.js';

const shouldRun = process.env.RUN_REVIEW_DB_INTEGRATION_TESTS === 'true'
  && Boolean(process.env.TEST_DATABASE_URL);

function failNextTransactionOperation(prisma: PrismaClient, shouldFail: (operation: string, query: Prisma.Sql) => boolean): PrismaClient {
  let failed = false;
  const transaction = prisma.$transaction.bind(prisma) as (callback: (tx: Prisma.TransactionClient) => Promise<unknown>) => Promise<unknown>;
  return new Proxy(prisma, {
    get(target, property, receiver) {
      if (property === '$transaction') {
        return (callback: (tx: Prisma.TransactionClient) => Promise<unknown>) => transaction((tx) => callback(new Proxy(tx, {
          get(transactionTarget, operation, transactionReceiver) {
            const original = Reflect.get(transactionTarget, operation, transactionReceiver);
            if (operation === '$queryRaw' || operation === '$executeRaw') {
              return async (query: Prisma.Sql) => {
                if (!failed && shouldFail(String(operation), query)) {
                  failed = true;
                  throw new Error('simulated transient database disconnection');
                }
                return original.call(transactionTarget, query);
              };
            }
            return original;
          },
        })));
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

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

  it('recovers a claimed job after worker termination and rejects the terminated worker lease', async () => {
    const { reviewId, jobId } = await createQueuedJob();
    const terminatedClaim = await queue.claimNextJob();
    expect(terminatedClaim?.id).toBe(jobId);

    const restartedQueue = new ReviewJobQueue(prisma);
    expect(await restartedQueue.claimNextJob()).toBeNull();
    expect(await prisma.reviewJob.findUniqueOrThrow({ where: { id: jobId } })).toMatchObject({ status: 'PROCESSING', attemptCount: 1 });

    await prisma.$executeRaw`UPDATE "ReviewJob" SET "leaseExpiresAt" = clock_timestamp() - INTERVAL '1 millisecond' WHERE "id" = ${jobId}::uuid`;
    await expect(restartedQueue.recoverExpiredJobs()).resolves.toEqual({ retried: 1, dead: 0 });
    const recoveredClaim = await restartedQueue.claimNextJob();
    expect(recoveredClaim).toMatchObject({ id: jobId, attemptCount: 2 });
    expect(recoveredClaim?.leaseToken).not.toBe(terminatedClaim?.leaseToken);

    const worker = new ReviewWorker(prisma, new FakeReviewProvider());
    const result: ProviderResult = { review: { outcome: 'PASS', score: 100, summary: 'recovered result', issues: [] }, provider: 'test', model: 'test', promptTokens: 0, completionTokens: 0 };
    const complete = (worker as unknown as { complete(job: NonNullable<typeof terminatedClaim>, value: ProviderResult, duration: number): Promise<void> }).complete.bind(worker);
    await complete(terminatedClaim!, { ...result, review: { ...result.review, summary: 'terminated worker result' } }, 1);
    expect(await prisma.reviewResult.count({ where: { codeReviewId: reviewId } })).toBe(0);
    await complete(recoveredClaim!, result, 1);
    expect(await prisma.reviewResult.count({ where: { codeReviewId: reviewId } })).toBe(1);
  });

  it('leaves a queued job claimable when the database fails during claim', async () => {
    const { jobId } = await createQueuedJob();
    const interruptedQueue = new ReviewJobQueue(failNextTransactionOperation(prisma, (operation) => operation === '$queryRaw'));

    await expect(interruptedQueue.claimNextJob()).rejects.toThrow('simulated transient database disconnection');
    expect(await prisma.reviewJob.findUniqueOrThrow({ where: { id: jobId } })).toMatchObject({ status: 'QUEUED', attemptCount: 0 });
    expect(await queue.claimNextJob()).toMatchObject({ id: jobId, attemptCount: 1 });
  });

  it('recovers after a database failure while scheduling a provider retry', async () => {
    const { jobId } = await createQueuedJob();
    const claim = await queue.claimNextJob();
    expect(claim?.id).toBe(jobId);
    const interruptedPrisma = failNextTransactionOperation(prisma, (operation, query) => operation === '$executeRaw' && query.sql.includes('RETRY_WAIT'));
    const worker = new ReviewWorker(interruptedPrisma, new FakeReviewProvider(undefined, new ProviderError('PROVIDER_TIMEOUT', true)), new ReviewJobQueue(interruptedPrisma));

    await expect(worker.process(claim!)).rejects.toThrow('simulated transient database disconnection');
    expect(await prisma.reviewJob.findUniqueOrThrow({ where: { id: jobId } })).toMatchObject({ status: 'PROCESSING', attemptCount: 1, leaseToken: claim!.leaseToken });
    await prisma.$executeRaw`UPDATE "ReviewJob" SET "leaseExpiresAt" = clock_timestamp() - INTERVAL '1 millisecond' WHERE "id" = ${jobId}::uuid`;
    await expect(queue.recoverExpiredJobs()).resolves.toEqual({ retried: 1, dead: 0 });
    expect(await new ReviewJobQueue(prisma).claimNextJob()).toMatchObject({ id: jobId, attemptCount: 2 });
  });

  it('rolls back partial completion after a database failure and recovers the job', async () => {
    const { reviewId, jobId } = await createQueuedJob();
    const claim = await queue.claimNextJob();
    expect(claim?.id).toBe(jobId);
    const interruptedPrisma = failNextTransactionOperation(prisma, (operation) => operation === '$executeRaw');
    const providerResult: ProviderResult = { review: { outcome: 'FAIL', score: 30, summary: 'transaction must roll back', issues: [{ title: 'Issue', description: 'Details', severity: 'HIGH', type: 'LOGIC' }] }, provider: 'test', model: 'test', promptTokens: 1, completionTokens: 2 };
    const worker = new ReviewWorker(interruptedPrisma, new FakeReviewProvider(providerResult), new ReviewJobQueue(interruptedPrisma));

    await worker.process(claim!);
    expect(await prisma.reviewResult.count({ where: { codeReviewId: reviewId } })).toBe(0);
    expect(await prisma.reviewIssue.count({ where: { reviewResult: { codeReviewId: reviewId } } })).toBe(0);
    expect(await prisma.reviewJob.findUniqueOrThrow({ where: { id: jobId } })).toMatchObject({ status: 'RETRY_WAIT', attemptCount: 1, lastErrorCode: 'WORKER_UNEXPECTED_ERROR' });

    await prisma.$executeRaw`UPDATE "ReviewJob" SET "availableAt" = clock_timestamp() - INTERVAL '1 millisecond' WHERE "id" = ${jobId}::uuid`;
    expect(await new ReviewJobQueue(prisma).claimNextJob()).toMatchObject({ id: jobId, attemptCount: 2 });
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

  it('fences delayed completion after lease expiry and persists only the new worker result', async () => {
    const { reviewId, jobId } = await createQueuedJob();
    const oldClaim = await queue.claimNextJob();
    expect(oldClaim?.id).toBe(jobId);
    await prisma.reviewJob.update({ where: { id: jobId }, data: { leaseExpiresAt: new Date(0) } });
    await expect(queue.recoverExpiredJobs()).resolves.toEqual({ retried: 1, dead: 0 });
    const newClaim = await queue.claimNextJob();
    expect(newClaim?.id).toBe(jobId);

    const worker = new ReviewWorker(prisma, new FakeReviewProvider());
    const result: ProviderResult = { review: { outcome: 'PASS', score: 100, summary: 'new lease result', issues: [] }, provider: 'test', model: 'test', promptTokens: 0, completionTokens: 0 };
    const complete = (worker as unknown as { complete(job: NonNullable<typeof oldClaim>, value: ProviderResult, duration: number): Promise<void> }).complete.bind(worker);
    await complete(oldClaim!, { ...result, review: { ...result.review, summary: 'stale result' } }, 1);
    expect(await prisma.reviewResult.count({ where: { codeReviewId: reviewId } })).toBe(0);
    await complete(newClaim!, result, 1);

    expect(await prisma.reviewResult.count({ where: { codeReviewId: reviewId } })).toBe(1);
    expect(await prisma.reviewResult.findUniqueOrThrow({ where: { codeReviewId: reviewId } })).toMatchObject({ summary: 'new lease result' });
    expect(await prisma.reviewJob.findUniqueOrThrow({ where: { id: jobId } })).toMatchObject({ status: 'SUCCEEDED', attemptCount: 2, leaseToken: null });
    expect(await prisma.codeReview.findUniqueOrThrow({ where: { id: reviewId } })).toMatchObject({ reviewStatus: 'COMPLETED' });
  });

  it('preserves attempt and scheduled retry state when a fresh queue instance starts', async () => {
    const { jobId } = await createQueuedJob();
    const first = await queue.claimNextJob();
    expect(first).toMatchObject({ id: jobId, attemptCount: 1 });
    await prisma.$executeRaw`UPDATE "ReviewJob" SET "status" = 'RETRY_WAIT', "availableAt" = clock_timestamp() + INTERVAL '60 seconds', "leaseToken" = NULL, "leaseExpiresAt" = NULL, "lastErrorCode" = 'PROVIDER_TIMEOUT' WHERE "id" = ${jobId}::uuid`;

    const restartedQueue = new ReviewJobQueue(prisma);
    expect(await restartedQueue.claimNextJob()).toBeNull();
    expect(await prisma.reviewJob.findUniqueOrThrow({ where: { id: jobId } })).toMatchObject({ status: 'RETRY_WAIT', attemptCount: 1, lastErrorCode: 'PROVIDER_TIMEOUT' });

    await prisma.$executeRaw`UPDATE "ReviewJob" SET "availableAt" = clock_timestamp() - INTERVAL '1 millisecond' WHERE "id" = ${jobId}::uuid`;
    expect(await restartedQueue.claimNextJob()).toMatchObject({ id: jobId, attemptCount: 2 });
  });

  it('exhausts five attempts across fresh worker instances without allowing a sixth claim', async () => {
    const { reviewId, jobId } = await createQueuedJob();
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const restartedQueue = new ReviewJobQueue(prisma);
      const claim = await restartedQueue.claimNextJob();
      expect(claim).toMatchObject({ id: jobId, attemptCount: attempt });
      const worker = new ReviewWorker(prisma, new FakeReviewProvider(undefined, new ProviderError('PROVIDER_TIMEOUT', true)), restartedQueue);
      await worker.process(claim!);

      if (attempt < 5) {
        expect(await prisma.reviewJob.findUniqueOrThrow({ where: { id: jobId } })).toMatchObject({ status: 'RETRY_WAIT', attemptCount: attempt });
        await prisma.$executeRaw`UPDATE "ReviewJob" SET "availableAt" = clock_timestamp() - INTERVAL '1 millisecond' WHERE "id" = ${jobId}::uuid`;
      }
    }

    expect(await prisma.reviewJob.findUniqueOrThrow({ where: { id: jobId } })).toMatchObject({ status: 'DEAD', attemptCount: 5, lastErrorCode: 'MAX_ATTEMPTS_EXCEEDED' });
    expect(await prisma.codeReview.findUniqueOrThrow({ where: { id: reviewId } })).toMatchObject({ reviewStatus: 'FAILED', failureCode: 'MAX_ATTEMPTS_EXCEEDED' });
    expect(await new ReviewJobQueue(prisma).claimNextJob()).toBeNull();
  });

  it('keeps duplicate completion attempts terminal with one result and its issues', async () => {
    const { reviewId, jobId } = await createQueuedJob();
    const claim = await queue.claimNextJob();
    expect(claim?.id).toBe(jobId);
    const worker = new ReviewWorker(prisma, new FakeReviewProvider());
    const result: ProviderResult = { review: { outcome: 'FAIL', score: 25, summary: 'single persisted result', issues: [{ title: 'Finding', description: 'One issue', severity: 'CRITICAL', type: 'SECURITY' }] }, provider: 'test', model: 'test', promptTokens: 2, completionTokens: 3 };
    const complete = (worker as unknown as { complete(job: NonNullable<typeof claim>, value: ProviderResult, duration: number): Promise<void> }).complete.bind(worker);

    await complete(claim!, result, 1);
    await complete(claim!, result, 1);

    expect(await prisma.reviewJob.findUniqueOrThrow({ where: { id: jobId } })).toMatchObject({ status: 'SUCCEEDED', attemptCount: 1, leaseToken: null });
    expect(await prisma.reviewResult.count({ where: { codeReviewId: reviewId } })).toBe(1);
    const persisted = await prisma.reviewResult.findUniqueOrThrow({ where: { codeReviewId: reviewId }, include: { issues: true } });
    expect(persisted).toMatchObject({ summary: 'single persisted result', issues: [{ title: 'Finding', description: 'One issue' }] });
    expect(persisted.issues).toHaveLength(1);
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
