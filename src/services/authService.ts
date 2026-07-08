/**
 * Auth Service — Telegram Login + Supabase session management.
 *
 * Responsibilities:
 *  - Store / retrieve JWT tokens from localStorage
 *  - Call edge function to verify Telegram auth data
 *  - Refresh expired tokens via Supabase REST
 *  - Provide the current user info to other modules
 */

import { cookies } from '@/utils/cookies';

const STORAGE_KEYS = {
  ACCESS_TOKEN:  'sb_access_token',
  REFRESH_TOKEN: 'sb_refresh_token',
  USER:          'sb_user',
  EXPIRES_AT:    'sb_expires_at',
} as const;

export interface AuthUser {
  id: string;          // Supabase auth UUID
  telegram_id: number;
  first_name: string;
  last_name?: string | null;
  username?: string | null;
  photo_url?: string | null;
  display_name?: string | null;  // кастомное имя (если не хочет использовать TG-имя)
}

export interface AuthSession {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  user_id: string;
  first_name: string;
  username: string | null;
  photo_url: string | null;
}

const SUPA_URL   = import.meta.env.VITE_SUPA_URL as string;
const SUPA_KEY   = import.meta.env.VITE_SUPA_KEY as string;
// In dev mode requests go to Vite's local auth handler (/api/auth/telegram).
// In production they go to the Supabase Edge Function.
const IS_DEV     = import.meta.env.DEV === true;
const AUTH_URL   = IS_DEV
  ? '/api/auth/telegram'
  : `${SUPA_URL}/functions/v1/telegram-auth`;

class AuthService {
  // ── Getters ───────────────────────────────────────────────────────────────

  getAccessToken(): string | null {
    return localStorage.getItem(STORAGE_KEYS.ACCESS_TOKEN) || cookies.get(STORAGE_KEYS.ACCESS_TOKEN);
  }

  getRefreshToken(): string | null {
    return localStorage.getItem(STORAGE_KEYS.REFRESH_TOKEN) || cookies.get(STORAGE_KEYS.REFRESH_TOKEN);
  }

  getUser(): AuthUser | null {
    const raw = localStorage.getItem(STORAGE_KEYS.USER) || cookies.get(STORAGE_KEYS.USER);
    if (!raw) return null;
    try { return JSON.parse(raw); }
    catch { return null; }
  }

  isLoggedIn(): boolean {
    return !!this.getAccessToken() && !!this.getUser();
  }

  isTokenExpired(): boolean {
    const expiresAt = parseInt(localStorage.getItem(STORAGE_KEYS.EXPIRES_AT) || '0', 10);
    // Treat as expired 60s before actual expiry (buffer)
    return Date.now() >= (expiresAt - 60_000);
  }

  // ── Session persistence ───────────────────────────────────────────────────

  private saveSession(session: AuthSession): void {
    const expiresAt = Date.now() + (session.expires_in ?? 3600) * 1000;
    const userJson = JSON.stringify({
      id: session.user_id,
      first_name: session.first_name,
      username: session.username ?? null,
      photo_url: session.photo_url ?? null,
    } satisfies Partial<AuthUser>);

    // localStorage — быстрый доступ в рамках сессии
    localStorage.setItem(STORAGE_KEYS.ACCESS_TOKEN,  session.access_token);
    localStorage.setItem(STORAGE_KEYS.REFRESH_TOKEN, session.refresh_token);
    localStorage.setItem(STORAGE_KEYS.EXPIRES_AT,    String(expiresAt));
    localStorage.setItem(STORAGE_KEYS.USER, userJson);

    // cookies — резервная копия на 90 дней (выживает после очистки localStorage)
    const cookieAge = Math.min(session.expires_in ?? 3600, 7 * 24 * 3600); // max 7 дней для токена
    cookies.set(STORAGE_KEYS.ACCESS_TOKEN,  session.access_token, cookieAge);
    cookies.set(STORAGE_KEYS.REFRESH_TOKEN, session.refresh_token);        // 90 дней
    cookies.set(STORAGE_KEYS.USER, userJson);
  }

  clearSession(): void {
    Object.values(STORAGE_KEYS).forEach(k => localStorage.removeItem(k));
    Object.values(STORAGE_KEYS).forEach(k => cookies.remove(k));
  }

  // ── Telegram Login Widget callback ────────────────────────────────────────

