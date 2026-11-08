import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { generateSessionToken } from '@/security/session/index.js';

describe('generateSessionToken', () => {
  it('generates 32 random bytes encoded as transport-safe hex by default', () => {
    const result = generateSessionToken();

    expect(result.token).toHaveLength(64);
    expect(result.token).toMatch(/^[0-9a-f]+$/);
  });

  it('generates unique tokens', () => {
    expect(generateSessionToken().token).not.toBe(generateSessionToken().token);
  });

  it('does not return a hash or expiry', () => {
    expect(generateSessionToken()).toEqual(expect.objectContaining({ token: expect.any(String) }));
    expect(generateSessionToken()).not.toHaveProperty('hash');
    expect(generateSessionToken()).not.toHaveProperty('expiresAt');
  });

});

describe('session token hashing', () => {
  it('produces a stable lowercase SHA-256 hexadecimal digest', async () => {
    const { hashToken } = await import('@/security/token/hash.js');
    const result = hashToken('raw-token');

    expect(result.hash).toBe(createHash('sha256').update('raw-token').digest('hex'));
    expect(result.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken('raw-token').hash).toBe(result.hash);
  });
});

