import { describe, expect, it, vi } from 'vitest';
import { buildApp } from '@/app.js';
import { ReviewServiceError, type ReviewService } from '@/reviews/service.js';
import { REVIEW_RATE_LIMIT } from '@/routes/reviews.js';

const user = { id: '00000000-0000-4000-8000-000000000001', name: 'Reviewer', email: 'reviewer@example.com', createdAt: new Date('2030-01-01T00:00:00.000Z') };
const session = { id: '00000000-0000-4000-8000-000000000002', userId: user.id, expiresAt: new Date('2030-01-08T00:00:00.000Z'), createdAt: user.createdAt, lastSeenAt: null, revokedAt: null, userAgent: null, ipHash: null };
const review = {
  id: '00000000-0000-4000-8000-000000000003', programmingLanguage: 'TYPESCRIPT', reviewStatus: 'SUBMITTED',
  repository: null, branch: null, commitHash: null, completedAt: null, failedAt: null, failureCode: null,
  createdAt: new Date('2030-01-01T00:00:00.000Z'), updatedAt: new Date('2030-01-01T00:00:00.000Z'),
};

function setup(reviewService: Partial<Record<keyof ReviewService, ReturnType<typeof vi.fn>>> = {}) {
  const reviews = {
    createReview: vi.fn().mockResolvedValue({ review, replayed: false }),
    getReview: vi.fn().mockResolvedValue(review),
    listReviews: vi.fn().mockResolvedValue({ items: [review], nextCursor: null }),
    getResults: vi.fn().mockResolvedValue({ status: 'SUBMITTED', result: null }),
    getIssue: vi.fn().mockResolvedValue({ id: '00000000-0000-4000-8000-000000000004', title: 'Issue' }),
    ...reviewService,
  } as unknown as ReviewService;
  const rateLimits = { increment: vi.fn().mockResolvedValue(1) };
  const authentication = {
    sessions: { validateSession: vi.fn().mockResolvedValue(session) },
    prisma: { user: { findUnique: vi.fn().mockResolvedValue(user) } },
  };
  const app = buildApp({
    frontendUrl: 'http://localhost:3000', authentication,
    authRoutes: undefined,
    reviewRoutes: { reviews, frontendUrl: 'http://localhost:3000', rateLimits, rateLimitHmacSecret: 'a'.repeat(64) },
  });
  return { app, reviews, rateLimits };
}

const origin = { origin: 'http://localhost:3000', cookie: 'session=valid-token' };

