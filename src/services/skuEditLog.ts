/**
 * skuEditLog — журнал изменений карточек товаров.
 * Используется в Аудите карточек для отображения статуса:
 *   - submitted: отправлено в МП (на модерации)
 *   - synced: подтверждено (новое значение в БД продукта)
 *   - error: не удалось
 */

const STORAGE_KEY = 'sku_edit_log_v1';
const TTL_MS = 14 * 24 * 60 * 60 * 1000; // 14 дней

export type EditField = 'name' | 'photos' | 'brand' | 'price' | 'description' | 'category';
export type EditStatus = 'submitted' | 'synced' | 'error';

export interface EditLogEntry {
  id: string;                   // sku/offer_id/nm_id
  marketplace: 'ozon' | 'wb' | 'yandex';
  storeId: string;
  field: EditField;
  oldValue: string;
  newValue: string;
  status: EditStatus;
  submittedAt: string;          // ISO
  syncedAt?: string;            // когда подтвердили синхронизацию
  errorMsg?: string;
}

function key(mp: string, productId: string, field: EditField): string {
  return `${mp}|${productId}|${field}`;
}

function loadAll(): Record<string, EditLogEntry> {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    // Очищаем старые
    const now = Date.now();
    const filtered: Record<string, EditLogEntry> = {};
    for (const [k, v] of Object.entries(raw)) {
      const e = v as EditLogEntry;
      if (now - new Date(e.submittedAt).getTime() < TTL_MS) filtered[k] = e;
    }
    return filtered;
  } catch { return {}; }
}

function save(data: Record<string, EditLogEntry>): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
}

export const skuEditLog = {
  /** Записать факт отправки изменения. */
  recordSubmit(entry: Omit<EditLogEntry, 'status' | 'submittedAt'>): void {
    const data = loadAll();
    data[key(entry.marketplace, entry.id, entry.field)] = {
      ...entry,
      status: 'submitted',
      submittedAt: new Date().toISOString(),
    };
    save(data);
  },

  /** Зафиксировать ошибку отправки. */
  recordError(entry: Omit<EditLogEntry, 'status' | 'submittedAt'>, errorMsg: string): void {
    const data = loadAll();
    data[key(entry.marketplace, entry.id, entry.field)] = {
      ...entry,
      status: 'error',
      submittedAt: new Date().toISOString(),
      errorMsg,
    };
    save(data);
  },

  /** Проверить и обновить статус: если новое значение в БД совпадает с отправленным — synced. */
  reconcile(mp: string, productId: string, field: EditField, currentValue: string): EditLogEntry | null {
    const data = loadAll();
    const k = key(mp, productId, field);
    const e = data[k];
    if (!e) return null;
    if (e.status === 'submitted') {
      // Проверяем подтверждение
      const matches = String(e.newValue).trim() === String(currentValue).trim();
      if (matches) {
        e.status = 'synced';
        e.syncedAt = new Date().toISOString();
        save(data);
      }
    }
    return e;
  },

  /** Получить запись. */
  get(mp: string, productId: string, field: EditField): EditLogEntry | null {
    const data = loadAll();
    return data[key(mp, productId, field)] ?? null;
  },

  /** Получить все записи для конкретного товара. */
  getAllForProduct(mp: string, productId: string): EditLogEntry[] {
    const data = loadAll();
    return Object.values(data).filter(e => e.marketplace === mp && e.id === productId);
  },

  /** Статистика по статусам (для KPI в шапке). */
  stats(): { submitted: number; synced: number; error: number } {
    const data = loadAll();
    let submitted = 0, synced = 0, error = 0;
    for (const e of Object.values(data)) {
      if (e.status === 'submitted') submitted++;
      else if (e.status === 'synced') synced++;
      else if (e.status === 'error') error++;
    }
    return { submitted, synced, error };
  },

  clear(): void {
    localStorage.removeItem(STORAGE_KEY);
  },
};
