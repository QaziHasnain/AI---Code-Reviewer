import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { AuthService } from '@/security/auth/service.js';
import { PersistentAuthRateLimitStore } from '@/security/auth/rate-limit-store.js';
import { SessionService } from '@/security/session/index.js';
import { assertDedicatedTestDatabase } from '../security/database-safety.js';

const shouldRun = process.env.RUN_SESSION_DB_INTEGRATION_TESTS === 'true'
  && Boolean(process.env.TEST_DATABASE_URL);

describe.skipIf(!shouldRun)('Authentication routes PostgreSQL integration', () => {
  it('handles concurrent duplicate registration atomically and rejects oversized bodies before rate limiting', async () => {
    const { buildApp } = await import('@/app.js');
    const { PrismaClient } = await import('@prisma/client');
    delete process.env.DATABASE_URL;
    const prisma = new PrismaClient({ datasources: { db: { url: process.env.TEST_DATABASE_URL } } });
    await assertDedicatedTestDatabase(prisma);
    const sessions = new SessionService(prisma);
    const app = await buildApp({
      frontendUrl: 'http://localhost:3000',
      authentication: { prisma, sessions },
      authRoutes: {
        auth: new AuthService({ prisma, sessions }),
        sessions,
        rateLimits: new PersistentAuthRateLimitStore(prisma.authRateLimitBucket),
        frontendUrl: 'http://localhost:3000',
        rateLimitHmacSecret: process.env.RATE_LIMIT_HMAC_SECRET!,
      },
    });
    const email = `route-integration-${randomUUID()}@example.test`;
    try {
      const payload = { name: 'Integration', email, password: 'SecurePass123!' };
      const responses = await Promise.all(Array.from({ length: 2 }, () => app.inject({
        method: 'POST', url: '/api/auth/register', headers: { origin: 'http://localhost:3000' }, payload,
      })));
      expect(responses.map((response) => response.statusCode).sort()).toEqual([201, 409]);
      const user = await prisma.user.findUnique({ where: { email } });
      expect(user).not.toBeNull();
      expect(await prisma.user.count({ where: { email } })).toBe(1);
      expect(await prisma.session.count({ where: { userId: user!.id } })).toBe(1);

      const before = await prisma.authRateLimitBucket.count();
      const oversizedEmail = `oversized-${randomUUID()}@example.test`;
      const oversized = await app.inject({
        method: 'POST', url: '/api/auth/login', headers: { origin: 'http://localhost:3000' },
        payload: { email: oversizedEmail, password: 'x'.repeat(1_100_000) },
      });
      expect(oversized.statusCode).toBe(413);
      expect(await prisma.authRateLimitBucket.count()).toBe(before);
      expect(await prisma.user.findUnique({ where: { email: oversizedEmail } })).toBeNull();
    } finally {
      await app.close();
      await assertDedicatedTestDatabase(prisma);
      await prisma.session.deleteMany({ where: { user: { email } } });
      await prisma.user.deleteMany({ where: { email } });
      await prisma.$disconnect();
    }
  });
});
