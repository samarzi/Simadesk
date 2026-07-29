/**
 * Shared Server API HTTP client.
 * Used by all services to talk to the server REST API.
 *
 * Auth: after Telegram login the access_token is stored in localStorage (access_token).
 * Every request uses that token for auth. Falls back to anon key when not logged in.
 */
import { debug } from '@/utils/debug';


const API_URL = (import.meta.env.VITE_API_URL as string) || '';
const API_KEY = (import.meta.env.VITE_API_KEY as string) || '';

if (!API_URL || !API_KEY) {
  console.warn('[dbClient] VITE_API_URL and VITE_API_KEY not set in .env — API calls will fail');
}

export const REST_URL = `${API_URL}/rest/v1`;

// Single shared promise for concurrent 401 → refresh scenarios.
// Without this, N parallel requests all failing with 401 each call refreshToken()
// independently — the second call invalidates the token from the first, logging the user out.
let _refreshPromise: Promise<boolean> | null = null;
function sharedRefresh(): Promise<boolean> {
  if (!_refreshPromise) {
    _refreshPromise = import('./authService')
      .then(({ authService }) => authService.refreshToken())
      .finally(() => { _refreshPromise = null; });
  }
  return _refreshPromise;
}

/**
 * Returns auth headers for every API REST request.
 * Uses the user's JWT when logged in (enables RLS); falls back to anon key.
 */
export function getAuthHeaders(): Record<string, string> {
  const userToken = localStorage.getItem('access_token');
  const authBearer = userToken ? `Bearer ${userToken}` : `Bearer ${API_KEY}`;
  return {
    'Content-Type':  'application/json',
    'apikey':        API_KEY,
    'Authorization': authBearer,
    'Prefer':        'return=representation',
  };
}

/**
 * Static headers for cases where auth is not yet initialized
 * (e.g., during the auth flow itself, fetching companies list etc.)
 * @deprecated Prefer getAuthHeaders() in all new code
 */
export const BASE_HEADERS: Record<string, string> = {
  'Content-Type':  'application/json',
  'apikey':        API_KEY,
  'Authorization': `Bearer ${API_KEY}`,
  'Prefer':        'return=representation',
};

/**
 * Generic API REST request.
 * Throws on non-2xx responses with a descriptive message.
 * Always uses the current user's JWT (via getAuthHeaders).
 */
export async function dbFetch<T>(
  endpoint: string,
  options: RequestInit = {},
  extraHeaders: Record<string, string> = {},
): Promise<T> {
  let res = await fetch(`${REST_URL}/${endpoint}`, {
    ...options,
    headers: {
      ...getAuthHeaders(),
      ...extraHeaders,
      ...(options.headers as Record<string, string>),
    },
  });
  // Auto-refresh JWT on 401 — all concurrent failures share one refresh promise
  if (res.status === 401) {
    try {
      const refreshed = await sharedRefresh();
      if (refreshed) {
        res = await fetch(`${REST_URL}/${endpoint}`, {
          ...options,
          headers: {
            ...getAuthHeaders(),
            ...extraHeaders,
            ...(options.headers as Record<string, string>),
          },
        });
      }
    } catch (e) { debug.warn('[dbClient] swallowed error', e); }
  }
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} (${endpoint}): ${text.slice(0, 200)}`);
  }
  return (text ? JSON.parse(text) : null) as T;
}

/**
 * Fetch all records with automatic pagination.
 * Fires one HEAD request to get total count, then fetches all pages in parallel.
 */
export async function dbFetchAll<T>(
  endpoint: string,
  pageSize = 1000,
): Promise<T[]> {
  const sep = endpoint.includes('?') ? '&' : '?';

  const countResp = await fetch(`${REST_URL}/${endpoint}${sep}limit=0`, {
    headers: { ...getAuthHeaders(), 'Prefer': 'count=exact' },
  });
  if (!countResp.ok) throw new Error(`dbFetchAll: ${countResp.status}`);
  const countStr = countResp.headers.get('content-range')?.split('/')[1];
  const total = parseInt(countStr ?? '0', 10);
  if (!total || isNaN(total)) return [];

  const pageCount = Math.ceil(total / pageSize);
  const pages = Array.from({ length: pageCount }, (_, i) =>
    dbFetch<T[]>(`${endpoint}${sep}limit=${pageSize}&offset=${i * pageSize}`),
  );
  const results = await Promise.all(pages);
  return (results as T[][]).flat();
}
