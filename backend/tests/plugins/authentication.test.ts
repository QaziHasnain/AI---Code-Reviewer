import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { describe, expect, it, vi } from 'vitest';
import { buildApp } from '@/app.js';
import { clearSessionCookie, getSessionCookieName, setSessionCookie } from '@/security/auth/cookie.js';
import { registerAuthentication, type AuthenticationDependencies } from '@/plugins/authentication.js';
import { SessionError, type PublicSession } from '@/security/session/index.js';

const publicUser = {
  id: 'user-id',
  name: 'Reviewer',
  email: 'reviewer@example.com',
  createdAt: new Date('2030-01-01T00:00:00.000Z'),
};
const publicSession: PublicSession = {
  id: 'session-id', userId: publicUser.id, expiresAt: new Date('2030-01-08T00:00:00.000Z'),
  createdAt: new Date('2030-01-01T00:00:00.000Z'), lastSeenAt: null, revokedAt: null,
  userAgent: null, ipHash: null,
};

function makeDependencies(): AuthenticationDependencies & {
  prisma: { user: { findUnique: ReturnType<typeof vi.fn> } };
  sessions: { validateSession: ReturnType<typeof vi.fn> };
} {
  return {
    prisma: { user: { findUnique: vi.fn().mockResolvedValue(publicUser) } },
    sessions: { validateSession: vi.fn().mockResolvedValue(publicSession) },
  };
}

async function makeProtectedApp(dependencies: AuthenticationDependencies) {
  const app = await buildApp({ frontendUrl: 'http://localhost:3000', authentication: dependencies });
  app.get('/private', { preHandler: app.requireAuth }, async (request) => ({ auth: request.auth }));
  return app;
}

describe('session cookie helpers', () => {
  it('sets and clears cookies with matching identity and security attributes', async () => {
    const app = Fastify();
    await app.register(cookie);
    app.get('/set', async (_request, reply) => setSessionCookie(reply, 'opaque-token').send({ ok: true }));
    app.get('/clear', async (_request, reply) => clearSessionCookie(reply).send({ ok: true }));

    const setResponse = await app.inject({ method: 'GET', url: '/set' });
    const clearResponse = await app.inject({ method: 'GET', url: '/clear' });
    const setCookie = String(setResponse.headers['set-cookie']);
    const clearCookie = String(clearResponse.headers['set-cookie']);

    expect(setCookie).toContain('session=opaque-token');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Lax');
    expect(setCookie).toContain('Path=/');
    expect(setCookie).toContain('Max-Age=604800');
    expect(setCookie).not.toContain('Secure');
    expect(setCookie.toLowerCase()).not.toContain('domain=');
    expect(clearCookie).toContain('session=');
    expect(clearCookie).toContain('HttpOnly');
    expect(clearCookie).toContain('SameSite=Lax');
    expect(clearCookie).toContain('Path=/');
    expect(clearCookie).toContain('Max-Age=0');
    expect(clearCookie).not.toContain('Secure');
    expect(clearCookie.toLowerCase()).not.toContain('domain=');
    expect(clearCookie).not.toContain('opaque-token');

    await app.close();
  });

  it('parses the environment-specific cookie and never falls back to another cookie name', async () => {
    const dependencies = makeDependencies();
    const app = await makeProtectedApp(dependencies);

    const valid = await app.inject({ method: 'GET', url: '/private', headers: { cookie: 'session=raw-token' } });
    const wrongName = await app.inject({ method: 'GET', url: '/private', headers: { cookie: '__Host-session=raw-token' } });

    expect(valid.statusCode).toBe(200);
    expect(dependencies.sessions.validateSession).toHaveBeenCalledWith('raw-token');
    expect(wrongName.statusCode).toBe(401);
    expect(getSessionCookieName()).toBe('session');
    await app.close();
  });
});

