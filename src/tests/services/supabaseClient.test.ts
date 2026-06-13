import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { supaFetch, supaFetchAll } from '@/services/supabaseClient';

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function makeResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
    headers: {
      get: (key: string) => headers[key] ?? null,
    },
  };
}

beforeEach(() => {
  mockFetch.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── supaFetch ──────────────────────────────────────────────────────────────

describe('supaFetch()', () => {
  it('returns parsed JSON on success', async () => {
    mockFetch.mockResolvedValueOnce(makeResponse([{ id: '1' }]));
    const result = await supaFetch<{ id: string }[]>('boxes?select=*');
    expect(result).toEqual([{ id: '1' }]);
  });

  it('throws on non-2xx response', async () => {
    mockFetch.mockResolvedValueOnce(makeResponse({ message: 'Not found' }, 404));
    await expect(supaFetch('boxes?id=eq.bad')).rejects.toThrow('404');
  });

  it('returns null for empty response body', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 204,
      text: async () => '',
      headers: { get: () => null },
    });
    const result = await supaFetch('boxes?id=eq.x', { method: 'DELETE' });
    expect(result).toBeNull();
  });

  it('sends correct Authorization header', async () => {
    mockFetch.mockResolvedValueOnce(makeResponse([]));
    await supaFetch('boxes?select=*');
    const [, options] = mockFetch.mock.calls[0];
    expect(options.headers['Authorization']).toContain('Bearer');
  });
});

// ── supaFetchAll ───────────────────────────────────────────────────────────

describe('supaFetchAll()', () => {
  it('returns empty array when total is 0', async () => {
    mockFetch.mockResolvedValueOnce(makeResponse([], 200, { 'content-range': '0-0/0' }));
    const result = await supaFetchAll('products?select=*');
    expect(result).toEqual([]);
  });

  it('fetches a single page when total <= pageSize', async () => {
    // HEAD request for count
    mockFetch.mockResolvedValueOnce(makeResponse([], 200, { 'content-range': '0-2/3' }));
    // Data page
    mockFetch.mockResolvedValueOnce(makeResponse([{ id: '1' }, { id: '2' }, { id: '3' }]));

    const result = await supaFetchAll('products?select=*', 1000);
    expect(result).toHaveLength(3);
  });

  it('fetches multiple pages and flattens results', async () => {
    // HEAD request: total = 2500
    mockFetch.mockResolvedValueOnce(makeResponse([], 200, { 'content-range': '0-999/2500' }));
    // Page 1
    mockFetch.mockResolvedValueOnce(makeResponse(Array(1000).fill({ id: 'a' })));
    // Page 2
    mockFetch.mockResolvedValueOnce(makeResponse(Array(1000).fill({ id: 'b' })));
    // Page 3
    mockFetch.mockResolvedValueOnce(makeResponse(Array(500).fill({ id: 'c' })));

    const result = await supaFetchAll('products?select=*', 1000);
    expect(result).toHaveLength(2500);
    // 3 data fetches + 1 count = 4 total
    expect(mockFetch).toHaveBeenCalledTimes(4);
  });
});
