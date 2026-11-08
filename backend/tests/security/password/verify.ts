// src/security/password/verify.ts

import argon2 from 'argon2';
import { PasswordVerifyResult, PasswordConfig, PasswordError, PasswordPolicy, DEFAULT_PASSWORD_CONFIG, DEFAULT_PASSWORD_POLICY } from './types.ts';

export async function verifyPassword(
  password: string,
  hash: string,
  config?: Partial<PasswordConfig>
): Promise<PasswordVerifyResult> {
  if (password.length < DEFAULT_PASSWORD_POLICY.minLength) {
    throw new PasswordError(
      'Password must be at least 12 characters long',
      'INVALID_INPUT'
    );
  }

  if (password.length > DEFAULT_PASSWORD_POLICY.maxLength) {
    throw new PasswordError(
      'Password must not exceed 128 characters',
      'INVALID_INPUT'
    );
  }

  try {
    const result = await argon2.verify(hash, password);

    const currentConfig = DEFAULT_PASSWORD_CONFIG;
    const needsRehash = argon2.needsRehash(hash, currentConfig);

    return {
      valid: result,
      needsRehash,
    };
  } catch (error) {
    if (error instanceof Error) {
      if (error.message.includes('hash') || error.message.includes('invalid')) {
        throw new PasswordError('Invalid password hash format', 'VERIFY_FAILED');
      }
      throw new PasswordError('Password verification failed', 'VERIFY_FAILED');
    }
    throw new PasswordError('Password verification failed', 'VERIFY_FAILED');
  }
}