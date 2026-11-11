import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { SessionService, SESSION_LIFETIME_MS } from '@/security/session/index.js';
import { hashToken } from '@/security/token/hash.js';
import { AuthService } from '@/security/auth/service.js';

const shouldRun = process.env.RUN_SESSION_DB_INTEGRATION_TESTS === 'true'
  && Boolean(process.env.TEST_DATABASE_URL);

describe.skipIf(!shouldRun)('SessionService PostgreSQL integration', () => {
  it('persists the digest, enforces seven-day expiry, rejects expired sessions, and revokes all user sessions', async () => {
    const prisma = new PrismaClient({
      datasources: { db: { url: process.env.TEST_DATABASE_URL } },
    });
    const userId = randomUUID();
    const email = `session-test-${userId}@example.test`;
    const now = new Date('2030-01-01T00:00:00.000Z');
    const service = new SessionService(prisma);

    try {
      await prisma.user.create({
        data: { id: userId, name: 'Session Integration Test', email, passwordHash: 'test-only' },
      });

      const first = await service.createSession(userId, { now });
      const firstStored = await prisma.session.findUnique({
        where: { tokenHash: hashToken(first.token).hash },
      });

      expect(firstStored).not.toBeNull();
      expect(firstStored?.tokenHash).toBe(hashToken(first.token).hash);
      expect(firstStored?.tokenHash).not.toBe(first.token);
      expect(firstStored?.expiresAt).toEqual(new Date(now.getTime() + SESSION_LIFETIME_MS));
      await expect(service.validateSession(first.token, now)).resolves.toMatchObject({ userId });
      await expect(service.validateSession(first.token, new Date(now.getTime() + SESSION_LIFETIME_MS)))
        .rejects.toMatchObject({ code: 'SESSION_EXPIRED' });

      const second = await service.createSession(userId, { now });
      const revokedCount = await service.revokeAllSessions(userId, new Date('2030-01-02T00:00:00.000Z'));

      expect(revokedCount).toBe(2);
      await expect(service.validateSession(first.token, now)).rejects.toMatchObject({ code: 'SESSION_REVOKED' });
      await expect(service.validateSession(second.token, now)).rejects.toMatchObject({ code: 'SESSION_REVOKED' });
    } finally {
      try {
        await prisma.session.deleteMany({ where: { userId } });
        await prisma.user.deleteMany({ where: { id: userId } });
      } finally {
        await prisma.$disconnect();
      }
    }
  });

  it('atomically rolls back registration user and session rows when session creation fails after insert', async () => {
    const prisma = new PrismaClient({ datasources: { db: { url: process.env.TEST_DATABASE_URL } } });
    const userId = randomUUID();
    const email = `auth-rollback-${userId}@example.test`;
    const tokenHash = hashToken(`rollback-${userId}`).hash;
    const sessions = {
      createSession: async (newUserId: string, _options: Record<string, never>, sessionDelegate: PrismaClient['session']) => {
        await sessionDelegate.create({
          data: { userId: newUserId, tokenHash, expiresAt: new Date(Date.now() + 60_000) },
          select: { id: true, userId: true, expiresAt: true, createdAt: true, lastSeenAt: true, revokedAt: true, userAgent: true, ipHash: true },
        });
        throw new Error('simulated failure after session insert');
      },
    };
    const service = new AuthService({ prisma, sessions });
    try {
      await expect(service.register({ name: 'Rollback Test', email, password: 'SecurePass123!' }))
        .rejects.toMatchObject({ code: 'OPERATION_FAILED' });
      await expect(prisma.user.findUnique({ where: { email } })).resolves.toBeNull();
      await expect(prisma.session.findUnique({ where: { tokenHash } })).resolves.toBeNull();
    } finally {
      await prisma.session.deleteMany({ where: { tokenHash } });
      await prisma.user.deleteMany({ where: { email } });
      await prisma.$disconnect();
    }
  });
});
