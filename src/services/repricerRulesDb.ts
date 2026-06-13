/**
 * repricerRulesDb — правила репрайсера.
 *
 * ХРАНЕНИЕ: Supabase (таблица repricer_rules) + локальный кеш в localStorage.
 * Раньше правила хранились только в localStorage (`repricer_rules_v3`), поэтому
 * в разных браузерах/устройствах показывались разные наборы. Теперь синхронизируются
 * через Supabase, как cost_prices (см. costPriceDb.ts — тот же паттерн).
 *
 *  - При загрузке: тянем из Supabase в кеш, допушиваем legacy-правила из localStorage
 *  - При записи: пишем в Supabase + обновляем кеш
 *  - all() работает из кеша (без await) — вызвать refresh() при старте
 *  - Если миграция add_repricer_rules.sql не применена — fallback на localStorage
 */

import { supaFetch } from './supabaseClient';
import { companyService } from './companyService';

const LEGACY_KEY          = 'repricer_rules_v3';            // старый единый ключ (до multi-company)
const CACHE_KEY_PREFIX    = 'repricer_rules_cache_v1_';
const MIGRATED_KEY_PREFIX = 'repricer_legacy_pushed_';       // флаг: legacy уже перенесён, не повторять

let cache: Record<string, any> = {};
let cacheCompanyId: string | null = null;
let supabaseAvailable = true;

function getCacheKey(): string {
  const cid = companyService.getActiveId();
  return cid ? `${CACHE_KEY_PREFIX}${cid}` : `${CACHE_KEY_PREFIX}_default`;
}

function loadCache(): Record<string, any> {
  try { return JSON.parse(localStorage.getItem(getCacheKey()) || '{}'); } catch { return {}; }
}
function saveCache(): void {
  try { localStorage.setItem(getCacheKey(), JSON.stringify(cache)); } catch {}
}

function loadLegacy(): any[] {
  try { return JSON.parse(localStorage.getItem(LEGACY_KEY) || '[]'); } catch { return []; }
}

async function refreshFromServer(): Promise<void> {
  const cid = companyService.getActiveId();
  if (!cid) return;
  const token = localStorage.getItem('sb_access_token');
  if (!token) return;
  if (cacheCompanyId !== cid) { cache = {}; cacheCompanyId = null; }

  try {
    const rows = await supaFetch<Array<{ id: string; data: any }>>(
      `repricer_rules?company_id=eq.${cid}&select=id,data`,
    );

    cache = {};
    for (const r of rows) cache[r.id] = r.data;

    // Однократная миграция: при первом успешном соединении с сервером —
    // пушим legacy-правила (если сервер пуст) и НАВСЕГДА удаляем LEGACY_KEY из localStorage.
    // После этого удалённые правила не будут возвращаться при перезагрузке.
    const migratedKey = `${MIGRATED_KEY_PREFIX}${cid}`;
    if (!localStorage.getItem(migratedKey)) {
      if (rows.length === 0) {
        const legacy = loadLegacy();
        if (legacy.length > 0) {
          console.info(`[repricerRulesDb] Миграция: допушиваем ${legacy.length} правил из localStorage на сервер`);
          const toUpload: Array<{ id: string; company_id: string; data: any; updated_at: string }> = [];
          for (const rule of legacy) {
            cache[rule.id] = rule;
            toUpload.push({ id: rule.id, company_id: cid, data: rule, updated_at: new Date().toISOString() });
          }
          for (let i = 0; i < toUpload.length; i += 50) {
            supaFetch('repricer_rules?on_conflict=id', {
              method: 'POST',
              headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
              body: JSON.stringify(toUpload.slice(i, i + 50)),
            }).catch(e => console.warn('[repricerRulesDb] re-push batch:', e));
          }
        }
      }
      // Удаляем старый ключ и ставим флаг — больше никогда не трогаем legacy.
      try { localStorage.removeItem(LEGACY_KEY); } catch {}
      try { localStorage.setItem(migratedKey, '1'); } catch {}
    }

    cacheCompanyId = cid;
    saveCache();
    supabaseAvailable = true;
  } catch (e: any) {
    const msg = String(e?.message ?? '');
    if (msg.includes('42P01') || (msg.includes('repricer_rules') && msg.includes('not found'))) {
      supabaseAvailable = false;
      console.warn('[repricerRulesDb] Supabase table repricer_rules не найдена. Используется localStorage.');
      // Load from company-scoped cache; if empty, do one-time migration from legacy key
      cache = loadCache();
      if (Object.keys(cache).length === 0) {
        for (const rule of loadLegacy()) cache[rule.id] = rule;
        saveCache(); // persist to company-scoped key
        try { localStorage.removeItem(LEGACY_KEY); } catch {} // remove shared key so other companies don't inherit these rules
      }
      cacheCompanyId = cid;
    } else {
      console.warn('[repricerRulesDb] load failed (используется локальный кеш):', msg);
      if (Object.keys(cache).length === 0) {
        cache = loadCache();
        if (Object.keys(cache).length === 0) {
          for (const rule of loadLegacy()) cache[rule.id] = rule;
          if (Object.keys(cache).length > 0) saveCache();
        }
        cacheCompanyId = cid;
      }
    }
  }
}

async function pushToServer(rule: any, retries = 2): Promise<void> {
  const cid = companyService.getActiveId();
  if (!cid || !supabaseAvailable) return;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      await supaFetch('repricer_rules?on_conflict=id', {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify({ id: rule.id, company_id: cid, data: rule, updated_at: new Date().toISOString() }),
      });
      return;
    } catch (e: any) {
      const msg = String(e?.message ?? '');
      if (msg.includes('repricer_rules') && msg.includes('42P01')) { supabaseAvailable = false; return; }
      console.warn(`[repricerRulesDb] push "${rule.id}" attempt ${attempt + 1}/${retries + 1}:`, msg);
      if (attempt < retries) await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
    }
  }
}

async function removeFromServer(id: string): Promise<void> {
  const cid = companyService.getActiveId();
  if (!cid || !supabaseAvailable) return;
  try {
    await supaFetch(`repricer_rules?company_id=eq.${cid}&id=eq.${encodeURIComponent(id)}`, { method: 'DELETE' });
  } catch (e) { console.warn('[repricerRulesDb] remove:', e); }
}

export const repricerRulesDb = {
  /** Синхронно: получить из кеша. Вызовите refresh() при старте чтобы кеш был свежим. */
  all(): any[] {
    return Object.values(cache);
  },

  /** Сохранить (создать/обновить) одно правило. */
  save(rule: any): void {
    cache[rule.id] = rule;
    saveCache();
    pushToServer(rule);
  },

  /** Сохранить несколько правил разом (upsert каждого). */
  saveMany(rules: any[]): void {
    for (const r of rules) cache[r.id] = r;
    saveCache();
    for (const r of rules) pushToServer(r);
  },

  remove(id: string): void {
    delete cache[id];
    saveCache();
    removeFromServer(id);
  },

  /** Принудительная перезагрузка с сервера. Вызвать при открытии модуля. */
  async refresh(): Promise<void> { return refreshFromServer(); },

  isCloudSyncAvailable(): boolean { return supabaseAvailable; },
};
