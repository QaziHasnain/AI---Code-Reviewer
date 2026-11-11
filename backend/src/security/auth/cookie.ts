import type { FastifyReply } from 'fastify';
import type { CookieSerializeOptions } from '@fastify/cookie';
import env from '../../config/env.js';

export const SESSION_COOKIE_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;

export function isProductionEnvironment(): boolean {
  return env.NODE_ENV === 'production';
}

export function getSessionCookieName(): string {
  return isProductionEnvironment() ? '__Host-session' : 'session';
}

export function buildSessionCookieOptions(): CookieSerializeOptions {
  const isProduction = isProductionEnvironment();
  return {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_COOKIE_MAX_AGE_SECONDS,
  };
}

export function setSessionCookie(
  reply: FastifyReply,
  token: string,
): FastifyReply {
  return reply.setCookie(getSessionCookieName(), token, buildSessionCookieOptions());
}

export function clearSessionCookie(
  reply: FastifyReply,
): FastifyReply {
  const options = buildSessionCookieOptions();
  return reply.clearCookie(getSessionCookieName(), {
    ...options,
    maxAge: 0,
  });
}
