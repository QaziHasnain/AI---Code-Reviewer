import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { retryDelayMs, ReviewWorker } from '@/reviews/worker.js';
import { FakeReviewProvider, ProviderError } from '@/reviews/provider.js';
import type { ProviderResult } from '@/reviews/provider.js';

const claim = { id: 'job', codeReviewId: 'review', attemptCount: 1, leaseToken: 'token', leaseExpiresAt: new Date() };

describe('review worker policy', () => {
  it('uses bounded exponential jitter and Retry-After', () => {
    expect(retryDelayMs(1, undefined, () => 0)).toBe(750);
    expect(retryDelayMs(5, 5000, () => 0)).toBe(12000);
  });

  it('does not expose provider error contents and retries transient errors', async () => {
    const db = { codeReview: { findUnique: vi.fn().mockResolvedValue({ id: 'review', programmingLanguage: 'TYPESCRIPT', sourceCode: 'x', instructions: null }) } } as unknown as PrismaClient;
    const worker = new ReviewWorker(db, new FakeReviewProvider(undefined, new ProviderError('PROVIDER_TIMEOUT', true)));
    const retry = vi.spyOn(worker as never, 'retry' as never).mockResolvedValue(undefined);
    await worker.process(claim);
    expect(retry).toHaveBeenCalledWith(claim, 'PROVIDER_TIMEOUT', expect.any(Number));
  });

  it('does not retry permanent failures or attempts beyond the maximum', async () => {
    const db = { codeReview: { findUnique: vi.fn().mockResolvedValue({ id: 'review', programmingLanguage: 'TYPESCRIPT', sourceCode: 'x', instructions: null }) } } as unknown as PrismaClient;
    const permanent = new ReviewWorker(db, new FakeReviewProvider(undefined, new ProviderError('PROVIDER_INVALID_RESPONSE', false)));
    const fail = vi.spyOn(permanent as never, 'fail' as never).mockResolvedValue(undefined);
    await permanent.process(claim);
    expect(fail).toHaveBeenCalledWith(claim, 'PROVIDER_INVALID_RESPONSE');
    const exhausted = new ReviewWorker(db, new FakeReviewProvider(undefined, new ProviderError('PROVIDER_TIMEOUT', true)));
    const exhaustedFail = vi.spyOn(exhausted as never, 'fail' as never).mockResolvedValue(undefined);
    await exhausted.process({ ...claim, attemptCount: 5 });
    expect(exhaustedFail).toHaveBeenCalledWith({ ...claim, attemptCount: 5 }, 'MAX_ATTEMPTS_EXCEEDED');
  });

  it('persists result, issues, review state, and job state in one fenced transaction', async () => {
    const operations: string[] = [];
    const tx = {
      $queryRaw: vi.fn(async () => [{ id: claim.id }]),
      reviewResult: { create: vi.fn(async () => { operations.push('result'); return { id: 'result' }; }) },
      reviewIssue: { createMany: vi.fn(async () => { operations.push('issues'); return { count: 1 }; }) },
      $executeRaw: vi.fn(async () => { operations.push(`state-${operations.length}`); return 1; }),
    };
    const prisma = { $transaction: vi.fn(async (callback: (value: typeof tx) => Promise<unknown>) => callback(tx)) } as unknown as PrismaClient;
    const worker = new ReviewWorker(prisma, new FakeReviewProvider());
    const output: ProviderResult = { review: { outcome: 'FAIL', score: 40, summary: 'Found issue', issues: [{ title: 'Issue', description: 'Details', severity: 'HIGH', type: 'LOGIC' }] }, provider: 'fake', model: 'test', promptTokens: 1, completionTokens: 2 };
    await (worker as unknown as { complete(job: typeof claim, result: ProviderResult, duration: number): Promise<void> }).complete(claim, output, 12);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(tx.reviewResult.create).toHaveBeenCalledTimes(1);
    expect(tx.reviewIssue.createMany).toHaveBeenCalledTimes(1);
    expect(operations).toEqual(['result', 'issues', 'state-2', 'state-3']);
    expect(tx.$executeRaw.mock.calls[1][0].values).toContain(claim.leaseToken);
  });

  it.each(['result', 'issues', 'review', 'job'])('propagates %s persistence failures so the transaction rolls back', async (stage) => {
    const tx = {
      $queryRaw: vi.fn(async () => [{ id: claim.id }]),
      reviewResult: { create: vi.fn(async () => { if (stage === 'result') throw new Error('failed'); return { id: 'result' }; }) },
      reviewIssue: { createMany: vi.fn(async () => { if (stage === 'issues') throw new Error('failed'); return { count: 1 }; }) },
      $executeRaw: vi.fn(async () => { if ((stage === 'review' && tx.$executeRaw.mock.calls.length === 1) || (stage === 'job' && tx.$executeRaw.mock.calls.length === 2)) return 0; return 1; }),
    };
    const prisma = { $transaction: vi.fn(async (callback: (value: typeof tx) => Promise<unknown>) => callback(tx)) } as unknown as PrismaClient;
    const worker = new ReviewWorker(prisma, new FakeReviewProvider());
    const output: ProviderResult = { review: { outcome: 'PASS', score: 100, summary: 'OK', issues: [{ title: 'x', description: 'y', severity: 'LOW', type: 'STYLE' }] }, provider: 'fake', model: 'test', promptTokens: 0, completionTokens: 0 };
    await expect((worker as unknown as { complete(job: typeof claim, result: ProviderResult, duration: number): Promise<void> }).complete(claim, output, 1)).rejects.toThrow();
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it('rejects completion after the lease is stale', async () => {
    const tx = { $queryRaw: vi.fn(async () => []), reviewResult: { create: vi.fn() }, reviewIssue: { createMany: vi.fn() }, $executeRaw: vi.fn() };
    const prisma = { $transaction: vi.fn(async (callback: (value: typeof tx) => Promise<unknown>) => callback(tx)) } as unknown as PrismaClient;
    const worker = new ReviewWorker(prisma, new FakeReviewProvider());
    const output: ProviderResult = { review: { outcome: 'PASS', score: 100, summary: 'OK', issues: [] }, provider: 'fake', model: 'test', promptTokens: 0, completionTokens: 0 };
    await expect((worker as unknown as { complete(job: typeof claim, result: ProviderResult, duration: number): Promise<void> }).complete(claim, output, 1)).resolves.toBeUndefined();
    expect(tx.reviewResult.create).not.toHaveBeenCalled();
  });
});
