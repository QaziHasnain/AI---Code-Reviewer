import { createHash } from 'node:crypto';
import type { Prisma, PrismaClient } from '@prisma/client';
import type { CreateReviewInput, ListReviewsQuery } from './schemas.js';

const reviewSelect = {
  id: true,
  programmingLanguage: true,
  reviewStatus: true,
  repository: true,
  branch: true,
  commitHash: true,
  completedAt: true,
  failedAt: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.CodeReviewSelect;

const resultSelect = {
  id: true,
  outcome: true,
  score: true,
  summary: true,
  detailedAnalysis: true,
  aiProvider: true,
  aiModel: true,
  promptTokenUsage: true,
  completionTokenUsage: true,
  processingDuration: true,
  createdAt: true,
  issues: {
    orderBy: [{ severity: 'desc' }, { id: 'asc' }],
    select: {
      id: true,
      title: true,
      description: true,
      severity: true,
      type: true,
      status: true,
      filePath: true,
      lineStart: true,
      lineEnd: true,
      startColumn: true,
      endColumn: true,
      suggestedFix: true,
      createdAt: true,
      updatedAt: true,
    },
  },
} satisfies Prisma.ReviewResultSelect;

export type ReviewPrisma = Pick<PrismaClient, 'codeReview' | 'reviewJob' | 'reviewResult' | 'reviewIssue' | 'reviewIdempotencyKey'> & {
  $transaction<T>(callback: (transaction: ReviewTransaction) => Promise<T>): Promise<T>;
};

export type ReviewTransaction = Pick<PrismaClient, 'codeReview' | 'reviewJob' | 'reviewIdempotencyKey'>;

export type ReviewSummary = Prisma.CodeReviewGetPayload<{ select: typeof reviewSelect }>;
export type ReviewResultView = Prisma.ReviewResultGetPayload<{ select: typeof resultSelect }>;

export class ReviewServiceError extends Error {
  constructor(
    message: string,
    readonly code: 'IDEMPOTENCY_KEY_REUSED' | 'REVIEW_NOT_FOUND' | 'REVIEW_NOT_COMPLETED' | 'REVIEW_FAILED' | 'RESULT_MISSING' | 'INVALID_CURSOR' | 'STORAGE_UNAVAILABLE',
  ) {
    super(message);
    this.name = 'ReviewServiceError';
  }
}

export interface CreateReviewResult {
  review: ReviewSummary;
  replayed: boolean;
}

export interface ListReviewResult {
  items: ReviewSummary[];
  nextCursor: string | null;
}

interface ReviewCursor {
  createdAt: string;
  id: string;
}

function canonicalPayload(input: CreateReviewInput): string {
  return JSON.stringify({
    sourceCode: input.sourceCode,
    programmingLanguage: input.programmingLanguage,
    instructions: input.instructions ?? null,
    repository: input.repository ?? null,
    branch: input.branch ?? null,
    commitHash: input.commitHash ?? null,
  });
}

function requestHash(input: CreateReviewInput): string {
  return createHash('sha256').update(canonicalPayload(input), 'utf8').digest('hex');
}

function encodeCursor(cursor: ReviewCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function decodeCursor(value: string): ReviewCursor {
  try {
    const decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Partial<ReviewCursor>;
    if (typeof decoded.id !== 'string' || !/^[0-9a-f-]{36}$/i.test(decoded.id) || typeof decoded.createdAt !== 'string') {
      throw new Error('invalid cursor');
    }
    const createdAt = new Date(decoded.createdAt);
    if (Number.isNaN(createdAt.getTime())) throw new Error('invalid cursor');
    return { id: decoded.id, createdAt: createdAt.toISOString() };
  } catch {
    throw new ReviewServiceError('Invalid pagination cursor', 'INVALID_CURSOR');
  }
}

function isUniqueConstraint(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002';
}

export class ReviewService {
  constructor(private readonly prisma: ReviewPrisma) {}

  async createReview(userId: string, input: CreateReviewInput, idempotencyKey?: string): Promise<CreateReviewResult> {
    const hash = requestHash(input);
    const data = {
      userId,
      sourceCode: input.sourceCode,
      programmingLanguage: input.programmingLanguage,
      reviewStatus: 'SUBMITTED' as const,
      instructions: input.instructions ?? null,
      repository: input.repository ?? null,
      branch: input.branch ?? null,
      commitHash: input.commitHash ?? null,
    } satisfies Prisma.CodeReviewUncheckedCreateInput;

    try {
      return await this.prisma.$transaction(async (transaction) => {
        if (idempotencyKey) {
          const existing = await transaction.reviewIdempotencyKey.findUnique({
            where: { userId_key: { userId, key: idempotencyKey } },
            select: { requestHash: true, codeReview: { select: reviewSelect } },
          });
          if (existing) {
            if (existing.requestHash !== hash) throw new ReviewServiceError('Idempotency key was already used with a different request', 'IDEMPOTENCY_KEY_REUSED');
            return { review: existing.codeReview, replayed: true };
          }
        }

        const review = await transaction.codeReview.create({ data, select: reviewSelect });
        await transaction.reviewJob.create({
          data: { codeReviewId: review.id, status: 'QUEUED' },
          select: { id: true },
        });
        if (idempotencyKey) {
          await transaction.reviewIdempotencyKey.create({
            data: { userId, key: idempotencyKey, requestHash: hash, codeReviewId: review.id },
          });
        }
        return { review, replayed: false };
      });
    } catch (error) {
      if (error instanceof ReviewServiceError) throw error;
      if (idempotencyKey && isUniqueConstraint(error)) {
        try {
          const existing = await this.prisma.reviewIdempotencyKey.findUnique({
            where: { userId_key: { userId, key: idempotencyKey } },
            select: { requestHash: true, codeReview: { select: reviewSelect } },
          });
          if (existing) {
            if (existing.requestHash !== hash) throw new ReviewServiceError('Idempotency key was already used with a different request', 'IDEMPOTENCY_KEY_REUSED');
            return { review: existing.codeReview, replayed: true };
          }
        } catch (lookupError) {
          if (lookupError instanceof ReviewServiceError) throw lookupError;
          throw new ReviewServiceError('Review storage is unavailable', 'STORAGE_UNAVAILABLE');
        }
      }
      throw new ReviewServiceError('Review storage is unavailable', 'STORAGE_UNAVAILABLE');
    }
  }

  async getReview(userId: string, reviewId: string): Promise<ReviewSummary> {
    try {
      const review = await this.prisma.codeReview.findFirst({ where: { id: reviewId, userId }, select: reviewSelect });
      if (!review) throw new ReviewServiceError('Review not found', 'REVIEW_NOT_FOUND');
      return review;
    } catch (error) {
      if (error instanceof ReviewServiceError) throw error;
      throw new ReviewServiceError('Review storage is unavailable', 'STORAGE_UNAVAILABLE');
    }
  }

  async listReviews(userId: string, query: ListReviewsQuery): Promise<ListReviewResult> {
    try {
      const cursor = query.cursor ? decodeCursor(query.cursor) : undefined;
      const comparison = cursor
        ? query.order === 'desc'
          ? [{ createdAt: { lt: new Date(cursor.createdAt) } }, { createdAt: new Date(cursor.createdAt), id: { lt: cursor.id } }]
          : [{ createdAt: { gt: new Date(cursor.createdAt) } }, { createdAt: new Date(cursor.createdAt), id: { gt: cursor.id } }]
        : undefined;
      const where: Prisma.CodeReviewWhereInput = {
        userId,
        ...(query.status ? { reviewStatus: query.status } : {}),
        ...(comparison ? { OR: comparison } : {}),
      };
      const rows = await this.prisma.codeReview.findMany({
        where,
        orderBy: [{ createdAt: query.order }, { id: query.order }],
        take: query.limit + 1,
        select: reviewSelect,
      });
      const hasMore = rows.length > query.limit;
      const items = hasMore ? rows.slice(0, query.limit) : rows;
      const last = items.at(-1);
      return { items, nextCursor: hasMore && last ? encodeCursor({ id: last.id, createdAt: last.createdAt.toISOString() }) : null };
    } catch (error) {
      if (error instanceof ReviewServiceError) throw error;
      throw new ReviewServiceError('Review storage is unavailable', 'STORAGE_UNAVAILABLE');
    }
  }

  async getResults(userId: string, reviewId: string): Promise<{ status: ReviewSummary['reviewStatus']; result: ReviewResultView | null }> {
    try {
      const review = await this.prisma.codeReview.findFirst({
        where: { id: reviewId, userId },
        select: { ...reviewSelect, result: { select: resultSelect } },
      });
      if (!review) throw new ReviewServiceError('Review not found', 'REVIEW_NOT_FOUND');
      if (review.reviewStatus === 'COMPLETED' && !review.result) {
        throw new ReviewServiceError('Completed review has no result', 'RESULT_MISSING');
      }
      return { status: review.reviewStatus, result: review.result };
    } catch (error) {
      if (error instanceof ReviewServiceError) throw error;
      throw new ReviewServiceError('Review storage is unavailable', 'STORAGE_UNAVAILABLE');
    }
  }

  async getIssue(userId: string, reviewId: string, issueId: string) {
    try {
      const issue = await this.prisma.reviewIssue.findFirst({
        where: { id: issueId, reviewResult: { codeReview: { id: reviewId, userId } } },
        select: {
          id: true, title: true, description: true, severity: true, type: true, status: true,
          filePath: true, lineStart: true, lineEnd: true, startColumn: true, endColumn: true,
          suggestedFix: true, createdAt: true, updatedAt: true,
        },
      });
      if (!issue) throw new ReviewServiceError('Review issue not found', 'REVIEW_NOT_FOUND');
      return issue;
    } catch (error) {
      if (error instanceof ReviewServiceError) throw error;
      throw new ReviewServiceError('Review storage is unavailable', 'STORAGE_UNAVAILABLE');
    }
  }
}

export { reviewSelect, resultSelect };
