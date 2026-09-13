/**
 * Runtime health tests for the mobile app's single HTTP boundary.
 *
 * These tests use real Response/AbortSignal behavior with a mocked transport;
 * endpoint integration lives in services/api/test/endpoints.test.ts.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const sessionState = {
  accessToken: 'access-token',
  refreshToken: null,
  applyTokens: vi.fn(),
  signOut: vi.fn(),
};

vi.mock('@/store/session', () => ({
  useSession: {
    getState: () => sessionState,
  },
}));

import { ApiError, request } from '@/services/apiClient';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('mobile API client runtime health', () => {
  it('parses a successful JSON response and sends the bearer token', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ status: 'ok' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(request<{ status: string }>('/health')).resolves.toEqual({ status: 'ok' });
    expect(fetchMock).toHaveBeenCalledWith(
      'http://api.test:8080/health',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer access-token' }),
      }),
    );
  });

  it('surfaces the HTTP status, path, and server error payload', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ detail: 'Pod not found' }), {
          status: 404,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );

    const error = await request('/pods/missing', { anonymous: true }).catch((cause) => cause);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      message: 'Pod not found',
      status: 404,
      path: '/pods/missing',
      body: { detail: 'Pod not found' },
    });
  });

  it('aborts a request at its deadline and reports a network-safe timeout', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init: RequestInit) => {
        return new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        });
      }),
    );

    const rejection = expect(
      request('/slow', { anonymous: true, timeoutMs: 25 }),
    ).rejects.toMatchObject({
      status: 0,
      path: '/slow',
      message: expect.stringContaining('timed out after 25 ms'),
    });
    await vi.advanceTimersByTimeAsync(25);
    await rejection;
  });
});
