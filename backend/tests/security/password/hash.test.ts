import { describe, it, expect } from 'vitest';
import { hashPassword, verifyPassword, DEFAULT_PASSWORD_POLICY } from '@/security/password/index';

describe('hashPassword', () => {
  it('hashes a valid password meeting policy', async () => {
    const result = await hashPassword('SecurePass123!Ab');
    expect(result.hash).toMatch(/^\$argon2id\$/);
    expect(result.algorithm).toBe('argon2id');
  });

  it('rejects passwords shorter than 12 characters', async () => {
    await expect(hashPassword('Short1!')).rejects.toThrow();
  });

  it('rejects passwords longer than 128 characters', async () => {
    const longPassword = 'a'.repeat(129);
    await expect(hashPassword(longPassword)).rejects.toThrow();
  });

  it('rejects empty passwords', async () => {
    await expect(hashPassword('')).rejects.toThrow();
  });

  it('rejects whitespace-only passwords', async () => {
    await expect(hashPassword('   ')).rejects.toThrow();
  });

  it('produces different hashes for same password (unique salt)', async () => {
    const h1 = await hashPassword('SecurePass123!Ab');
    const h2 = await hashPassword('SecurePass123!Ab');
    expect(h1.hash).not.toBe(h2.hash);
  });

  it('uses provided config parameters', async () => {
    const result = await hashPassword('SecurePass123!Ab', { memoryCost: 16384, timeCost: 1 });
    expect(result.hash).toContain('m=16384,t=1');
  });

  it('preserves password whitespace', async () => {
    const password = '  SecurePass123!Ab  ';
    const { hash } = await hashPassword(password);

    await expect(verifyPassword(password, hash)).resolves.toMatchObject({ valid: true });
    await expect(verifyPassword('SecurePass123!Ab', hash)).resolves.toMatchObject({ valid: false });
  });

  it('exports correct password policy defaults', () => {
    expect(DEFAULT_PASSWORD_POLICY.minLength).toBe(12);
    expect(DEFAULT_PASSWORD_POLICY.maxLength).toBe(128);
  });
});

describe('verifyPassword', () => {
  it('verifies correct password', async () => {
    const { hash } = await hashPassword('SecurePass123!Ab');
    const result = await verifyPassword('SecurePass123!Ab', hash);
    expect(result.valid).toBe(true);
  });

  it('rejects wrong password', async () => {
    const { hash } = await hashPassword('SecurePass123!Ab');
    const result = await verifyPassword('WrongPass123!Ab', hash);
    expect(result.valid).toBe(false);
  });

  it('rejects malformed hash', async () => {
    await expect(verifyPassword('SecurePass123!Ab', 'invalid-hash')).rejects.toThrow();
  });

  it('flags needsRehash for outdated parameters', async () => {
    const { hash } = await hashPassword('SecurePass123!Ab', { memoryCost: 16384 });
    const result = await verifyPassword('SecurePass123!Ab', hash, { memoryCost: 65536 });
    expect(result.needsRehash).toBe(true);
  });
});
