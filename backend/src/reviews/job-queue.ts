import { randomUUID } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';

export const DEFAULT_REVIEW_JOB_LEASE_DURATION_MS = 60_000;
export const MAX_REVIEW_JOB_ATTEMPTS = 5;
export const MAX_REVIEW_JOB_RECOVERY_BATCH_SIZE = 500;

export interface ClaimedReviewJob {
  id: string;
  codeReviewId: string;
  attemptCount: number;
  leaseToken: string;
  leaseExpiresAt: Date;
}

export type LeaseRenewalResult =
  | { renewed: true; leaseExpiresAt: Date }
  | { renewed: false; reason: 'LEASE_LOST' };

export interface RecoveredReviewJobs {
  retried: number;
  dead: number;
}

interface ClaimedJobRow {
  id: string;
  codeReviewId: string;
  attemptCount: number;
  leaseToken: string;
  leaseExpiresAt: Date;
}

interface RenewedLeaseRow {
  leaseExpiresAt: Date;
}

interface RecoveredJobRow {
  codeReviewId: string;
  status: 'RETRY_WAIT' | 'DEAD';
}

/** PostgreSQL-backed lease operations for the durable review-job queue. */
export class ReviewJobQueue {
  constructor(private readonly prisma: PrismaClient) {}

  async claimNextJob(leaseDurationMs = DEFAULT_REVIEW_JOB_LEASE_DURATION_MS): Promise<ClaimedReviewJob | null> {
    assertPositiveInteger(leaseDurationMs, 'leaseDurationMs');

    return this.prisma.$transaction(async (transaction) => {
      const leaseToken = randomUUID();
      const jobs = await transaction.$queryRaw<ClaimedJobRow[]>(Prisma.sql`
        WITH candidate AS (
          SELECT job."id"
          FROM "ReviewJob" AS job
          INNER JOIN "CodeReview" AS review ON review."id" = job."codeReviewId"
          WHERE job."status" IN ('QUEUED', 'RETRY_WAIT')
            AND job."availableAt" <= clock_timestamp()
            AND job."attemptCount" < ${MAX_REVIEW_JOB_ATTEMPTS}
            AND review."reviewStatus" IN ('SUBMITTED', 'PROCESSING')
          ORDER BY job."availableAt" ASC, job."createdAt" ASC, job."id" ASC
          FOR UPDATE OF job SKIP LOCKED
          LIMIT 1
        )
        UPDATE "ReviewJob" AS job
        SET "status" = 'PROCESSING',
            "leaseToken" = ${leaseToken}::uuid,
            "leaseExpiresAt" = clock_timestamp() + (${leaseDurationMs} * INTERVAL '1 millisecond'),
            "attemptCount" = job."attemptCount" + 1,
            "startedAt" = clock_timestamp(),
            "completedAt" = NULL,
            "updatedAt" = clock_timestamp()
        FROM candidate
        WHERE job."id" = candidate."id"
        RETURNING job."id", job."codeReviewId", job."attemptCount", job."leaseToken", job."leaseExpiresAt"
      `);

      const job = jobs[0];
      if (!job) return null;

      const updatedReviews = await transaction.$executeRaw(Prisma.sql`
        UPDATE "CodeReview"
        SET "reviewStatus" = 'PROCESSING', "updatedAt" = clock_timestamp()
        WHERE "id" = ${job.codeReviewId}::uuid
          AND "reviewStatus" IN ('SUBMITTED', 'PROCESSING')
      `);
      if (updatedReviews !== 1) throw new Error('Claimed review could not transition to PROCESSING');

      return job;
    });
  }

