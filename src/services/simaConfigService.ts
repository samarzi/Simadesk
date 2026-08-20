/**
 * Загружает конфигурацию Симы из БД (sima_config).
 * Кэш 5 минут — достаточно для оперативного применения изменений из админки.
 */
import { REST_URL, getAuthHeaders } from './dbClient';

export interface SimaConfigEntry {
  id: string;
  key: string;
  title: string;
  description?: string;
  value: string;
  is_active: boolean;
  updated_at: string;
}

let _cache: { data: SimaConfigEntry[]; ts: number } | null = null;
const TTL = 5 * 60 * 1000;

export async function loadSimaConfig(): Promise<SimaConfigEntry[]> {
  if (_cache && Date.now() - _cache.ts < TTL) return _cache.data;
  try {
    const res = await fetch(`${REST_URL}/sima_config?select=*&order=key.asc`, {
      headers: getAuthHeaders(),
    });
    if (!res.ok) return _cache?.data ?? [];
    const data: SimaConfigEntry[] = await res.json();
    _cache = { data, ts: Date.now() };
    return data;
  } catch {
    return _cache?.data ?? [];
  }
}

export function clearSimaConfigCache(): void {
  _cache = null;
}

/** Возвращает значение конкретного ключа или '' если не найден/пустой */
export function getConfigValue(entries: SimaConfigEntry[], key: string): string {
  return entries.find(e => e.key === key)?.value.trim() ?? '';
}
