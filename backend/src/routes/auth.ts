import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { AuthError, AuthService, AUTHENTICATION_FAILED_MESSAGE, loginSchema, registerSchema } from '../security/auth/index.js';
import { clearSessionCookie, getSessionCookieName, setSessionCookie } from '../security/auth/cookie.js';
import { createAuthRateLimitKey, fixedWindow } from '../security/auth/rate-limit.js';
import { SessionError } from '../security/session/index.js';

const LOGIN_LIMIT = 10;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const REGISTER_LIMIT = 5;
const REGISTER_WINDOW_MS = 60 * 60 * 1000;

export interface AuthRouteDependencies {
  auth: AuthService;
  sessions: { revokeSession(token: string): Promise<void> };
  rateLimits: { increment(key: string, expiresAt: Date): Promise<number> };
  frontendUrl: string;
  rateLimitHmacSecret: string;
}

function sameOrigin(request: FastifyRequest, frontendUrl: string): boolean {
  const expected = new URL(frontendUrl).origin;
  const origin = request.headers.origin;
  if (origin !== undefined) return origin === expected;
  const referer = request.headers.referer;
  if (referer === undefined) return false;
  try { return new URL(referer).origin === expected; } catch { return false; }
}

function sessionCookie(request: FastifyRequest): string | undefined {
  const token = request.cookies[getSessionCookieName()];
  return typeof token === 'string' && token.length > 0 ? token : undefined;
}

async function replacePreviousSession(
  dependencies: AuthRouteDependencies,
  previousToken: string | undefined,
  newToken: string,
): Promise<boolean> {
  if (!previousToken) return true;
  try {
    await dependencies.sessions.revokeSession(previousToken);
    return true;
  } catch (error) {
    if (error instanceof SessionError && error.code !== 'DATABASE_ERROR') return true;
    try { await dependencies.sessions.revokeSession(newToken); } catch {
      // Keep the original failure generic; best-effort cleanup must not expose storage details.
    }
    return false;
  }
}

function safeError(reply: FastifyReply, error: unknown) {
  if (error instanceof AuthError) {
    if (error.code === 'EMAIL_ALREADY_EXISTS') return reply.code(409).send({ error: { code: error.code, message: error.message } });
    if (error.code === 'AUTHENTICATION_FAILED') return reply.code(401).send({ error: { code: error.code, message: AUTHENTICATION_FAILED_MESSAGE } });
  }
  return reply.code(503).send({ error: { code: 'SERVICE_UNAVAILABLE', message: 'Authentication service unavailable' } });
}

export async function authRoutes(app: FastifyInstance, dependencies: AuthRouteDependencies): Promise<void> {
  app.post('/api/auth/register', async (request, reply) => {
    if (!sameOrigin(request, dependencies.frontendUrl)) return reply.code(403).send({ error: { code: 'ORIGIN_FORBIDDEN', message: 'Request origin is not allowed' } });
    const parsed = registerSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: { code: 'INVALID_INPUT', message: 'Invalid registration details' } });
    try {
      const window = fixedWindow(Date.now(), REGISTER_WINDOW_MS);
      const key = createAuthRateLimitKey(dependencies.rateLimitHmacSecret, 'register', request.ip, window.start);
      const count = await dependencies.rateLimits.increment(key, window.expiresAt);
      if (count > REGISTER_LIMIT) return rateLimited(reply, window.expiresAt);
      const result = await dependencies.auth.register(parsed.data);
      if (!await replacePreviousSession(dependencies, sessionCookie(request), result.session.token)) return safeError(reply, new Error('session replacement failed'));
      setSessionCookie(reply, result.session.token);
      return reply.code(201).send({ user: result.user });
    } catch (error) { return safeError(reply, error); }
  });

  app.post('/api/auth/login', async (request, reply) => {
    if (!sameOrigin(request, dependencies.frontendUrl)) return reply.code(403).send({ error: { code: 'ORIGIN_FORBIDDEN', message: 'Request origin is not allowed' } });
    const parsed = loginSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: { code: 'INVALID_INPUT', message: 'Invalid login details' } });
    try {
      const window = fixedWindow(Date.now(), LOGIN_WINDOW_MS);
      const key = createAuthRateLimitKey(dependencies.rateLimitHmacSecret, 'login', request.ip, window.start);
      const count = await dependencies.rateLimits.increment(key, window.expiresAt);
      if (count > LOGIN_LIMIT) return rateLimited(reply, window.expiresAt);
      const result = await dependencies.auth.login(parsed.data);
      if (!await replacePreviousSession(dependencies, sessionCookie(request), result.session.token)) return safeError(reply, new Error('session replacement failed'));
      setSessionCookie(reply, result.session.token);
      return reply.code(200).send({ user: result.user });
    } catch (error) {
      if (error instanceof AuthError && error.code === 'AUTHENTICATION_FAILED') return safeError(reply, error);
      return safeError(reply, error);
    }
  });

  app.post('/api/auth/logout', async (request, reply) => {
    if (!sameOrigin(request, dependencies.frontendUrl)) return reply.code(403).send({ error: { code: 'ORIGIN_FORBIDDEN', message: 'Request origin is not allowed' } });

    const token = sessionCookie(request);
    if (!token) {
      clearSessionCookie(reply);
      return reply.code(204).send();
    }

    try {
      await dependencies.sessions.revokeSession(token);
    } catch (error) {
      const inactiveSession = error instanceof SessionError
        && ['SESSION_NOT_FOUND', 'SESSION_REVOKED', 'SESSION_EXPIRED', 'INVALID_TOKEN'].includes(error.code);
      if (!inactiveSession) {
        clearSessionCookie(reply);
        return reply.code(503).send({ error: { code: 'SERVICE_UNAVAILABLE', message: 'Authentication service unavailable' } });
      }
    }

    clearSessionCookie(reply);
    return reply.code(204).send();
  });

  app.get('/api/auth/me', { preHandler: app.requireAuth }, async (request) => ({
    user: request.auth!.user,
  }));
}

function rateLimited(reply: FastifyReply, expiresAt: Date): FastifyReply {
  const retryAfterSeconds = Math.max(1, Math.ceil((expiresAt.getTime() - Date.now()) / 1000));
  return reply.code(429).header('retry-after', String(retryAfterSeconds))
    .send({ error: { code: 'RATE_LIMITED', message: 'Too many login attempts' } });
}

export const LOGIN_RATE_LIMIT = { limit: LOGIN_LIMIT, windowMs: LOGIN_WINDOW_MS } as const;
export const REGISTER_RATE_LIMIT = { limit: REGISTER_LIMIT, windowMs: REGISTER_WINDOW_MS } as const;