  /**
   * Called by the Telegram Login Widget's onauth callback.
   * Sends data to our Supabase Edge Function for verification.
   */
  /** Telegram Login Widget callback */
  async loginWithTelegram(telegramData: Record<string, string>): Promise<void> {
    const res = await fetch(AUTH_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPA_KEY,
        'Authorization': `Bearer ${SUPA_KEY}`,
      },
      body: JSON.stringify({ telegram_data: telegramData }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Network error' }));
      console.error('[auth] 401 detail:', JSON.stringify(err));
      throw new Error(err.error || `Auth failed: ${res.status}`);
    }

    const session: AuthSession = await res.json();
    this.saveSession(session);
  }

  /** Telegram Mini App — авторизация через initData (WebApp.initData) */
  async loginWithInitData(initData: string): Promise<void> {
    const res = await fetch(AUTH_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPA_KEY,
        'Authorization': `Bearer ${SUPA_KEY}`,
      },
      body: JSON.stringify({ init_data: initData }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Network error' }));
      console.error('[auth] initData 401 detail:', JSON.stringify(err));
      throw new Error(err.error || `Auth failed: ${res.status}`);
    }
    const session: AuthSession = await res.json();
    this.saveSession(session);
  }

  /** Проверяет, запущено ли приложение внутри Telegram (Mini App) */
  isTelegramMiniApp(): boolean {
    return !!(window as any).Telegram?.WebApp?.initData;
  }

  /** Данные пользователя из Telegram Mini App (без верификации — только для UI) */
  getTelegramWebAppUser(): Partial<AuthUser> | null {
    const twa = (window as any).Telegram?.WebApp;
    if (!twa?.initDataUnsafe?.user) return null;
    const u = twa.initDataUnsafe.user;
    return {
      telegram_id: u.id,
      first_name:  u.first_name || '',
      last_name:   u.last_name  || null,
      username:    u.username   || null,
      photo_url:   null, // TMA не предоставляет фото напрямую
    };
  }

  // ── Token refresh ─────────────────────────────────────────────────────────

  async refreshToken(): Promise<boolean> {
    const refreshToken = this.getRefreshToken();
    if (!refreshToken) return false;

    try {
      const res = await fetch(`${SUPA_URL}/auth/v1/token?grant_type=refresh_token`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': SUPA_KEY,
        },
        body: JSON.stringify({ refresh_token: refreshToken }),
      });

      if (!res.ok) {
        this.clearSession();
        return false;
      }

      const data = await res.json();
      // Supabase refresh response shape
      if (data.access_token) {
        const user = this.getUser();
        this.saveSession({
          access_token:  data.access_token,
          refresh_token: data.refresh_token,
          expires_in:    data.expires_in ?? 3600,
          user_id:       user?.id ?? data.user?.id ?? '',
          first_name:    user?.first_name ?? data.user?.user_metadata?.first_name ?? '',
          username:      user?.username ?? data.user?.user_metadata?.username ?? null,
          photo_url:     user?.photo_url ?? null,
        });
        return true;
      }

      this.clearSession();
      return false;
    } catch {
      return false;
    }
  }

  /**
   * Ensures a valid access token is available.
   * Refreshes if expired. Returns null if completely unauthenticated.
   */
  async getValidToken(): Promise<string | null> {
    if (!this.isLoggedIn()) return null;
    if (this.isTokenExpired()) {
      const ok = await this.refreshToken();
      if (!ok) return null;
    }
    return this.getAccessToken();
  }

  // ── Dev bypass (local dev without a real Telegram bot) ────────────────────
  /**
   * Used in development only (VITE_DEV_AUTH=true in .env.local).
   * Идёт через тот же /api/auth/telegram, что и реальный Telegram-вход —
   * локальный dev-хэндлер (vite.config.ts) без BOT_TOKEN пропускает проверку
   * подписи и создаёт/переиспользует настоящего Supabase-пользователя с
   * настоящей сессией (через SUPABASE_SERVICE_ROLE_KEY). Раньше здесь просто
   * подделывался токен на клиенте — из-за этого все запросы к Supabase падали
   * с "Expected 3 parts in JWT" (не JWT вовсе, а произвольная строка).
   */
  async devLogin(telegramId = 999999999, name = 'Dev User'): Promise<void> {
    const authDate = String(Math.floor(Date.now() / 1000));
    await this.loginWithTelegram({
      id: String(telegramId),
      first_name: name,
      username: 'devuser',
      auth_date: authDate,
      hash: 'dev-bypass', // не проверяется локально, т.к. BOT_TOKEN не задан в .env
    });
  }
}

export const authService = new AuthService();
