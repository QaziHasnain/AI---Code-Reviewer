import { createHash, createHmac, randomBytes } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { PersistentAuthRateLimitStore } from '@/security/auth/rate-limit-store.js';

const shouldRun = process.env.RUN_SESSION_DB_INTEGRATION_TESTS === 'true'
  && Boolean(process.env.TEST_DATABASE_URL);

describe.skipIf(!shouldRun)('Persistent auth rate limiter PostgreSQL integration', () => {
  it('atomically increments concurrent requests and removes expired buckets without storing the input key', async () => {
    const prisma = new PrismaClient({ datasources: { db: { url: process.env.TEST_DATABASE_URL } } });
    const store = new PersistentAuthRateLimitStore(prisma.authRateLimitBucket);
    const rawIp = `198.51.100.${randomBytes(16).toString('hex')}`;
    const key = createHmac('sha256', Buffer.alloc(32, 9)).update(`register:${rawIp}:1800000000000`).digest('hex');
    const bucketKey = createHash('sha256').update(key).digest('hex');
    const expiredKey = createHash('sha256').update(`expired-${randomBytes(16).toString('hex')}`).digest('hex');
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);

    try {
      await prisma.authRateLimitBucket.create({ data: { key: expiredKey, count: 7, expiresAt: new Date(Date.now() - 1000) } });
      const counts = await Promise.all(Array.from({ length: 20 }, () => store.increment(key, expiresAt)));
      expect(counts.sort((a, b) => a - b)).toEqual(Array.from({ length: 20 }, (_, index) => index + 1));
      const stored = await prisma.authRateLimitBucket.findUnique({ where: { key: bucketKey } });
      expect(stored?.count).toBe(20);
      expect(stored?.key).not.toContain(rawIp);
      expect(await prisma.authRateLimitBucket.findUnique({ where: { key: expiredKey } })).toBeNull();
    } finally {
      await prisma.authRateLimitBucket.deleteMany({ where: { key: { in: [bucketKey, expiredKey] } } });
      await prisma.$disconnect();
    }
  });
});
