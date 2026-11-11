import Fastify, { type FastifyReply } from 'fastify';
import cookie from '@fastify/cookie';
import { describe, expect, it, vi } from 'vitest';
import { registerAuthentication, type AuthenticationDependencies } from '@/plugins/authentication.js';
import type { PublicSession } from '@/security/session/index.js';

vi.mock('@/config/env.js', () => ({ default: { NODE_ENV: 'production' } }));

const {
  buildSessionCookieOptions,
  clearSessionCookie,
  getSessionCookieName,
  setSessionCookie,
} = await import('@/security/auth/cookie.js');

describe('production session cookie policy', () => {
  it('cannot be overridden to use the development name or disable Secure', () => {
    expect(getSessionCookieName()).toBe('__Host-session');
    expect(buildSessionCookieOptions()).toEqual({
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: '/',
      maxAge: 604800,
    });
    expect(buildSessionCookieOptions()).not.toHaveProperty('domain');

    const reply = {
      setCookie: vi.fn(),
      clearCookie: vi.fn(),
    } as unknown as FastifyReply;
    Reflect.apply(setSessionCookie, undefined, [reply, 'token', false]);
    Reflect.apply(clearSessionCookie, undefined, [reply, false]);

    expect(reply.setCookie).toHaveBeenCalledWith('__Host-session', 'token', expect.objectContaining({ secure: true }));
    expect(reply.clearCookie).toHaveBeenCalledWith('__Host-session', expect.objectContaining({ secure: true, maxAge: 0 }));
    expect(reply.setCookie.mock.calls[0][2]).not.toHaveProperty('domain');
    expect(reply.clearCookie.mock.calls[0][1]).not.toHaveProperty('domain');
  });

  it('serializes production creation and clearing with __Host- requirements', async () => {
    const app = Fastify();
    await app.register(cookie);
    app.get('/set', async (_request, reply) => setSessionCookie(reply, 'production-token').send({ ok: true }));
    app.get('/clear', async (_request, reply) => clearSessionCookie(reply).send({ ok: true }));

    const setHeader = String((await app.inject({ method: 'GET', url: '/set' })).headers['set-cookie']);
    const clearHeader = String((await app.inject({ method: 'GET', url: '/clear' })).headers['set-cookie']);
    for (const header of [setHeader, clearHeader]) {
      expect(header).toContain('__Host-session=');
      expect(header).toContain('Secure');
      expect(header).toContain('HttpOnly');
      expect(header).toContain('SameSite=Lax');
      expect(header).toContain('Path=/');
      expect(header.toLowerCase()).not.toContain('domain=');
    }
    expect(setHeader).toContain('Max-Age=604800');
    expect(clearHeader).toContain('Max-Age=0');
    await app.close();
  });

  it('makes authentication read only the production cookie name', async () => {
    const session: PublicSession = {
      id: 'session-id', userId: 'user-id', expiresAt: new Date('2030-01-08T00:00:00.000Z'),
      createdAt: new Date('2030-01-01T00:00:00.000Z'), lastSeenAt: null, revokedAt: null,
      userAgent: null, ipHash: null,
    };
    const dependencies: AuthenticationDependencies = {
      prisma: { user: { findUnique: vi.fn().mockResolvedValue({
        id: 'user-id', name: 'Reviewer', email: 'reviewer@example.com', createdAt: session.createdAt,
      }) } },
      sessions: { validateSession: vi.fn().mockResolvedValue(session) },
    };
    const app = Fastify();
    await app.register(cookie);
    registerAuthentication(app, dependencies);
    app.get('/private', { preHandler: app.requireAuth }, async () => ({ ok: true }));

    const productionCookie = await app.inject({
      method: 'GET', url: '/private', headers: { cookie: '__Host-session=production-token' },
    });
    const developmentCookie = await app.inject({
      method: 'GET', url: '/private', headers: { cookie: 'session=development-token' },
    });

    expect(productionCookie.statusCode).toBe(200);
    expect(dependencies.sessions.validateSession).toHaveBeenCalledTimes(1);
    expect(dependencies.sessions.validateSession).toHaveBeenCalledWith('production-token');
    expect(developmentCookie.statusCode).toBe(401);
    await app.close();
  });
});