  async renewLease(
    jobId: string,
    leaseToken: string,
    leaseDurationMs = DEFAULT_REVIEW_JOB_LEASE_DURATION_MS,
  ): Promise<LeaseRenewalResult> {
    assertPositiveInteger(leaseDurationMs, 'leaseDurationMs');

    return this.prisma.$transaction(async (transaction) => {
      const rows = await transaction.$queryRaw<RenewedLeaseRow[]>(Prisma.sql`
        UPDATE "ReviewJob"
        SET "leaseExpiresAt" = clock_timestamp() + (${leaseDurationMs} * INTERVAL '1 millisecond'),
            "updatedAt" = clock_timestamp()
        WHERE "id" = ${jobId}::uuid
          AND "status" = 'PROCESSING'
          AND "leaseToken" = ${leaseToken}::uuid
          AND "leaseExpiresAt" > clock_timestamp()
        RETURNING "leaseExpiresAt"
      `);
      const renewed = rows[0];
      return renewed
        ? { renewed: true, leaseExpiresAt: renewed.leaseExpiresAt }
        : { renewed: false, reason: 'LEASE_LOST' };
    });
  }

  async recoverExpiredJobs(limit = 100): Promise<RecoveredReviewJobs> {
    assertPositiveInteger(limit, 'limit');
    if (limit > MAX_REVIEW_JOB_RECOVERY_BATCH_SIZE) {
      throw new RangeError(`limit must not exceed ${MAX_REVIEW_JOB_RECOVERY_BATCH_SIZE}`);
    }

    return this.prisma.$transaction(async (transaction) => {
      const jobs = await transaction.$queryRaw<RecoveredJobRow[]>(Prisma.sql`
        WITH expired AS (
          SELECT job."id", job."codeReviewId", job."attemptCount"
          FROM "ReviewJob" AS job
          WHERE job."status" = 'PROCESSING'
            AND job."leaseExpiresAt" <= clock_timestamp()
          ORDER BY job."leaseExpiresAt" ASC, job."createdAt" ASC, job."id" ASC
          FOR UPDATE OF job SKIP LOCKED
          LIMIT ${limit}
        ), recovered AS (
          UPDATE "ReviewJob" AS job
          SET "status" = CASE WHEN expired."attemptCount" >= ${MAX_REVIEW_JOB_ATTEMPTS}
                               THEN 'DEAD'::"ReviewJobStatus"
                               ELSE 'RETRY_WAIT'::"ReviewJobStatus" END,
              "availableAt" = clock_timestamp(),
              "leaseToken" = NULL,
              "leaseExpiresAt" = NULL,
              "lastErrorCode" = CASE WHEN expired."attemptCount" >= ${MAX_REVIEW_JOB_ATTEMPTS}
                                      THEN 'MAX_ATTEMPTS_EXCEEDED'
                                      ELSE 'WORKER_LEASE_EXPIRED' END,
              "completedAt" = CASE WHEN expired."attemptCount" >= ${MAX_REVIEW_JOB_ATTEMPTS}
                                   THEN clock_timestamp()
                                   ELSE NULL END,
              "updatedAt" = clock_timestamp()
          FROM expired
          WHERE job."id" = expired."id"
          RETURNING job."codeReviewId", job."status"
        )
        SELECT "codeReviewId", "status" FROM recovered
      `);

      for (const job of jobs) {
        const isDead = job.status === 'DEAD';
        const updatedReviews = await transaction.$executeRaw(Prisma.sql`
          UPDATE "CodeReview"
          SET "reviewStatus" = ${isDead ? 'FAILED' : 'SUBMITTED'}::"ReviewStatus",
              "failedAt" = CASE WHEN ${isDead} THEN clock_timestamp() ELSE NULL END,
              "failureCode" = CASE WHEN ${isDead} THEN 'MAX_ATTEMPTS_EXCEEDED' ELSE NULL END,
              "updatedAt" = clock_timestamp()
          WHERE "id" = ${job.codeReviewId}::uuid
            AND "reviewStatus" = 'PROCESSING'
        `);
        if (updatedReviews !== 1) throw new Error('Recovered review could not transition with its job');
      }

      return {
        retried: jobs.filter((job) => job.status === 'RETRY_WAIT').length,
        dead: jobs.filter((job) => job.status === 'DEAD').length,
      };
    });
  }
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 2_147_483_647) {
    throw new RangeError(`${name} must be a positive 32-bit integer`);
  }
}
