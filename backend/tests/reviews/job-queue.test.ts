import { Prisma, type PrismaClient } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { ReviewJobQueue } from '@/reviews/job-queue.js';

function createQueue(queryResults: unknown[][] = [], executeResults: number[] = []) {
  const queries: Prisma.Sql[] = [];
  const executions: Prisma.Sql[] = [];
  const transaction = {
    $queryRaw: vi.fn(async (query: Prisma.Sql) => {
      queries.push(query);
      return queryResults.shift() ?? [];
    }),
    $executeRaw: vi.fn(async (query: Prisma.Sql) => {
      executions.push(query);
      return executeResults.shift() ?? 0;
    }),
  };
  const prisma = {
    $transaction: vi.fn(async (callback: (tx: typeof transaction) => Promise<unknown>) => callback(transaction)),
  };
  return { queue: new ReviewJobQueue(prisma as unknown as PrismaClient), prisma, transaction, queries, executions };
}

describe('ReviewJobQueue', () => {
  it('claims one job with deterministic locking and updates its review transactionally', async () => {
    const claimed = {
      id: '00000000-0000-4000-8000-000000000001',
      codeReviewId: '00000000-0000-4000-8000-000000000002',
      attemptCount: 1,
      leaseToken: '00000000-0000-4000-8000-000000000003',
      leaseExpiresAt: new Date('2030-01-01T00:01:00.000Z'),
    };
    const { queue, prisma, queries, executions } = createQueue([[claimed]], [1]);

    await expect(queue.claimNextJob()).resolves.toEqual(claimed);

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(queries[0].sql).toContain('FOR UPDATE OF job SKIP LOCKED');
    expect(queries[0].sql).toContain('ORDER BY job."availableAt" ASC, job."createdAt" ASC, job."id" ASC');
    expect(queries[0].sql).toContain('clock_timestamp()');
    expect(queries[0].values).toContain(5);
    expect(executions[0].sql).toContain('SET "reviewStatus" = \'PROCESSING\'');
  });

  it('returns null when no eligible job exists', async () => {
    const { queue, executions } = createQueue([[]]);
    await expect(queue.claimNextJob()).resolves.toBeNull();
    expect(executions).toHaveLength(0);
  });

  it('renews only a matching, unexpired processing lease using database time', async () => {
    const expiresAt = new Date('2030-01-01T00:01:00.000Z');
    const { queue, queries } = createQueue([[{ leaseExpiresAt: expiresAt }], []]);

    await expect(queue.renewLease('job-id', 'lease-id')).resolves.toEqual({ renewed: true, leaseExpiresAt: expiresAt });
    await expect(queue.renewLease('job-id', 'stale-lease-id')).resolves.toEqual({ renewed: false, reason: 'LEASE_LOST' });
    expect(queries[0].sql).toContain('"status" = \'PROCESSING\'');
    expect(queries[0].sql).toContain('"leaseToken" =');
    expect(queries[0].sql).toContain('"leaseExpiresAt" > clock_timestamp()');
    expect(queries[0].sql).toContain('clock_timestamp() +');
  });

  it('recovers expired jobs in a bounded batch and synchronizes review states', async () => {
    const { queue, queries, executions } = createQueue([[
      { codeReviewId: 'review-retry', status: 'RETRY_WAIT' },
      { codeReviewId: 'review-dead', status: 'DEAD' },
    ]], [1, 1]);

    await expect(queue.recoverExpiredJobs(2)).resolves.toEqual({ retried: 1, dead: 1 });
    expect(queries[0].sql).toContain('"leaseExpiresAt" <= clock_timestamp()');
    expect(queries[0].sql).toContain('FOR UPDATE OF job SKIP LOCKED');
    expect(queries[0].sql).toContain('"attemptCount" >=');
    expect(executions[0].sql).toContain('::"ReviewStatus"');
    expect(executions[0].values).toContain('SUBMITTED');
    expect(executions[1].values).toContain('FAILED');
  });

  it('rejects invalid lease durations and recovery batch sizes before database access', async () => {
    const { queue, prisma } = createQueue();
    await expect(queue.claimNextJob(0)).rejects.toThrow(RangeError);
    await expect(queue.recoverExpiredJobs(501)).rejects.toThrow(RangeError);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
