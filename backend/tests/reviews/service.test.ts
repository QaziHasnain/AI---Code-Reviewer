import { describe, expect, it, vi } from 'vitest';
import { ReviewService } from '@/reviews/service.js';

const userId = '00000000-0000-4000-8000-000000000001';
const review = {
  id: '00000000-0000-4000-8000-000000000003', programmingLanguage: 'TYPESCRIPT', reviewStatus: 'SUBMITTED',
  repository: null, branch: null, commitHash: null, completedAt: null, failedAt: null, failureCode: null,
  createdAt: new Date('2030-01-01T00:00:00.000Z'), updatedAt: new Date('2030-01-01T00:00:00.000Z'),
};

function createPrisma() {
  const idempotency = { findUnique: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue({}) };
  const codeReview = { create: vi.fn().mockResolvedValue(review), findFirst: vi.fn().mockResolvedValue(review), findMany: vi.fn().mockResolvedValue([]) };
  const reviewResult = { findFirst: vi.fn() };
  const reviewIssue = { findFirst: vi.fn().mockResolvedValue({ id: '00000000-0000-4000-8000-000000000004' }) };
  const tx = { codeReview, reviewIdempotencyKey: idempotency };
  const prisma = { codeReview, reviewResult, reviewIssue, reviewIdempotencyKey: idempotency, $transaction: vi.fn(async (callback: (value: typeof tx) => Promise<unknown>) => callback(tx)) };
  return { prisma, codeReview, idempotency, reviewIssue };
}

describe('ReviewService ownership and idempotency', () => {
  it('creates the review and idempotency record in one transaction scoped to the caller', async () => {
    const { prisma, codeReview, idempotency } = createPrisma();
    const service = new ReviewService(prisma as never);
    const result = await service.createReview(userId, { sourceCode: 'x', programmingLanguage: 'TYPESCRIPT' }, 'key-1');
    expect(result.replayed).toBe(false);
    expect(codeReview.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ userId, sourceCode: 'x', reviewStatus: 'SUBMITTED' }), select: expect.anything() }));
    expect(idempotency.create).toHaveBeenCalledWith({ data: expect.objectContaining({ userId, key: 'key-1', codeReviewId: review.id, requestHash: expect.stringMatching(/^[a-f0-9]{64}$/) }) });
  });

  it('replays the same key and rejects a different payload', async () => {
    const { prisma, idempotency, codeReview } = createPrisma();
    const service = new ReviewService(prisma as never);
    await service.createReview(userId, { sourceCode: 'x', programmingLanguage: 'TYPESCRIPT' }, 'key-1');
    const requestHash = idempotency.create.mock.calls[0][0].data.requestHash;
    idempotency.findUnique.mockResolvedValue({ requestHash, codeReview: review });
    const replay = await service.createReview(userId, { sourceCode: 'x', programmingLanguage: 'TYPESCRIPT' }, 'key-1');
    expect(replay.replayed).toBe(true);
    expect(codeReview.create).toHaveBeenCalledTimes(1);
    idempotency.findUnique.mockResolvedValue({ requestHash: 'different', codeReview: review });
    await expect(service.createReview(userId, { sourceCode: 'y', programmingLanguage: 'TYPESCRIPT' }, 'key-1')).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
  });

  it('recovers a concurrent idempotency race by reading the committed owner record', async () => {
    const { prisma, idempotency } = createPrisma();
    const service = new ReviewService(prisma as never);
    await service.createReview(userId, { sourceCode: 'x', programmingLanguage: 'TYPESCRIPT' }, 'key-1');
    const requestHash = idempotency.create.mock.calls[0][0].data.requestHash;
    idempotency.findUnique.mockResolvedValue({ requestHash, codeReview: review });
    prisma.$transaction.mockRejectedValueOnce({ code: 'P2002' });
    const replay = await service.createReview(userId, { sourceCode: 'x', programmingLanguage: 'TYPESCRIPT' }, 'key-1');
    expect(replay).toEqual({ review, replayed: true });
  });

  it('adds the authenticated user to review, listing, and nested issue queries', async () => {
    const { prisma, codeReview, reviewIssue } = createPrisma();
    const service = new ReviewService(prisma as never);
    await service.getReview(userId, review.id);
    await service.listReviews(userId, { limit: 20, sort: 'createdAt', order: 'desc' });
    await service.getIssue(userId, review.id, '00000000-0000-4000-8000-000000000004');
    expect(codeReview.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: review.id, userId } }));
    expect(codeReview.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ userId }) }));
    expect(reviewIssue.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: '00000000-0000-4000-8000-000000000004', reviewResult: { codeReview: { id: review.id, userId } } } }));
  });

  it('returns the same not-found error for a missing review', async () => {
    const { prisma, codeReview } = createPrisma();
    codeReview.findFirst.mockResolvedValue(null);
    const service = new ReviewService(prisma as never);
    await expect(service.getReview(userId, review.id)).rejects.toMatchObject({ code: 'REVIEW_NOT_FOUND' });
  });

  it('rejects a completed review without a stored result', async () => {
    const { prisma, codeReview } = createPrisma();
    codeReview.findFirst.mockResolvedValue({ ...review, reviewStatus: 'COMPLETED', results: [] });
    const service = new ReviewService(prisma as never);
    await expect(service.getResults(userId, review.id)).rejects.toMatchObject({ code: 'RESULT_MISSING' });
  });
});