describe('review routes', () => {
  it('requires authentication for every review endpoint', async () => {
    const { app } = setup();
    const instance = await app;
    const response = await instance.inject({ method: 'GET', url: '/api/reviews' });
    expect(response.statusCode).toBe(401);
    await instance.close();
  });

  it('accepts a review without exposing its source', async () => {
    const { app, reviews } = setup();
    const instance = await app;
    const response = await instance.inject({
      method: 'POST', url: '/api/reviews', headers: { ...origin, 'idempotency-key': 'request-1' },
      payload: { sourceCode: 'const answer = 42;', programmingLanguage: 'TYPESCRIPT', instructions: 'Focus on safety' },
    });
    expect(response.statusCode).toBe(202);
    expect(response.headers.location).toBe(`/api/reviews/${review.id}`);
    expect(response.json()).toEqual({ review: { id: review.id, status: 'SUBMITTED', programmingLanguage: 'TYPESCRIPT', createdAt: review.createdAt.toISOString(), statusUrl: `/api/reviews/${review.id}` } });
    expect(response.body).not.toContain('const answer');
    expect(reviews.createReview).toHaveBeenCalledWith(user.id, expect.objectContaining({ sourceCode: 'const answer = 42;' }), 'request-1');
    await instance.close();
  });

  it('rejects invalid input, invalid origin, and oversized UTF-8 source', async () => {
    const { app, reviews, rateLimits } = setup();
    const instance = await app;
    const invalid = await instance.inject({ method: 'POST', url: '/api/reviews', headers: origin, payload: { sourceCode: '   ', programmingLanguage: 'TYPESCRIPT' } });
    expect(invalid.statusCode).toBe(400);
    const language = await instance.inject({ method: 'POST', url: '/api/reviews', headers: origin, payload: { sourceCode: 'x', programmingLanguage: 'BASIC' } });
    expect(language.statusCode).toBe(400);
    const instructions = await instance.inject({ method: 'POST', url: '/api/reviews', headers: origin, payload: { sourceCode: 'x', programmingLanguage: 'TYPESCRIPT', instructions: 'x'.repeat(4_097) } });
    expect(instructions.statusCode).toBe(400);
    const forbidden = await instance.inject({ method: 'POST', url: '/api/reviews', headers: { cookie: origin.cookie, origin: 'https://attacker.example' }, payload: { sourceCode: 'x', programmingLanguage: 'TYPESCRIPT' } });
    expect(forbidden.statusCode).toBe(403);
    const oversized = await instance.inject({ method: 'POST', url: '/api/reviews', headers: origin, payload: { sourceCode: '🙂'.repeat(70_000), programmingLanguage: 'TYPESCRIPT' } });
    expect(oversized.statusCode).toBe(413);
    expect(reviews.createReview).not.toHaveBeenCalled();
    expect(rateLimits.increment).not.toHaveBeenCalled();
    await instance.close();
  });

  it('returns idempotent replays and conflicts safely', async () => {
    const replay = vi.fn().mockResolvedValue({ review, replayed: true });
    const { app } = setup({ createReview: replay });
    const instance = await app;
    const first = await instance.inject({ method: 'POST', url: '/api/reviews', headers: { ...origin, 'idempotency-key': 'same-key' }, payload: { sourceCode: 'x', programmingLanguage: 'TYPESCRIPT' } });
    expect(first.statusCode).toBe(200);
    expect(first.headers['idempotency-replayed']).toBe('true');
    replay.mockRejectedValue(new ReviewServiceError('Idempotency key was already used with a different request', 'IDEMPOTENCY_KEY_REUSED'));
    const conflict = await instance.inject({ method: 'POST', url: '/api/reviews', headers: { ...origin, 'idempotency-key': 'same-key' }, payload: { sourceCode: 'y', programmingLanguage: 'TYPESCRIPT' } });
    expect(conflict.statusCode).toBe(409);
    await instance.close();
  });

  it('rate limits submissions before calling the service', async () => {
    const { app, reviews, rateLimits } = setup();
    const instance = await app;
    rateLimits.increment.mockResolvedValue(REVIEW_RATE_LIMIT.limit + 1);
    const response = await instance.inject({ method: 'POST', url: '/api/reviews', headers: origin, payload: { sourceCode: 'x', programmingLanguage: 'TYPESCRIPT' } });
    expect(response.statusCode).toBe(429);
    expect(reviews.createReview).not.toHaveBeenCalled();
    await instance.close();
  });

  it('retrieves, lists, filters, and paginates only through the service ownership boundary', async () => {
    const { app, reviews } = setup();
    const instance = await app;
    const detail = await instance.inject({ method: 'GET', url: `/api/reviews/${review.id}`, headers: origin });
    expect(detail.statusCode).toBe(200);
    const list = await instance.inject({ method: 'GET', url: '/api/reviews?limit=100&status=COMPLETED&order=asc', headers: origin });
    expect(list.statusCode).toBe(200);
    expect(reviews.getReview).toHaveBeenCalledWith(user.id, review.id);
    expect(reviews.listReviews).toHaveBeenCalledWith(user.id, { limit: 100, status: 'COMPLETED', order: 'asc', sort: 'createdAt' });
    await instance.close();
  });

  it('returns processing and completed results, and scoped issues', async () => {
    const completed = { id: '00000000-0000-4000-8000-000000000005', outcome: 'PASS', score: 100, summary: 'Good', issues: [] };
    const getResults = vi.fn().mockResolvedValueOnce({ status: 'PROCESSING', result: null }).mockResolvedValueOnce({ status: 'COMPLETED', result: completed });
    const getIssue = vi.fn().mockResolvedValue({ id: '00000000-0000-4000-8000-000000000004', title: 'Issue' });
    const { app, reviews } = setup({ getResults, getIssue });
    const instance = await app;
    const processing = await instance.inject({ method: 'GET', url: `/api/reviews/${review.id}/results`, headers: origin });
    expect(processing.statusCode).toBe(202);
    const result = await instance.inject({ method: 'GET', url: `/api/reviews/${review.id}/results`, headers: origin });
    expect(result.statusCode).toBe(200);
    const issue = await instance.inject({ method: 'GET', url: `/api/reviews/${review.id}/issues/00000000-0000-4000-8000-000000000004`, headers: origin });
    expect(issue.statusCode).toBe(200);
    expect(reviews.getIssue).toHaveBeenCalledWith(user.id, review.id, '00000000-0000-4000-8000-000000000004');
    await instance.close();
  });

  it('maps missing and failed resources without leaking details', async () => {
    const getReview = vi.fn().mockRejectedValue(new ReviewServiceError('Review not found', 'REVIEW_NOT_FOUND'));
    const getResults = vi.fn().mockResolvedValue({ status: 'FAILED', result: null });
    const { app } = setup({ getReview, getResults });
    const instance = await app;
    const missing = await instance.inject({ method: 'GET', url: `/api/reviews/${review.id}`, headers: origin });
    expect(missing.statusCode).toBe(404);
    const failed = await instance.inject({ method: 'GET', url: `/api/reviews/${review.id}/results`, headers: origin });
    expect(failed.statusCode).toBe(409);
    expect(failed.body).not.toContain('Review not found');
    await instance.close();
  });

  it('returns an internal consistency error for a completed review without a result', async () => {
    const getResults = vi.fn().mockRejectedValue(new ReviewServiceError('Completed review has no result', 'RESULT_MISSING'));
    const { app } = setup({ getResults });
    const instance = await app;
    const response = await instance.inject({ method: 'GET', url: `/api/reviews/${review.id}/results`, headers: origin });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ error: { code: 'INTERNAL_ERROR', message: 'Review result is unavailable' } });
    await instance.close();
  });
});
