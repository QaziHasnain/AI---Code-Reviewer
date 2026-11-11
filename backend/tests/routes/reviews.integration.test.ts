import { randomUUID } from 'node:crypto';
import { describe, expect, it, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { PersistentAuthRateLimitStore } from '@/security/auth/rate-limit-store.js';
import { SessionService } from '@/security/session/index.js';
import { ReviewService } from '@/reviews/service.js';
import { assertDedicatedTestDatabase } from '../security/database-safety.js';

const shouldRun = process.env.RUN_REVIEW_DB_INTEGRATION_TESTS === 'true'
  && Boolean(process.env.TEST_DATABASE_URL);

describe.skipIf(!shouldRun)('Code review PostgreSQL integration', () => {
  let prisma: PrismaClient;
  let sessions: SessionService;
  let app: any;
  const createdUserIds: string[] = [];
  let primaryUser: { id: string; token: string };
  let secondaryUser: { id: string; token: string };

  async function createAuthenticatedUser(): Promise<{ id: string; token: string }> {
    const user = await prisma.user.create({
      data: {
        name: 'Review integration user',
        email: `review-integration-${randomUUID()}@example.test`,
        passwordHash: 'integration-test-only',
      },
      select: { id: true },
    });
    createdUserIds.push(user.id);
    const session = await sessions.createSession(user.id);
    return { id: user.id, token: session.token };
  }

  function headers(user: { token: string }): Record<string, string> {
    return { origin: 'http://localhost:3000', cookie: `session=${user.token}` };
  }

  async function submit(user: { token: string }, sourceCode: string, idempotencyKey?: string) {
    return app!.inject({
      method: 'POST',
      url: '/api/reviews',
      headers: { ...headers(user), ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}) },
      payload: { sourceCode, programmingLanguage: 'TYPESCRIPT' },
    });
  }

  beforeAll(async () => {
    if (process.env.DATABASE_URL) {
      throw new Error('Review integration refused: development DATABASE_URL is present before application import');
    }
    if (!process.env.TEST_DATABASE_URL) {
      throw new Error('Review integration requires TEST_DATABASE_URL before application import');
    }
    const testDatabaseUrl = process.env.TEST_DATABASE_URL;

    // Prisma's generated client attempts to load backend/.env when it is
    // imported. An empty sentinel prevents that loader from reintroducing the
    // development DATABASE_URL; the client receives the dedicated URL below.
    process.env.DATABASE_URL = '';
    const { PrismaClient } = await import('@prisma/client');
    prisma = new PrismaClient({ datasources: { db: { url: testDatabaseUrl } } });
    delete process.env.DATABASE_URL;
    if (process.env.DATABASE_URL) {
      throw new Error('Review integration refused: Prisma reintroduced DATABASE_URL before application import');
    }
    sessions = new SessionService(prisma);
    await assertDedicatedTestDatabase(prisma);
    const { buildApp } = await import('@/app.js');
    const rateLimits = new PersistentAuthRateLimitStore(prisma.authRateLimitBucket);
    const reviews = new ReviewService(prisma);
    app = await buildApp({
      frontendUrl: 'http://localhost:3000',
      authentication: { prisma, sessions },
      reviewRoutes: {
        reviews,
        frontendUrl: 'http://localhost:3000',
        rateLimits,
        rateLimitHmacSecret: process.env.RATE_LIMIT_HMAC_SECRET!,
      },
    });
  });

  afterAll(async () => {
    await app?.close();
    await prisma?.$disconnect();
  });

  beforeEach(async () => {
    primaryUser = await createAuthenticatedUser();
    secondaryUser = await createAuthenticatedUser();
  });

  afterEach(async () => {
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds.splice(0) } } });
  });

  it('submits a review and creates exactly one row for concurrent identical idempotency requests', async () => {
    const responses = await Promise.all([
      submit(primaryUser, 'const answer = 42;', 'concurrent-key'),
      submit(primaryUser, 'const answer = 42;', 'concurrent-key'),
    ]);
    expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 202]);
    const reviewIds = responses.map((response) => response.json().review.id);
    expect(reviewIds[0]).toBe(reviewIds[1]);
    expect(await prisma.codeReview.count({ where: { userId: primaryUser.id } })).toBe(1);
    expect(await prisma.reviewIdempotencyKey.count({ where: { userId: primaryUser.id, key: 'concurrent-key' } })).toBe(1);
  });

  it('rejects a different payload for the same user-scoped idempotency key', async () => {
    const first = await submit(primaryUser, 'const first = true;', 'conflict-key');
    const conflict = await submit(primaryUser, 'const second = true;', 'conflict-key');
    expect(first.statusCode).toBe(202);
    expect(conflict.statusCode).toBe(409);
    expect(await prisma.codeReview.count({ where: { userId: primaryUser.id } })).toBe(1);
  });

  it('allows the same idempotency key for different users', async () => {
    const responses = await Promise.all([
      submit(primaryUser, 'const first = true;', 'shared-key'),
      submit(secondaryUser, 'const second = true;', 'shared-key'),
    ]);
    expect(responses.every((response) => response.statusCode === 202)).toBe(true);
    expect(responses[0].json().review.id).not.toBe(responses[1].json().review.id);
  });

  it('rolls back the review and idempotency record when the transaction fails', async () => {
    const rollbackService = new ReviewService({
      codeReview: prisma.codeReview,
      reviewResult: prisma.reviewResult,
      reviewIssue: prisma.reviewIssue,
      reviewIdempotencyKey: prisma.reviewIdempotencyKey,
      $transaction: async (callback) => prisma.$transaction(async (transaction) => {
        await callback(transaction as never);
        throw new Error('forced integration rollback');
      }),
    } as never);

    await expect(rollbackService.createReview(primaryUser.id, {
      sourceCode: 'const rolledBack = true;',
      programmingLanguage: 'TYPESCRIPT',
    }, 'rollback-key')).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
    expect(await prisma.codeReview.count({ where: { userId: primaryUser.id } })).toBe(0);
    expect(await prisma.reviewIdempotencyKey.count({ where: { userId: primaryUser.id, key: 'rollback-key' } })).toBe(0);
  });

  it('does not expose reviews or results across users', async () => {
    const response = await submit(primaryUser, 'const privateReview = true;', 'ownership-key');
    const reviewId = response.json().review.id;
    const review = await prisma.codeReview.update({
      where: { id: reviewId },
      data: { reviewStatus: 'COMPLETED', completedAt: new Date() },
    });
    await prisma.reviewResult.create({
      data: {
        codeReviewId: review.id,
        outcome: 'PASS',
        score: 100,
        summary: 'Integration result',
        detailedAnalysis: 'No issues',
        aiProvider: 'test',
        aiModel: 'test-model',
        promptTokenUsage: 1,
        completionTokenUsage: 1,
        processingDuration: 1,
      },
    });

    const foreignReview = await app!.inject({ method: 'GET', url: `/api/reviews/${review.id}`, headers: headers(secondaryUser) });
    const foreignResult = await app!.inject({ method: 'GET', url: `/api/reviews/${review.id}/results`, headers: headers(secondaryUser) });
    expect(foreignReview.statusCode).toBe(404);
    expect(foreignResult.statusCode).toBe(404);
  });

  it('returns an internal consistency error for a completed review without a result', async () => {
    const review = await prisma.codeReview.create({
      data: { userId: primaryUser.id, sourceCode: 'const incomplete = true;', programmingLanguage: 'TYPESCRIPT', reviewStatus: 'COMPLETED', completedAt: new Date() },
    });
    const response = await app!.inject({ method: 'GET', url: `/api/reviews/${review.id}/results`, headers: headers(primaryUser) });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ error: { code: 'INTERNAL_ERROR', message: 'Review result is unavailable' } });
  });

  it('enforces nested issue ownership and the review ID relationship', async () => {
    const review = await prisma.codeReview.create({
      data: { userId: primaryUser.id, sourceCode: 'const issue = true;', programmingLanguage: 'TYPESCRIPT', reviewStatus: 'COMPLETED', completedAt: new Date() },
    });
    const otherReview = await prisma.codeReview.create({
      data: { userId: primaryUser.id, sourceCode: 'const other = true;', programmingLanguage: 'TYPESCRIPT', reviewStatus: 'COMPLETED', completedAt: new Date() },
    });
    const result = await prisma.reviewResult.create({
      data: {
        codeReviewId: review.id,
        outcome: 'NEEDS_REVIEW',
        score: 50,
        summary: 'Integration result',
        aiProvider: 'test',
        aiModel: 'test-model',
        promptTokenUsage: 1,
        completionTokenUsage: 1,
        processingDuration: 1,
      },
    });
    const issue = await prisma.reviewIssue.create({
      data: { reviewResultId: result.id, title: 'Issue', description: 'Description', severity: 'HIGH', type: 'LOGIC' },
    });

    const own = await app!.inject({ method: 'GET', url: `/api/reviews/${review.id}/issues/${issue.id}`, headers: headers(primaryUser) });
    const foreign = await app!.inject({ method: 'GET', url: `/api/reviews/${review.id}/issues/${issue.id}`, headers: headers(secondaryUser) });
    const wrongReview = await app!.inject({ method: 'GET', url: `/api/reviews/${otherReview.id}/issues/${issue.id}`, headers: headers(primaryUser) });
    expect(own.statusCode).toBe(200);
    expect(foreign.statusCode).toBe(404);
    expect(wrongReview.statusCode).toBe(404);
  });

  it('paginates reviews with identical timestamps without duplicates or omissions', async () => {
    const createdAt = new Date('2035-01-01T00:00:00.000Z');
    const seeded = await Promise.all(Array.from({ length: 5 }, (_, index) => prisma.codeReview.create({
      data: {
        userId: primaryUser.id,
        sourceCode: `const review${index} = true;`,
        programmingLanguage: 'TYPESCRIPT',
        reviewStatus: 'SUBMITTED',
        createdAt,
      },
      select: { id: true },
    })));
    const expected = new Set(seeded.map((row) => row.id));
    const first = await app!.inject({ method: 'GET', url: '/api/reviews?limit=2&order=asc', headers: headers(primaryUser) });
    expect(first.statusCode).toBe(200);
    const firstBody = first.json();
    expect(firstBody.items).toHaveLength(2);
    expect(firstBody.nextCursor).toBeTruthy();
    const second = await app!.inject({ method: 'GET', url: `/api/reviews?limit=2&order=asc&cursor=${encodeURIComponent(firstBody.nextCursor)}`, headers: headers(primaryUser) });
    expect(second.statusCode).toBe(200);
    const secondBody = second.json();
    const ids = [...firstBody.items, ...secondBody.items].map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => expected.has(id))).toBe(true);
  });
});
