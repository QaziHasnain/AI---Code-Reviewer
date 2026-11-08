import { describe, it, expect } from 'vitest';
import { hashPassword, verifyPassword } from '@/security/password/index';

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
    const currentResult = await verifyPassword('SecurePass123!Ab', hash, { memoryCost: 16384 });
    const updatedResult = await verifyPassword('SecurePass123!Ab', hash, { memoryCost: 65536 });

    expect(currentResult.needsRehash).toBe(false);
    expect(updatedResult.needsRehash).toBe(true);
  });
});
