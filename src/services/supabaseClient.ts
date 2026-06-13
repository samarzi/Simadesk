/**
 * Shared Supabase HTTP client.
 * Both api.ts and ozonDb.ts use this to avoid duplicating credentials and fetch logic.
 *
 * Auth: after Telegram login the access_token is stored in localStorage (sb_access_token).
 * Every request uses that token for RLS to work. Falls back to anon key when not logged in.
 */

const SUPA_URL = import.meta.env.VITE_SUPA_URL as string;
const SUPA_KEY = import.meta.env.VITE_SUPA_KEY as string;

if (!SUPA_URL || !SUPA_KEY) {
  throw new Error('[supabaseClient] VITE_SUPA_URL and VITE_SUPA_KEY must be set in .env');
}

export const REST_URL = `${SUPA_URL}/rest/v1`;

/**
 * Returns auth headers for every Supabase REST request.
 * Uses the user's JWT when logged in (enables RLS); falls back to anon key.
 */
export function getAuthHeaders(): Record<string, string> {
  const userToken = localStorage.getItem('sb_access_token');
  const authBearer = userToken ? `Bearer ${userToken}` : `Bearer ${SUPA_KEY}`;
  return {
    'Content-Type':  'application/json',
    'apikey':        SUPA_KEY,
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
  'apikey':        SUPA_KEY,
  'Authorization': `Bearer ${SUPA_KEY}`,
  'Prefer':        'return=representation',
};

/**
 * Generic Supabase REST request.
 * Throws on non-2xx responses with a descriptive message.
 * Always uses the current user's JWT (via getAuthHeaders).
 */
export async function supaFetch<T>(
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
  // Auto-refresh JWT on 401
  if (res.status === 401) {
    try {
      const { authService } = await import('./authService');
      const refreshed = await authService.refreshToken();
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
    } catch {}
  }
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Supabase ${res.status} (${endpoint}): ${text.slice(0, 200)}`);
  }
  return (text ? JSON.parse(text) : null) as T;
}

/**
 * Fetch all records with automatic pagination.
 * Fires one HEAD request to get total count, then fetches all pages in parallel.
 */
export async function supaFetchAll<T>(
  endpoint: string,
  pageSize = 1000,
): Promise<T[]> {
  const sep = endpoint.includes('?') ? '&' : '?';

  const countResp = await fetch(`${REST_URL}/${endpoint}${sep}limit=0`, {
    headers: { ...getAuthHeaders(), 'Prefer': 'count=exact' },
  });
  const countStr = countResp.headers.get('content-range')?.split('/')[1];
  const total = parseInt(countStr || '0');
  if (!total) return [];

  const pageCount = Math.ceil(total / pageSize);
  const pages = Array.from({ length: pageCount }, (_, i) =>
    supaFetch<T[]>(`${endpoint}${sep}limit=${pageSize}&offset=${i * pageSize}`),
  );
  const results = await Promise.all(pages);
  return (results as T[][]).flat();
}
