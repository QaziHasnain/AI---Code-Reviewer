import { describe, expect, it } from 'vitest';
import { loginSchema, registerSchema } from '@/security/auth/schemas.js';

const password = '  SecurePass123!Ab  ';

describe('registerSchema', () => {
  it('accepts valid input and normalizes only the email', () => {
    expect(registerSchema.parse({ name: 'Reviewer', email: '  USER@Example.COM ', password }))
      .toEqual({ name: 'Reviewer', email: 'user@example.com', password });
  });

  it('accepts passwords at the minimum and maximum boundaries', () => {
    expect(registerSchema.safeParse({ name: 'Reviewer', email: 'a@b.co', password: 'x'.repeat(12) }).success).toBe(true);
    expect(registerSchema.safeParse({ name: 'Reviewer', email: 'a@b.co', password: 'x'.repeat(128) }).success).toBe(true);
  });

  it('rejects passwords outside policy and malformed or incomplete input', () => {
    for (const candidate of ['', 'x'.repeat(11), 'x'.repeat(129)]) {
      expect(registerSchema.safeParse({ name: 'Reviewer', email: 'a@b.co', password: candidate }).success).toBe(false);
    }
    expect(registerSchema.safeParse({ name: '', email: 'not-an-email', password }).success).toBe(false);
    expect(registerSchema.safeParse({ name: 'Reviewer', email: 'a@b.co', password, unexpected: true }).success).toBe(false);
  });
});

describe('loginSchema', () => {
  it('accepts valid input, normalizes email, and preserves password whitespace', () => {
    expect(loginSchema.parse({ email: ' USER@Example.COM ', password }))
      .toEqual({ email: 'user@example.com', password });
  });

  it('allows short passwords to reach service-level timing protection', () => {
    expect(loginSchema.safeParse({ email: 'user@example.com', password: 'short' }).success).toBe(true);
  });

  it('rejects malformed or incomplete input', () => {
    expect(loginSchema.safeParse({ email: 'bad-email', password }).success).toBe(false);
    expect(loginSchema.safeParse({ email: 'user@example.com' }).success).toBe(false);
  });
});
