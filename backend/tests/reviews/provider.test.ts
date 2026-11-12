import { describe, expect, it, vi } from 'vitest';
import { FakeReviewProvider, GeminiReviewProvider, ProviderError } from '@/reviews/provider.js';

describe('review providers', () => {
  it('returns deterministic fake output', async () => {
    const fake = new FakeReviewProvider();
    await expect(fake.analyze({ language: 'TYPESCRIPT', sourceCode: 'x' })).resolves.toMatchObject({ provider: 'fake', review: { score: 100 } });
  });

  it('validates a successful Gemini response', async () => {
    const providerResult = { outcome: 'PASS', score: 99, summary: 'Looks good', issues: [] };
    const payload = { candidates: [{ content: { parts: [{ text: JSON.stringify(providerResult) }] } }] };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(payload), { status: 200 })));
    await expect(new GeminiReviewProvider('secret').analyze({ language: 'TYPESCRIPT', sourceCode: 'x' })).resolves.toMatchObject({ provider: 'gemini', review: { score: 99 } });
    vi.unstubAllGlobals();
  });

  it.each(['not json', '', JSON.stringify({ score: 1 })])('rejects malformed, empty, or invalid response', async (text) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }), { status: 200 })));
    await expect(new GeminiReviewProvider('secret').analyze({ language: 'TYPESCRIPT', sourceCode: 'x' })).rejects.toBeInstanceOf(ProviderError);
    vi.unstubAllGlobals();
  });

  it('classifies rate limits with Retry-After and permanent HTTP errors', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 429, headers: { 'retry-after': '3' } })));
    await expect(new GeminiReviewProvider('secret').analyze({ language: 'TYPESCRIPT', sourceCode: 'x' })).rejects.toMatchObject({ code: 'PROVIDER_RATE_LIMITED', retryable: true, retryAfterMs: 3000 });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 400 })));
    await expect(new GeminiReviewProvider('secret').analyze({ language: 'TYPESCRIPT', sourceCode: 'x' })).rejects.toMatchObject({ retryable: false });
    vi.unstubAllGlobals();
  });

  it('classifies provider timeouts and network errors without exposing raw errors', async () => {
    const controller = new AbortController();
    controller.abort();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('secret-key leaked')));
    await expect(new GeminiReviewProvider('secret').analyze({ language: 'TYPESCRIPT', sourceCode: 'x', signal: controller.signal })).rejects.toMatchObject({ code: 'PROVIDER_TIMEOUT', retryable: true });
    await expect(new GeminiReviewProvider('secret').analyze({ language: 'TYPESCRIPT', sourceCode: 'x' })).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    vi.unstubAllGlobals();
  });

  it('classifies an elapsed provider request deadline as a retryable timeout', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('request aborted')), { once: true });
    })));
    try {
      const pending = new GeminiReviewProvider('secret', 'test-model', 25).analyze({ language: 'TYPESCRIPT', sourceCode: 'x' });
      const expectation = expect(pending).rejects.toMatchObject({ code: 'PROVIDER_TIMEOUT', retryable: true });
      await vi.advanceTimersByTimeAsync(25);
      await expectation;
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });
});
