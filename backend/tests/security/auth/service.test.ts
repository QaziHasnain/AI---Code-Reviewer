import { describe, expect, it, vi } from 'vitest';
import { AuthError, AuthService, AUTHENTICATION_FAILED_MESSAGE } from '@/security/auth/index.js';
import type { PublicSession } from '@/security/session/types.js';

const user = {
  id: 'user-id',
  name: 'Reviewer',
  email: 'user@example.com',
  createdAt: new Date('2030-01-01T00:00:00.000Z'),
};
const publicSession: PublicSession = {
  id: 'session-id', userId: user.id, expiresAt: new Date('2030-01-08T00:00:00.000Z'),
  createdAt: new Date('2030-01-01T00:00:00.000Z'), lastSeenAt: null, revokedAt: null,
  userAgent: null, ipHash: null,
};

function setup() {
  const prisma = {
    user: {
      create: vi.fn().mockResolvedValue(user),
      findUnique: vi.fn(),
    },
  };
  const sessions = { createSession: vi.fn().mockResolvedValue({ token: 'raw-session-token', session: publicSession }) };
  const hash = vi.fn().mockResolvedValue({ hash: '$argon2id$private-hash', algorithm: 'argon2id' as const });
  const verify = vi.fn().mockResolvedValue({ valid: true, needsRehash: false });
  const service = new AuthService({ prisma, sessions, hashPassword: hash, verifyPassword: verify });
  return { prisma, sessions, hash, verify, service };
}

describe('AuthService registration', () => {
  it('normalizes email, hashes the unchanged password, creates a session, and returns public fields only', async () => {
    const { prisma, sessions, hash, service } = setup();
    const password = '  SecurePass123!Ab  ';

    const result = await service.register({ name: 'Reviewer', email: ' USER@Example.COM ', password });

    expect(hash).toHaveBeenCalledWith(password);
    expect(prisma.user.create).toHaveBeenCalledWith(expect.objectContaining({
      data: { name: 'Reviewer', email: 'user@example.com', passwordHash: '$argon2id$private-hash' },
      select: { id: true, name: true, email: true, createdAt: true },
    }));
    expect(sessions.createSession).toHaveBeenCalledWith(user.id);
    expect(result.user).toEqual(user);
    expect(result.user).not.toHaveProperty('passwordHash');
    expect(result).not.toHaveProperty('session.tokenHash');
  });

  it('maps duplicate email and unique-constraint races to the same safe conflict', async () => {
    const { prisma, service } = setup();
    prisma.user.create.mockRejectedValue(Object.assign(new Error('sensitive database detail'), {
      code: 'P2002', meta: { target: ['email'] },
    }));
    await expect(service.register({ name: 'Reviewer', email: 'user@example.com', password: 'SecurePass123!' }))
      .rejects.toMatchObject({ code: 'EMAIL_ALREADY_EXISTS', message: 'An account with this email already exists' });
  });

  it('hides unexpected database errors', async () => {
    const { prisma, service } = setup();
    prisma.user.create.mockRejectedValue(new Error('postgres passwordHash leaked'));
    await expect(service.register({ name: 'Reviewer', email: 'user@example.com', password: 'SecurePass123!' }))
      .rejects.toMatchObject({ code: 'OPERATION_FAILED', message: 'Authentication operation failed' });
  });
});

describe('AuthService login', () => {
  it('authenticates a normalized email and returns only public user data', async () => {
    const { prisma, sessions, verify, service } = setup();
    prisma.user.findUnique.mockResolvedValue({ ...user, passwordHash: '$argon2id$private-hash' });

    const result = await service.login({ email: ' USER@Example.COM ', password: 'SecurePass123!' });

    expect(prisma.user.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { email: 'user@example.com' } }));
    expect(verify).toHaveBeenCalledWith('SecurePass123!', '$argon2id$private-hash');
    expect(sessions.createSession).toHaveBeenCalledWith(user.id);
    expect(result.user).toEqual(user);
    expect(result.user).not.toHaveProperty('passwordHash');
  });

  it('uses dummy verification and a generic failure for unknown email', async () => {
    const { prisma, verify, service } = setup();
    prisma.user.findUnique.mockResolvedValue(null);
    await expect(service.login({ email: 'unknown@example.com', password: 'SecurePass123!' }))
      .rejects.toMatchObject({ code: 'AUTHENTICATION_FAILED', message: AUTHENTICATION_FAILED_MESSAGE });
    expect(verify).toHaveBeenCalledWith('codex-dummy-auth-password', expect.stringMatching(/^\$argon2id\$/));
  });

  it('uses dummy verification for short passwords on existing accounts', async () => {
    const { prisma, verify, service } = setup();
    prisma.user.findUnique.mockResolvedValue({ ...user, passwordHash: '$argon2id$stored-hash' });
    await expect(service.login({ email: user.email, password: 'short' }))
      .rejects.toMatchObject({ code: 'AUTHENTICATION_FAILED', message: AUTHENTICATION_FAILED_MESSAGE });
    expect(verify).toHaveBeenCalledTimes(1);
    expect(verify).toHaveBeenCalledWith('codex-dummy-auth-password', expect.stringMatching(/^\$argon2id\$/));
  });

  it('returns the generic failure for incorrect passwords', async () => {
    const { prisma, verify, service } = setup();
    prisma.user.findUnique.mockResolvedValue({ ...user, passwordHash: '$argon2id$stored-hash' });
    verify.mockResolvedValue({ valid: false, needsRehash: false });
    await expect(service.login({ email: user.email, password: 'WrongPassword123' }))
      .rejects.toMatchObject({ code: 'AUTHENTICATION_FAILED', message: AUTHENTICATION_FAILED_MESSAGE });
  });

  it('handles malformed stored hashes with dummy verification and a generic failure', async () => {
    const { prisma, verify, service } = setup();
    prisma.user.findUnique.mockResolvedValue({ ...user, passwordHash: 'malformed-hash' });
    verify.mockRejectedValueOnce(new Error('argon2 hash parser details')).mockResolvedValueOnce({ valid: false, needsRehash: false });
    await expect(service.login({ email: user.email, password: 'SecurePass123!' }))
      .rejects.toMatchObject({ code: 'AUTHENTICATION_FAILED', message: AUTHENTICATION_FAILED_MESSAGE });
    expect(verify).toHaveBeenNthCalledWith(2, 'codex-dummy-auth-password', expect.stringMatching(/^\$argon2id\$/));
  });

  it('does not expose database details in returned errors', async () => {
    const { prisma, service } = setup();
    prisma.user.findUnique.mockRejectedValue(new Error('database credentials leaked'));
    const error = await service.login({ email: user.email, password: 'SecurePass123!' }).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(AuthError);
    expect(error).toMatchObject({ code: 'OPERATION_FAILED', message: 'Authentication operation failed' });
    expect(String(error)).not.toContain('database credentials');
  });
});
