import { describe, expect, it } from 'vitest';
import { parseRuntimeEnvironment } from '@/config/runtime.js';

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
});
