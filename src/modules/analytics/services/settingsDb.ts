/**
 * Настройки Аналитики в localStorage.
 * Минимум: FX, налог per-store, manual entries, audit.
 */

import { AnalyticsSettings, ManualEntry, StoreTaxOverride, TaxModel } from '../types';

const KEY_SETTINGS = 'analytics2_settings_v1';
const KEY_MANUAL   = 'analytics2_manual_v1';
const KEY_AUDIT    = 'analytics2_audit_v1';

const DEFAULT: AnalyticsSettings = {
  base_currency: 'RUB',
  fx_rates: { RUB: 1, USD: 95, EUR: 103, CNY: 13 },
  store_tax: {},
  default_tax_model: 'usn6',
  default_tax_rate: 0.06,
};

function load<T>(k: string, fb: T): T {
  try { const r = localStorage.getItem(k); return r ? JSON.parse(r) : fb; } catch { return fb; }
}
function save(k: string, v: unknown): void {
  try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { console.error('[analytics2.settings]', k, e); }
}

interface AuditRow {
  id: string;
  at: string;
  kind: 'settings' | 'tax' | 'manual_add' | 'manual_delete';
  details: string;
}

function audit(kind: AuditRow['kind'], details: string): void {
  const log = load<AuditRow[]>(KEY_AUDIT, []);
  log.push({ id: crypto.randomUUID(), at: new Date().toISOString(), kind, details });
  if (log.length > 500) log.splice(0, log.length - 500);
  save(KEY_AUDIT, log);
}

export const settingsDb = {
  get(): AnalyticsSettings {
    return { ...DEFAULT, ...load<Partial<AnalyticsSettings>>(KEY_SETTINGS, {}) };
  },

  save(s: AnalyticsSettings): void {
    save(KEY_SETTINGS, s);
    audit('settings', 'обновлены настройки');
  },

  setStoreTax(storeId: string, model: TaxModel, rate: number): void {
    const s = settingsDb.get();
    s.store_tax = { ...s.store_tax, [storeId]: { model, rate } };
    save(KEY_SETTINGS, s);
    audit('tax', `${storeId}: ${model} ${(rate * 100).toFixed(1)}%`);
  },

  clearStoreTax(storeId: string): void {
    const s = settingsDb.get();
    const map = { ...s.store_tax };
    delete map[storeId];
    s.store_tax = map;
    save(KEY_SETTINGS, s);
    audit('tax', `${storeId}: сброс`);
  },

  taxFor(storeId: string): StoreTaxOverride {
    const s = settingsDb.get();
    return s.store_tax[storeId] ?? { model: s.default_tax_model, rate: s.default_tax_rate };
  },

  setFx(currency: string, rate: number): void {
    const s = settingsDb.get();
    s.fx_rates = { ...s.fx_rates, [currency]: rate };
    save(KEY_SETTINGS, s);
    audit('settings', `FX ${currency}=${rate}`);
  },

  // ── Manual entries ──
  manualList(): ManualEntry[] {
    return load<ManualEntry[]>(KEY_MANUAL, []);
  },

  manualAdd(e: Omit<ManualEntry, 'id' | 'created_at'>): ManualEntry {
    const list = settingsDb.manualList();
    const entry: ManualEntry = { ...e, id: crypto.randomUUID(), created_at: new Date().toISOString() };
    list.push(entry);
    save(KEY_MANUAL, list);
    audit('manual_add', `${entry.type} ${entry.amount}₽ — ${entry.description}`);
    return entry;
  },

  manualDelete(id: string): void {
    const list = settingsDb.manualList();
    const idx = list.findIndex(x => x.id === id);
    if (idx < 0) return;
    const removed = list.splice(idx, 1)[0];
    save(KEY_MANUAL, list);
    audit('manual_delete', `${removed.type} ${removed.amount}₽`);
  },

  // ── Audit ──
  auditLog(): AuditRow[] { return load<AuditRow[]>(KEY_AUDIT, []); },
};
