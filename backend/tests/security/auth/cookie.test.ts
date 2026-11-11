import Fastify, { type FastifyReply } from 'fastify';
import cookie from '@fastify/cookie';
import { describe, expect, it, vi } from 'vitest';
import env from '@/config/env.js';
import {
  buildSessionCookieOptions,
  clearSessionCookie,
  getSessionCookieName,
  SESSION_COOKIE_MAX_AGE_SECONDS,
  setSessionCookie,
} from '@/security/auth/cookie.js';

describe('runtime session cookie policy', () => {
  it('uses the development cookie policy in test mode for local HTTP tests', () => {
    expect(env.NODE_ENV).toBe('test');
    expect(getSessionCookieName()).toBe('session');
    expect(buildSessionCookieOptions()).toEqual({
      httpOnly: true,
      secure: false,
      sameSite: 'lax',
      path: '/',
      maxAge: SESSION_COOKIE_MAX_AGE_SECONDS,
    });
  });

  it('clears the cookie with the same identity attributes used to create it', async () => {
    const app = Fastify();
    await app.register(cookie);
    app.get('/set', async (_request, reply) => setSessionCookie(reply, 'test-token').send({ ok: true }));
    app.get('/clear', async (_request, reply) => clearSessionCookie(reply).send({ ok: true }));

    const setHeader = String((await app.inject({ method: 'GET', url: '/set' })).headers['set-cookie']);
    const clearHeader = String((await app.inject({ method: 'GET', url: '/clear' })).headers['set-cookie']);
    for (const header of [setHeader, clearHeader]) {
      expect(header).toContain('session=');
      expect(header).toContain('HttpOnly');
      expect(header).toContain('SameSite=Lax');
      expect(header).toContain('Path=/');
      expect(header.toLowerCase()).not.toContain('domain=');
      expect(header).not.toContain('Secure');
    }
    expect(setHeader).toContain('Max-Age=604800');
    expect(clearHeader).toContain('Max-Age=0');
    expect(clearHeader).not.toContain('test-token');
    await app.close();
  });

  it('does not expose caller-controlled policy arguments', () => {
    const reply = {
      setCookie: vi.fn(),
      clearCookie: vi.fn(),
    } as unknown as FastifyReply;

    Reflect.apply(setSessionCookie, undefined, [reply, 'token', false]);
    Reflect.apply(clearSessionCookie, undefined, [reply, false]);

    expect(reply.setCookie).toHaveBeenCalledWith('session', 'token', expect.objectContaining({ secure: false }));
    expect(reply.clearCookie).toHaveBeenCalledWith('session', expect.objectContaining({ secure: false, maxAge: 0 }));
  });
});
