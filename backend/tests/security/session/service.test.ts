import { describe, expect, it, vi } from 'vitest';
import { SessionError, SessionService } from '@/security/session/index.js';
import { hashToken } from '@/security/token/hash.js';

function makeSession(overrides: Record<string, unknown> = {}) {
  return {
    id: 'session-id',
    userId: 'user-id',
    expiresAt: new Date('2030-01-08T00:00:00.000Z'),
    createdAt: new Date('2030-01-01T00:00:00.000Z'),
    lastSeenAt: null,
    revokedAt: null,
    userAgent: null,
    ipHash: null,
    ...overrides,
  };
}

function makePrisma() {
  return {
    session: {
      create: vi.fn(),
      findUnique: vi.fn(),
      updateMany: vi.fn(),
    },
  };
}

describe('SessionService', () => {
  it('creates a session with only a token hash persisted', async () => {
    const prisma = makePrisma();
    prisma.session.create.mockResolvedValue(makeSession());
    const service = new SessionService(prisma);

    const result = await service.createSession('user-id', {
      now: new Date('2030-01-01T00:00:00.000Z'),
      userAgent: 'test-agent',
    });
    const createCall = prisma.session.create.mock.calls[0][0];

    expect(result.token).toMatch(/^[0-9a-f]{64}$/);
    expect(createCall.data.userId).toBe('user-id');
    expect(createCall.data.tokenHash).toBe(hashToken(result.token).hash);
    expect(createCall.data.tokenHash).not.toBe(result.token);
    expect(createCall.data.expiresAt).toEqual(new Date('2030-01-08T00:00:00.000Z'));
    expect(createCall.select).not.toHaveProperty('tokenHash');
    expect(result.session).not.toHaveProperty('tokenHash');
  });

  it('validates a non-expired, non-revoked session', async () => {
    const prisma = makePrisma();
    prisma.session.findUnique.mockResolvedValue(makeSession());
    const service = new SessionService(prisma);

    await expect(service.validateSession('raw-token', new Date('2030-01-07T00:00:00.000Z')))
      .resolves.toMatchObject({ id: 'session-id', userId: 'user-id' });
    expect(prisma.session.findUnique).toHaveBeenCalledWith(expect.objectContaining({
      where: { tokenHash: hashToken('raw-token').hash },
    }));
  });

  it('rejects unknown, expired, revoked, and empty tokens safely', async () => {
    const prisma = makePrisma();
    const service = new SessionService(prisma);

    prisma.session.findUnique.mockResolvedValue(null);
    await expect(service.validateSession('unknown')).rejects.toMatchObject({ code: 'SESSION_NOT_FOUND' });

    prisma.session.findUnique.mockResolvedValue(makeSession({
      expiresAt: new Date('2029-12-31T23:59:59.000Z'),
    }));
    await expect(service.validateSession('expired', new Date('2030-01-01T00:00:00.000Z')))
      .rejects.toMatchObject({ code: 'SESSION_EXPIRED' });

    prisma.session.findUnique.mockResolvedValue(makeSession({ revokedAt: new Date() }));
    await expect(service.validateSession('revoked')).rejects.toMatchObject({ code: 'SESSION_REVOKED' });
    await expect(service.validateSession('')).rejects.toMatchObject({ code: 'INVALID_TOKEN' });
  });

  it('revokes one session and distinguishes missing from already-revoked sessions', async () => {
    const prisma = makePrisma();
    const service = new SessionService(prisma);
    prisma.session.updateMany.mockResolvedValue({ count: 1 });

    await expect(service.revokeSession('raw-token', new Date('2030-01-02T00:00:00.000Z'))).resolves.toBeUndefined();
    expect(prisma.session.updateMany).toHaveBeenCalledWith({
      where: { tokenHash: hashToken('raw-token').hash, revokedAt: null },
      data: { revokedAt: new Date('2030-01-02T00:00:00.000Z') },
    });

    prisma.session.updateMany.mockResolvedValue({ count: 0 });
    prisma.session.findUnique.mockResolvedValue(null);
    await expect(service.revokeSession('missing')).rejects.toMatchObject({ code: 'SESSION_NOT_FOUND' });

    prisma.session.findUnique.mockResolvedValue({ revokedAt: new Date() });
    await expect(service.revokeSession('revoked')).rejects.toMatchObject({ code: 'SESSION_REVOKED' });
    expect(prisma.session.findUnique).toHaveBeenCalledWith({
      where: { tokenHash: hashToken('revoked').hash },
      select: { revokedAt: true },
    });
  });

  it('revokes all active sessions for a user', async () => {
    const prisma = makePrisma();
    prisma.session.updateMany.mockResolvedValue({ count: 2 });
    const service = new SessionService(prisma);

    await expect(service.revokeAllSessions('user-id')).resolves.toBe(2);
    expect(prisma.session.updateMany).toHaveBeenCalledWith({
      where: { userId: 'user-id', revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    });
  });

  it('maps database failures to a non-sensitive session error', async () => {
    const prisma = makePrisma();
    prisma.session.findUnique.mockRejectedValue(new Error('postgres secret details'));
    const service = new SessionService(prisma);

    await expect(service.validateSession('token')).rejects.toEqual(
      expect.objectContaining({
        name: 'SessionError',
        code: 'DATABASE_ERROR',
        message: 'Session operation failed',
      }),
    );
    await expect(service.validateSession('token')).rejects.not.toThrow('postgres secret details');
  });

  it('uses the typed error class for invalid sessions', async () => {
    const prisma = makePrisma();
    prisma.session.findUnique.mockResolvedValue(null);
    const service = new SessionService(prisma);

    await expect(service.validateSession('token')).rejects.toBeInstanceOf(SessionError);
  });
});

