import { createHmac } from 'node:crypto';

export type AuthRateLimitPurpose = 'login' | 'register';

export interface FixedWindow {
  start: number;
  expiresAt: Date;
}

export function fixedWindow(now: number, windowMs: number): FixedWindow {
  const start = Math.floor(now / windowMs) * windowMs;
  return {
    start,
    expiresAt: new Date(start + windowMs),
  };
}

export function createAuthRateLimitKey(
  secret: string,
  purpose: AuthRateLimitPurpose,
  ip: string,
  windowStart: number,
): string {
  return createHmac('sha256', Buffer.from(secret, 'hex'))
    .update(`${purpose}:${ip}:${windowStart}`)
    .digest('hex');
}
