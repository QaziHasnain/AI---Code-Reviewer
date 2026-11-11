import { describe, expect, it, vi } from 'vitest';

vi.mock('@/config/env.js', () => ({
  default: {
    NODE_ENV: 'production',
    FRONTEND_URL: 'https://frontend.example.com',
  },
}));

const { buildApp } = await import('@/app.js');

describe('production app construction', () => {
  it('refuses to start without authentication dependencies', async () => {
    await expect(buildApp()).rejects.toThrow('Authentication dependencies are required in production');
  });
});