describe('requireAuth', () => {
  it('rejects missing and empty cookies with generic 401 responses', async () => {
    const app = await makeProtectedApp(makeDependencies());
    const missing = await app.inject({ method: 'GET', url: '/private' });
    const empty = await app.inject({ method: 'GET', url: '/private', headers: { cookie: 'session=' } });
    expect(missing.statusCode).toBe(401);
    expect(empty.statusCode).toBe(401);
    expect(missing.json()).toEqual({ error: { code: 'UNAUTHENTICATED', message: 'Authentication required' } });
    expect(empty.json()).toEqual(missing.json());
    await app.close();
  });

  it.each(['INVALID_TOKEN', 'SESSION_NOT_FOUND', 'SESSION_EXPIRED', 'SESSION_REVOKED'] as const)(
    'maps %s to a generic 401', async (code) => {
      const dependencies = makeDependencies();
      dependencies.sessions.validateSession.mockRejectedValue(new SessionError('sensitive session detail', code));
      const app = await makeProtectedApp(dependencies);
      const response = await app.inject({ method: 'GET', url: '/private', headers: { cookie: 'session=secret-token' } });
      expect(response.statusCode).toBe(401);
      expect(response.body).not.toContain('sensitive session detail');
      expect(response.body).not.toContain('secret-token');
      await app.close();
    },
  );

  it('attaches only safe user and session fields to request.auth', async () => {
    const dependencies = makeDependencies();
    dependencies.prisma.user.findUnique.mockResolvedValue({
      ...publicUser,
      passwordHash: 'private-password-hash',
      tokenHash: 'private-token-hash',
    });
    const app = await makeProtectedApp(dependencies);
    const response = await app.inject({ method: 'GET', url: '/private', headers: { cookie: 'session=raw-token' } });

    expect(response.statusCode).toBe(200);
    expect(response.json().auth).toEqual({
      userId: publicUser.id,
      user: { ...publicUser, createdAt: publicUser.createdAt.toISOString() },
      sessionId: publicSession.id,
    });
    expect(response.body).not.toContain('raw-token');
    expect(response.body).not.toContain('passwordHash');
    expect(response.body).not.toContain('tokenHash');
    expect(dependencies.prisma.user.findUnique).toHaveBeenCalledWith({
      where: { id: publicUser.id },
      select: { id: true, name: true, email: true, createdAt: true },
    });
    await app.close();
  });

  it('rejects sessions whose user no longer exists', async () => {
    const dependencies = makeDependencies();
    dependencies.prisma.user.findUnique.mockResolvedValue(null);
    const app = await makeProtectedApp(dependencies);
    const response = await app.inject({ method: 'GET', url: '/private', headers: { cookie: 'session=raw-token' } });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it('maps session and user database failures to generic 503 responses', async () => {
    const sessionFailure = makeDependencies();
    sessionFailure.sessions.validateSession.mockRejectedValue(new SessionError('database detail', 'DATABASE_ERROR'));
    const sessionApp = await makeProtectedApp(sessionFailure);
    const sessionResponse = await sessionApp.inject({ method: 'GET', url: '/private', headers: { cookie: 'session=raw-token' } });
    expect(sessionResponse.statusCode).toBe(503);
    expect(sessionResponse.body).not.toContain('database detail');
    await sessionApp.close();

    const userFailure = makeDependencies();
    userFailure.prisma.user.findUnique.mockRejectedValue(new Error('postgres connection details'));
    const userApp = await makeProtectedApp(userFailure);
    const userResponse = await userApp.inject({ method: 'GET', url: '/private', headers: { cookie: 'session=raw-token' } });
    expect(userResponse.statusCode).toBe(503);
    expect(userResponse.body).not.toContain('postgres connection details');
    await userApp.close();
  });

  it('maps unexpected session failures to a generic 500', async () => {
    const dependencies = makeDependencies();
    dependencies.sessions.validateSession.mockRejectedValue(new Error('internal token details'));
    const app = await makeProtectedApp(dependencies);
    const response = await app.inject({ method: 'GET', url: '/private', headers: { cookie: 'session=raw-token' } });
    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain('internal token details');
    expect(response.body).not.toContain('raw-token');
    await app.close();
  });

  it('leaves the public health endpoint accessible', async () => {
    const app = await makeProtectedApp(makeDependencies());
    const response = await app.inject({ method: 'GET', url: '/api/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: 'ok' });
    await app.close();
  });

});
