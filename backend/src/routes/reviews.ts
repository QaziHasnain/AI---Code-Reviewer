import { createHmac } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { fixedWindow } from '../security/auth/rate-limit.js';
import { createReviewSchema, issueParamsSchema, listReviewsQuerySchema, reviewIdSchema, SOURCE_CODE_MAX_BYTES } from '../reviews/schemas.js';
import { ReviewServiceError, type ReviewService } from '../reviews/service.js';

export const REVIEW_REQUEST_BODY_LIMIT = 300 * 1024;
export const REVIEW_RATE_LIMIT = { limit: 20, windowMs: 15 * 60 * 1000 } as const;

export interface ReviewRouteDependencies {
  reviews: ReviewService;
  frontendUrl: string;
  rateLimits: { increment(key: string, expiresAt: Date): Promise<number> };
  rateLimitHmacSecret: string;
}

function sameOrigin(request: FastifyRequest, frontendUrl: string): boolean {
  const expected = new URL(frontendUrl).origin;
  const origin = request.headers.origin;
  if (origin !== undefined) return origin === expected;
  const referer = request.headers.referer;
  if (referer === undefined) return false;
  try { return new URL(referer).origin === expected; } catch { return false; }
}

function rateLimitKey(secret: string, userId: string, windowStart: number): string {
  return createHmac('sha256', Buffer.from(secret, 'hex')).update(`review:${userId}:${windowStart}`).digest('hex');
}

function errorResponse(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof ReviewServiceError) {
    if (error.code === 'REVIEW_NOT_FOUND') return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Review not found' } });
    if (error.code === 'IDEMPOTENCY_KEY_REUSED') return reply.code(409).send({ error: { code: error.code, message: error.message } });
    if (error.code === 'INVALID_CURSOR') return reply.code(400).send({ error: { code: 'INVALID_INPUT', message: 'Invalid pagination cursor' } });
    if (error.code === 'REVIEW_NOT_COMPLETED') return reply.code(409).send({ error: { code: error.code, message: error.message } });
    if (error.code === 'REVIEW_FAILED') return reply.code(409).send({ error: { code: error.code, message: error.message } });
    if (error.code === 'RESULT_MISSING') return reply.code(500).send({ error: { code: 'INTERNAL_ERROR', message: 'Review result is unavailable' } });
  }
  return reply.code(503).send({ error: { code: 'SERVICE_UNAVAILABLE', message: 'Review service unavailable' } });
}

function acceptedResponse(reply: FastifyReply, review: { id: string; reviewStatus: string; programmingLanguage: string; createdAt: Date }, replayed = false): FastifyReply {
  const body = { review: { id: review.id, status: review.reviewStatus, programmingLanguage: review.programmingLanguage, createdAt: review.createdAt, statusUrl: `/api/reviews/${review.id}` } };
  if (replayed) reply.header('idempotency-replayed', 'true');
  return reply.code(replayed ? 200 : 202).header('location', `/api/reviews/${review.id}`).send(body);
}

export async function reviewRoutes(app: FastifyInstance, dependencies: ReviewRouteDependencies): Promise<void> {
  app.post('/api/reviews', { preHandler: app.requireAuth, bodyLimit: REVIEW_REQUEST_BODY_LIMIT }, async (request, reply) => {
    if (!sameOrigin(request, dependencies.frontendUrl)) return reply.code(403).send({ error: { code: 'ORIGIN_FORBIDDEN', message: 'Request origin is not allowed' } });
    const rawBody = request.body as Record<string, unknown>;
    if (typeof rawBody?.sourceCode === 'string' && Buffer.byteLength(rawBody.sourceCode, 'utf8') > SOURCE_CODE_MAX_BYTES) {
      return reply.code(413).send({ error: { code: 'SOURCE_TOO_LARGE', message: 'Source code exceeds the maximum size' } });
    }
    const parsed = createReviewSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: { code: 'INVALID_INPUT', message: 'Invalid review details' } });
    const idempotencyKey = request.headers['idempotency-key'];
    if (idempotencyKey !== undefined && (typeof idempotencyKey !== 'string' || !/^[\x21-\x7e]{1,128}$/.test(idempotencyKey))) {
      return reply.code(400).send({ error: { code: 'INVALID_INPUT', message: 'Invalid Idempotency-Key' } });
    }
    const window = fixedWindow(Date.now(), REVIEW_RATE_LIMIT.windowMs);
    try {
      const count = await dependencies.rateLimits.increment(rateLimitKey(dependencies.rateLimitHmacSecret, request.auth!.userId, window.start), window.expiresAt);
      if (count > REVIEW_RATE_LIMIT.limit) {
        const retryAfter = Math.max(1, Math.ceil((window.expiresAt.getTime() - Date.now()) / 1000));
        return reply.code(429).header('retry-after', String(retryAfter)).send({ error: { code: 'RATE_LIMITED', message: 'Too many review submissions' } });
      }
      const result = await dependencies.reviews.createReview(request.auth!.userId, parsed.data, idempotencyKey);
      return acceptedResponse(reply, result.review, result.replayed);
    } catch (error) { return errorResponse(reply, error); }
  });

  app.get('/api/reviews', { preHandler: app.requireAuth }, async (request, reply) => {
    const parsed = listReviewsQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: { code: 'INVALID_INPUT', message: 'Invalid review query' } });
    try {
      const result = await dependencies.reviews.listReviews(request.auth!.userId, parsed.data);
      return reply.code(200).send(result);
    } catch (error) { return errorResponse(reply, error); }
  });

  app.get('/api/reviews/:reviewId', { preHandler: app.requireAuth }, async (request, reply) => {
    const parsed = reviewIdSchema.safeParse(request.params);
    if (!parsed.success) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Review not found' } });
    try { return reply.code(200).send({ review: await dependencies.reviews.getReview(request.auth!.userId, parsed.data.reviewId) }); }
    catch (error) { return errorResponse(reply, error); }
  });

  app.get('/api/reviews/:reviewId/results', { preHandler: app.requireAuth }, async (request, reply) => {
    const parsed = reviewIdSchema.safeParse(request.params);
    if (!parsed.success) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Review not found' } });
    try {
      const result = await dependencies.reviews.getResults(request.auth!.userId, parsed.data.reviewId);
      if (result.status === 'FAILED' || result.status === 'CANCELLED') return reply.code(409).send({ error: { code: 'REVIEW_NOT_COMPLETED', message: 'Review did not complete successfully' }, review: { status: result.status } });
      if (result.status !== 'COMPLETED' || result.result === null) return reply.code(202).send({ reviewId: parsed.data.reviewId, status: result.status, result: null });
      return reply.code(200).send({ reviewId: parsed.data.reviewId, status: result.status, result: result.result });
    } catch (error) { return errorResponse(reply, error); }
  });

  app.get('/api/reviews/:reviewId/issues/:issueId', { preHandler: app.requireAuth }, async (request, reply) => {
    const parsed = issueParamsSchema.safeParse(request.params);
    if (!parsed.success) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Review issue not found' } });
    try { return reply.code(200).send({ issue: await dependencies.reviews.getIssue(request.auth!.userId, parsed.data.reviewId, parsed.data.issueId) }); }
    catch (error) { return errorResponse(reply, error); }
  });
}
