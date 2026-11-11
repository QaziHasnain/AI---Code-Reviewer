import { describe, expect, it, vi } from 'vitest';
import { PersistentAuthRateLimitStore } from '@/security/auth/rate-limit-store.js';

describe('PersistentAuthRateLimitStore', () => {
  it('cleans expired buckets and performs database-side increments without exposing the input key', async () => {
    const deleteMany = vi.fn().mockResolvedValue({ count: 2 });
    const upsert = vi.fn().mockResolvedValue({ count: 3 });
    const store = new PersistentAuthRateLimitStore({ deleteMany, upsert } as never);
    const expiresAt = new Date('2030-01-01T01:00:00.000Z');
    const count = await store.increment('hmac-digest-containing-no-ip', expiresAt);

    expect(count).toBe(3);
    expect(deleteMany).toHaveBeenCalledWith({ where: { expiresAt: { lt: expect.any(Date) } } });
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { key: expect.stringMatching(/^[a-f0-9]{64}$/) },
      create: { key: expect.stringMatching(/^[a-f0-9]{64}$/), count: 1, expiresAt },
      update: { count: { increment: 1 } },
      select: { count: true },
    }));
    expect(JSON.stringify(upsert.mock.calls[0])).not.toContain('hmac-digest-containing-no-ip');
  });

  it('propagates storage failures so the route can fail closed', async () => {
    const store = new PersistentAuthRateLimitStore({
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      upsert: vi.fn().mockRejectedValue(new Error('database offline')),
    } as never);
    await expect(store.increment('opaque-key', new Date())).rejects.toThrow('database offline');
  });

  it('does not increment a bucket when expired-bucket cleanup fails', async () => {
    const upsert = vi.fn();
    const store = new PersistentAuthRateLimitStore({
      deleteMany: vi.fn().mockRejectedValue(new Error('cleanup unavailable')),
      upsert,
    } as never);
    await expect(store.increment('opaque-key', new Date())).rejects.toThrow('cleanup unavailable');
    expect(upsert).not.toHaveBeenCalled();
  });
});
