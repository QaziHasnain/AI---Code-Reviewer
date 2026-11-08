// src/security/password/types.ts

export interface PasswordConfig {
  memoryCost: number;
  timeCost: number;
  parallelism: number;
  hashLength: number;
  saltLength: number;
  version: number;
}

export interface PasswordHashResult {
  hash: string;
  algorithm: 'argon2id';
}

export interface PasswordVerifyResult {
  valid: boolean;
  needsRehash: boolean;
}

export class PasswordError extends Error {
  constructor(message: string, public readonly code: 'INVALID_INPUT' | 'HASH_FAILED' | 'VERIFY_FAILED') {
    super(message);
    this.name = 'PasswordError';
  }
}

export interface PasswordPolicy {
  minLength: number;
  maxLength: number;
}

export const DEFAULT_PASSWORD_CONFIG: PasswordConfig = {
  memoryCost: 65536,
  timeCost: 3,
  parallelism: 4,
  hashLength: 32,
  saltLength: 16,
  version: 19,
};

export const DEFAULT_PASSWORD_POLICY: PasswordPolicy = {
  minLength: 12,
  maxLength: 128,
};
