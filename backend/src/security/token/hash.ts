import { createHash } from 'node:crypto';

export function hashToken(token: string): { hash: string } {
  return { hash: createHash('sha256').update(token, 'utf8').digest('hex') };
}

