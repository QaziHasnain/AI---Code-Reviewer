import { describe, expect, it } from 'vitest';
import { parseRuntimeEnvironment } from '@/config/runtime.js';
import { rateLimitHmacSecretSchema, trustedProxyAddressesSchema } from '@/config/env.js';

describe('runtime environment validation', () => {
  it.each(['development', 'test', 'production'])('accepts %s', (value) => {
    expect(parseRuntimeEnvironment(value)).toBe(value);
  });

  it('rejects a missing environment instead of defaulting to development', () => {
    expect(() => parseRuntimeEnvironment(undefined)).toThrow();
  });

  it('rejects unknown environment values', () => {
    expect(() => parseRuntimeEnvironment('prod')).toThrow();
  });

  it('requires at least 32 bytes of hexadecimal HMAC secret material', () => {
    expect(rateLimitHmacSecretSchema.safeParse('a'.repeat(64)).success).toBe(true);
    expect(rateLimitHmacSecretSchema.safeParse('short-secret').success).toBe(false);
    expect(rateLimitHmacSecretSchema.safeParse('g'.repeat(64)).success).toBe(false);
  });

  it('accepts only explicit proxy IP addresses and defaults to no trusted proxies', () => {
    expect(trustedProxyAddressesSchema.parse('')).toEqual([]);
    expect(trustedProxyAddressesSchema.parse('127.0.0.1, ::1')).toEqual(['127.0.0.1', '::1']);
    expect(trustedProxyAddressesSchema.safeParse('*').success).toBe(false);
    expect(trustedProxyAddressesSchema.safeParse('127.0.0.1,anything').success).toBe(false);
  });
});
