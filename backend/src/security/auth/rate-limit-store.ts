import { createHash } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';

type RateLimitBucketDelegate = Pick<PrismaClient['authRateLimitBucket'], 'deleteMany' | 'upsert'>;

/** PostgreSQL-backed increment. The upsert increment is atomic across concurrent requests. */
export class PersistentAuthRateLimitStore {
  constructor(private readonly buckets: RateLimitBucketDelegate) {}

  async increment(key: string, expiresAt: Date): Promise<number> {
    await this.buckets.deleteMany({ where: { expiresAt: { lt: new Date() } } });
    const bucketKey = createHash('sha256').update(key).digest('hex');
    const bucket = await this.buckets.upsert({
      where: { key: bucketKey },
      create: { key: bucketKey, count: 1, expiresAt },
      update: { count: { increment: 1 } },
      select: { count: true },
    });
    return bucket.count;
  }
}
