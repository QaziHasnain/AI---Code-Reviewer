import { randomBytes } from 'node:crypto';
import { SessionTokenError, type SessionTokenResult } from './types.js';

const SESSION_TOKEN_BYTES = 32;

export function generateSessionToken(): SessionTokenResult {
  try {
    return { token: randomBytes(SESSION_TOKEN_BYTES).toString('hex') };
  } catch {
    throw new SessionTokenError('Unable to generate session token', 'GENERATION_FAILED');
  }
}

