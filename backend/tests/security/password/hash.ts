// src/security/password/hash.ts

import argon2 from 'argon2';
import { PasswordHashResult, PasswordConfig, PasswordError, DEFAULT_PASSWORD_POLICY, DEFAULT_PASSWORD_CONFIG } from './types.ts';

export async function hashPassword(
  password: string,
  config?: Partial<PasswordConfig>
): Promise<PasswordHashResult> {
  if (password.length < DEFAULT_PASSWORD_POLICY.minLength) {
    throw new PasswordError(
      `Password must be at least ${DEFAULT_PASSWORD_POLICY.minLength} characters long`,
      'INVALID_INPUT'
    );
  }

  if (password.length > DEFAULT_PASSWORD_POLICY.maxLength) {
    throw new PasswordError(
      `Password must not exceed ${DEFAULT_PASSWORD_POLICY.maxLength} characters`,
      'INVALID_INPUT'
    );
  }

  const finalConfig = { ...DEFAULT_PASSWORD_CONFIG, ...config };

  try {
    const hash = await argon2.hash(password, {
      type: 2,
      memoryCost: finalConfig.memoryCost,
      timeCost: finalConfig.timeCost,
      parallelism: finalConfig.parallelism,
      hashLength: finalConfig.hashLength,
      version: finalConfig.version,
    });

    return {
      hash,
      algorithm: 'argon2id',
    };
  } catch (error) {
    throw new PasswordError('Failed to hash password', 'HASH_FAILED');
  }
}