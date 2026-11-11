import { describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { buildApp } from '@/app.js';
import type { AuthService } from '@/security/auth/service.js';
import { AuthError } from '@/security/auth/types.js';
import type { PublicSession } from '@/security/session/types.js';

const publicUser = { id: 'user-id', name: 'Reviewer', email: 'user@example.com', createdAt: new Date('2030-01-01T00:00:00Z') };
const publicSession: PublicSession = {
  id: 'session-id', userId: publicUser.id, expiresAt: new Date('2030-01-08T00:00:00Z'),
  createdAt: publicUser.createdAt, lastSeenAt: null, revokedAt: null, userAgent: null, ipHash: null,
};
const authResult = { user: publicUser, session: { token: 'new-secret-token', session: publicSession } };
const originHeaders = { origin: 'http://localhost:3000' };

function setup(trustedProxyAddresses?: string[]) {
  const auth = {
    register: vi.fn().mockResolvedValue(authResult),
    login: vi.fn().mockResolvedValue(authResult),
  } as unknown as AuthService;
  const sessions = { revokeSession: vi.fn().mockResolvedValue(undefined) };
  const rateLimits = { increment: vi.fn().mockResolvedValue(1) };
  const appPromise = buildApp({
    frontendUrl: 'http://localhost:3000',
    trustedProxyAddresses,
    authRoutes: { auth, sessions, rateLimits, frontendUrl: 'http://localhost:3000', rateLimitHmacSecret: 'a'.repeat(64) },
  });
  return { auth, sessions, rateLimits, appPromise };
}

describe('authentication routes', () => {
  it('registers, normalizes input, replaces an incoming session, and returns only safe user data', async () => {
    const { auth, sessions, appPromise } = setup();
    const app = await appPromise;
    const response = await app.inject({ method: 'POST', url: '/api/auth/register', headers: { ...originHeaders, cookie: 'session=old-token' }, payload: { name: 'Reviewer', email: ' USER@Example.COM ', password: 'SecurePass123!' } });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({ user: { ...publicUser, createdAt: publicUser.createdAt.toISOString() } });
    expect(response.body).not.toContain('new-secret-token');
    expect(response.body).not.toContain('passwordHash');
    expect(response.headers['set-cookie']).toContain('session=new-secret-token');
    expect(auth.register).toHaveBeenCalledWith({ name: 'Reviewer', email: 'user@example.com', password: 'SecurePass123!' });
    expect(sessions.revokeSession).toHaveBeenCalledWith('old-token');
    await app.close();
  });

  it('rejects malformed registration and maps duplicate email to 409', async () => {
    const { auth, appPromise } = setup();
    const app = await appPromise;
    const invalid = await app.inject({ method: 'POST', url: '/api/auth/register', headers: originHeaders, payload: { email: 'bad', password: 'x' } });
    expect(invalid.statusCode).toBe(400);
    expect(auth.register).not.toHaveBeenCalled();
    auth.register = vi.fn().mockRejectedValue(new AuthError('An account with this email already exists', 'EMAIL_ALREADY_EXISTS')) as never;
    const duplicate = await app.inject({ method: 'POST', url: '/api/auth/register', headers: originHeaders, payload: { name: 'Reviewer', email: 'user@example.com', password: 'SecurePass123!' } });
    expect(duplicate.statusCode).toBe(409);
    await app.close();
  });

  it('logs in and applies secure cookie attributes without returning a token', async () => {
    const { auth, sessions, rateLimits, appPromise } = setup();
    const app = await appPromise;
    const response = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { ...originHeaders, cookie: 'session=old-token' }, payload: { email: ' USER@Example.COM ', password: 'SecurePass123!' } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ user: { ...publicUser, createdAt: publicUser.createdAt.toISOString() } });
    expect(response.body).not.toContain('new-secret-token');
    expect(String(response.headers['set-cookie'])).toContain('HttpOnly');
    expect(String(response.headers['set-cookie'])).toContain('SameSite=Lax');
    expect(String(response.headers['set-cookie'])).toContain('Path=/');
    expect(sessions.revokeSession).toHaveBeenCalledWith('old-token');
    expect(rateLimits.increment).toHaveBeenCalledWith(expect.stringMatching(/^[a-f0-9]{64}$/), expect.any(Date));
    expect(auth.login).toHaveBeenCalledWith({ email: 'user@example.com', password: 'SecurePass123!' });
    await app.close();
  });

  it('uses a generic 401 for incorrect and nonexistent account errors and does not revoke the old session', async () => {
    const { auth, sessions, appPromise } = setup();
    const app = await appPromise;
    auth.login = vi.fn().mockRejectedValue(new AuthError('Invalid email or password', 'AUTHENTICATION_FAILED')) as never;
    for (const email of ['user@example.com', 'missing@example.com']) {
      const response = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { ...originHeaders, cookie: 'session=old-token' }, payload: { email, password: 'WrongPassword123' } });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({ error: { code: 'AUTHENTICATION_FAILED', message: 'Invalid email or password' } });
      expect(response.body).not.toContain('old-token');
    }
    expect(sessions.revokeSession).not.toHaveBeenCalled();
    await app.close();
  });

  it('enforces same-origin Origin or Referer and rate limits login attempts', async () => {
    const { rateLimits, auth, appPromise } = setup();
    const app = await appPromise;
    const blockedOrigin = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin: 'https://attacker.example' }, payload: { email: 'user@example.com', password: 'SecurePass123!' } });
    expect(blockedOrigin.statusCode).toBe(403);
    const referer = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { referer: 'http://localhost:3000/login' }, payload: { email: 'user@example.com', password: 'SecurePass123!' } });
    expect(referer.statusCode).toBe(200);
    rateLimits.increment.mockResolvedValue(11);
    const limited = await app.inject({ method: 'POST', url: '/api/auth/login', headers: originHeaders, payload: { email: 'user@example.com', password: 'SecurePass123!' } });
    expect(limited.statusCode).toBe(429);
    expect(auth.login).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it('fails closed when both origin headers are missing or the Referer is malformed', async () => {
    const { auth, appPromise } = setup();
    const app = await appPromise;
    const payload = { email: 'user@example.com', password: 'SecurePass123!' };
    const missingHeaders = await app.inject({ method: 'POST', url: '/api/auth/login', payload });
    const malformedReferer = await app.inject({ method: 'POST', url: '/api/auth/register', headers: { referer: 'http://[invalid' }, payload: { name: 'Reviewer', ...payload } });
    expect(missingHeaders.statusCode).toBe(403);
    expect(malformedReferer.statusCode).toBe(403);
    expect(auth.login).not.toHaveBeenCalled();
    expect(auth.register).not.toHaveBeenCalled();
    await app.close();
  });

  it('returns generic service errors for rate-limit and database failures', async () => {
    const { rateLimits, auth, appPromise } = setup();
    const app = await appPromise;
    rateLimits.increment.mockRejectedValue(new Error('database password leaked'));
    const limitedFailure = await app.inject({ method: 'POST', url: '/api/auth/login', headers: originHeaders, payload: { email: 'user@example.com', password: 'SecurePass123!' } });
    expect(limitedFailure.statusCode).toBe(503);
    expect(limitedFailure.body).not.toContain('database password');
    rateLimits.increment.mockResolvedValue(1);
    auth.login = vi.fn().mockRejectedValue({ code: 'OPERATION_FAILED', message: 'database internals' }) as never;
    const databaseFailure = await app.inject({ method: 'POST', url: '/api/auth/login', headers: originHeaders, payload: { email: 'user@example.com', password: 'SecurePass123!' } });
    expect(databaseFailure.statusCode).toBe(503);
    expect(databaseFailure.body).not.toContain('database internals');
    await app.close();
  });

  it('revokes the newly created session if replacement of the old session fails', async () => {
    const { sessions, appPromise } = setup();
    const app = await appPromise;
    sessions.revokeSession.mockRejectedValueOnce(Object.assign(new Error('database offline'), { code: 'DATABASE_ERROR' }));
    const response = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { ...originHeaders, cookie: 'session=old-token' }, payload: { email: 'user@example.com', password: 'SecurePass123!' } });
    expect(response.statusCode).toBe(503);
    expect(sessions.revokeSession).toHaveBeenNthCalledWith(1, 'old-token');
    expect(sessions.revokeSession).toHaveBeenNthCalledWith(2, 'new-secret-token');
    expect(response.body).not.toContain('database offline');
    await app.close();
  });

  it('also cleans up the new registration session when replacing the old session fails', async () => {
    const { sessions, appPromise } = setup();
    const app = await appPromise;
    sessions.revokeSession.mockRejectedValueOnce(Object.assign(new Error('database offline'), { code: 'DATABASE_ERROR' }));
    const response = await app.inject({ method: 'POST', url: '/api/auth/register', headers: { ...originHeaders, cookie: 'session=old-token' }, payload: { name: 'Reviewer', email: 'user@example.com', password: 'SecurePass123!' } });
    expect(response.statusCode).toBe(503);
    expect(sessions.revokeSession).toHaveBeenNthCalledWith(2, 'new-secret-token');
    await app.close();
  });

  it('keeps cleanup failures generic while preserving the replacement failure response', async () => {
    const { sessions, appPromise } = setup();
    const app = await appPromise;
    sessions.revokeSession
      .mockRejectedValueOnce(Object.assign(new Error('old-session database detail'), { code: 'DATABASE_ERROR' }))
      .mockRejectedValueOnce(new Error('cleanup database detail'));
    const response = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { ...originHeaders, cookie: 'session=old-token' }, payload: { email: 'user@example.com', password: 'SecurePass123!' } });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: { code: 'SERVICE_UNAVAILABLE', message: 'Authentication service unavailable' } });
    expect(response.body).not.toContain('database detail');
    await app.close();
  });

  it('applies the shared fixed-window threshold under concurrent requests', async () => {
    const { rateLimits, appPromise } = setup();
    let count = 0;
    rateLimits.increment.mockImplementation(async () => ++count);
    const app = await appPromise;
    const responses = await Promise.all(Array.from({ length: 20 }, () => app.inject({
      method: 'POST', url: '/api/auth/login', headers: originHeaders,
      payload: { email: 'user@example.com', password: 'SecurePass123!' },
    })));
    expect(responses.filter((response) => response.statusCode === 200)).toHaveLength(10);
    expect(responses.filter((response) => response.statusCode === 429)).toHaveLength(10);
    await app.close();
  });

  it('uses forwarded IP only when the direct peer matches an explicitly trusted proxy', async () => {
    const secret = Buffer.from('a'.repeat(64), 'hex');
    const direct = setup([]);
    const directApp = await direct.appPromise;
    await directApp.inject({ method: 'POST', url: '/api/auth/login', headers: { ...originHeaders, 'x-forwarded-for': '198.51.100.8' }, payload: { email: 'user@example.com', password: 'SecurePass123!' } });
    const windowStart = Math.floor(Date.now() / (15 * 60 * 1000)) * (15 * 60 * 1000);
    expect(direct.rateLimits.increment).toHaveBeenCalledWith(createHmac('sha256', secret).update(`127.0.0.1:${windowStart}`).digest('hex'), expect.any(Date));
    await directApp.close();

    const trusted = setup(['127.0.0.1']);
    const trustedApp = await trusted.appPromise;
    await trustedApp.inject({ method: 'POST', url: '/api/auth/login', headers: { ...originHeaders, 'x-forwarded-for': '198.51.100.8' }, payload: { email: 'user@example.com', password: 'SecurePass123!' } });
    expect(trusted.rateLimits.increment).toHaveBeenCalledWith(createHmac('sha256', secret).update(`198.51.100.8:${windowStart}`).digest('hex'), expect.any(Date));
    await trustedApp.close();
  });
});
