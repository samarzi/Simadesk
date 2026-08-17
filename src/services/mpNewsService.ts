/**
 * MP News Service — загружает свежие новости маркетплейсов из Supabase.
 * Данные собираются ежедневно Edge Function /mp-news-fetch.
 */

import { REST_URL, getAuthHeaders } from './dbClient';

export interface MpNews {
  id: string;
  mp: 'wb' | 'ozon' | 'yandex' | 'general';
  title: string;
  summary: string;
  is_important: boolean;
  published_at: string;
  source_url?: string;
}

const SEEN_KEY = 'sd_mp_news_seen_at';
const CACHE_KEY = 'sd_mp_news_cache';
const CACHE_TTL = 60 * 60 * 1000; // 1 час

let _cache: { data: MpNews[]; ts: number } | null = null;

export async function loadRecentNews(days = 7): Promise<MpNews[]> {
  // Memory cache
  if (_cache && Date.now() - _cache.ts < CACHE_TTL) return _cache.data;

  // LocalStorage cache (survives page refresh)
  try {
    const stored = localStorage.getItem(CACHE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored);
      if (parsed.ts && Date.now() - parsed.ts < CACHE_TTL && Array.isArray(parsed.data)) {
        _cache = parsed;
        return parsed.data;
      }
    }
  } catch { /* ignore */ }

  try {
    const since = new Date(Date.now() - days * 86_400_000).toISOString();
    const url = `${REST_URL}/mp_news?select=id,mp,title,summary,is_important,published_at,source_url&published_at=gte.${encodeURIComponent(since)}&order=published_at.desc&limit=30`;
    const res = await fetch(url, { headers: getAuthHeaders() });
    if (!res.ok) return [];
    const data: MpNews[] = await res.json();
    _cache = { data, ts: Date.now() };
    localStorage.setItem(CACHE_KEY, JSON.stringify(_cache));
    return data;
  } catch {
    return [];
  }
}

/** Сколько новостей пользователь ещё не видел */
export function countUnread(news: MpNews[]): number {
  const seenAt = localStorage.getItem(SEEN_KEY);
  if (!seenAt) return news.length;
  return news.filter(n => n.published_at > seenAt).length;
}

/** Отметить все прочитанными */
export function markAllRead(): void {
  localStorage.setItem(SEEN_KEY, new Date().toISOString());
}

/** Форматировать новости для инжекта в контекст Симы */
export function formatNewsForContext(news: MpNews[]): string {
  if (!news.length) return '';
  const lines = ['[НОВОСТИ МАРКЕТПЛЕЙСОВ за последние 7 дней]'];
  const mpLabel: Record<string, string> = { wb: 'WB', ozon: 'Ozon', yandex: 'Яндекс Маркет', general: 'МП' };
  for (const n of news.slice(0, 10)) {
    const important = n.is_important ? ' ⚠️' : '';
    const date = new Date(n.published_at).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
    lines.push(`• [${mpLabel[n.mp] ?? n.mp}${important}] ${n.title} (${date}): ${n.summary}`);
  }
  lines.push('Используй эти данные когда пользователь спрашивает о новостях МП или изменениях условий.');
  return lines.join('\n');
}

/** Сброс кеша (при принудительном обновлении) */
export function clearNewsCache(): void {
  _cache = null;
  localStorage.removeItem(CACHE_KEY);
}
