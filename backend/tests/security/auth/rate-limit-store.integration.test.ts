import { createHash, createHmac, randomBytes } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { PersistentAuthRateLimitStore } from '@/security/auth/rate-limit-store.js';
import { assertDedicatedTestDatabase } from '../database-safety.js';

const shouldRun = process.env.RUN_SESSION_DB_INTEGRATION_TESTS === 'true'
  && Boolean(process.env.TEST_DATABASE_URL);

describe.skipIf(!shouldRun)('Persistent auth rate limiter PostgreSQL integration', () => {
  it('shares increments between separate Prisma clients and keeps IP buckets isolated', async () => {
    const first = new PrismaClient({ datasources: { db: { url: process.env.TEST_DATABASE_URL } } });
    const second = new PrismaClient({ datasources: { db: { url: process.env.TEST_DATABASE_URL } } });
    const secret = Buffer.alloc(32, 7);
    const windowStart = Date.now();
    const ipA = `198.51.100.${randomBytes(4).readUInt8(0)}`;
    const ipB = `203.0.113.${randomBytes(4).readUInt8(0)}`;
    const a = createHmac('sha256', secret).update(`login:${ipA}:${windowStart}`).digest('hex');
    const b = createHmac('sha256', secret).update(`login:${ipB}:${windowStart}`).digest('hex');
    const expiresAt = new Date(Date.now() + 60_000);
    await assertDedicatedTestDatabase(first);
    await assertDedicatedTestDatabase(second);
    try {
      const one = new PersistentAuthRateLimitStore(first.authRateLimitBucket);
      const other = new PersistentAuthRateLimitStore(second.authRateLimitBucket);
      expect(await one.increment(a, expiresAt)).toBe(1);
      expect(await other.increment(a, expiresAt)).toBe(2);
      expect(await other.increment(b, expiresAt)).toBe(1);
    } finally {
      await assertDedicatedTestDatabase(first);
      await first.authRateLimitBucket.deleteMany({ where: { key: { in: [createHash('sha256').update(a).digest('hex'), createHash('sha256').update(b).digest('hex')] } } });
      await Promise.all([first.$disconnect(), second.$disconnect()]);
    }
  });

  it('atomically increments concurrent requests and removes expired buckets without storing the input key', async () => {
    const prisma = new PrismaClient({ datasources: { db: { url: process.env.TEST_DATABASE_URL } } });
    const store = new PersistentAuthRateLimitStore(prisma.authRateLimitBucket);
    const rawIp = `198.51.100.${randomBytes(16).toString('hex')}`;
    const key = createHmac('sha256', Buffer.alloc(32, 9)).update(`register:${rawIp}:1800000000000`).digest('hex');
    const bucketKey = createHash('sha256').update(key).digest('hex');
    const expiredKey = createHash('sha256').update(`expired-${randomBytes(16).toString('hex')}`).digest('hex');
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);

    await assertDedicatedTestDatabase(prisma);
    try {
      await prisma.authRateLimitBucket.create({ data: { key: expiredKey, count: 7, expiresAt: new Date(Date.now() - 1000) } });
      const counts = await Promise.all(Array.from({ length: 20 }, () => store.increment(key, expiresAt)));
      expect(counts.sort((a, b) => a - b)).toEqual(Array.from({ length: 20 }, (_, index) => index + 1));
      const stored = await prisma.authRateLimitBucket.findUnique({ where: { key: bucketKey } });
      expect(stored?.count).toBe(20);
      expect(stored?.key).not.toContain(rawIp);
      expect(await prisma.authRateLimitBucket.findUnique({ where: { key: expiredKey } })).toBeNull();
    } finally {
      await assertDedicatedTestDatabase(prisma);
      await prisma.authRateLimitBucket.deleteMany({ where: { key: { in: [bucketKey, expiredKey] } } });
      await prisma.$disconnect();
    }
  });
});
