/**
 * Управление дополнительными ("кастомными") колонками для товаров.
 *
 * Системные колонки:
 *   - cost_price (себестоимость) — нельзя удалить, нужна для формул цен и аналитики
 *
 * Пользовательские колонки:
 *   - артикул производителя
 *   - размеры, материал, и т.п.
 *
 * Все значения хранятся per-offer_id в localStorage и могут быть импортированы/
 * экспортированы через XLSX.
 */

export type ColumnDataType = 'number' | 'text';

export interface CustomColumn {
  id: string;                    // 'cost_price' для системной, UUID для остальных
  label: string;                 // 'Себестоимость, ₽'
  data_type: ColumnDataType;
  system?: boolean;              // нельзя удалить — применяется ко всем группам
  show_in_table?: boolean;       // показывать в общей таблице товаров
  description?: string;
  /** ID группы (Box.id). Null = системная (общая для всех групп). */
  box_id?: string | null;
  /** Порядок отображения (для drag-and-drop). Меньше = раньше. */
  order?: number;
  created_at: string;
}

const KEY_COLS_BASE   = 'custom_columns_v1';
const KEY_VALUES_BASE = 'custom_column_values_v1'; // {offer_id: {col_id: value}}

/** Возвращает ключ localStorage с учётом активной компании */
function companyKey(base: string): string {
  const cid = localStorage.getItem('active_company_id') ?? '';
  return cid ? `${base}_${cid}` : base;
}
const getColsKey   = () => companyKey(KEY_COLS_BASE);
const getValsKey   = () => companyKey(KEY_VALUES_BASE);

const SYSTEM_COLUMNS: CustomColumn[] = [
  {
    id: 'cost_price',
    label: 'Себестоимость',
    data_type: 'number',
    system: true,
    show_in_table: true,
    description: 'Применяется ко ВСЕМ группам. Используется для прибыли и формул цен.',
    box_id: null,
    created_at: new Date(0).toISOString(),
  },
];

function loadRaw<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch { return fallback; }
}

function save(key: string, value: unknown): void {
  try { localStorage.setItem(key, JSON.stringify(value)); }
  catch (e) { console.error(`[customColumnsDb] save ${key}:`, e); }
}

export const customColumnsDb = {
  /**
   * Все колонки — системные + пользовательские.
   * - Без аргумента или null → все колонки (видны в режиме «Все товары» тоже)
   * - С boxId → системные + только этой группы
   * Колонки сортируются по полю `order` (для drag-and-drop).
   */
  getColumns: (boxId?: string | null): CustomColumn[] => {
    const user = loadRaw<CustomColumn[]>(getColsKey(), []);
    const dedup = user.filter(c => !SYSTEM_COLUMNS.find(sc => sc.id === c.id));
    const all = [...SYSTEM_COLUMNS, ...dedup];
    let filtered: CustomColumn[];
    if (boxId === undefined || boxId === null) {
      filtered = all; // системные + все пользовательские из всех групп
    } else {
      filtered = all.filter(c => c.system || c.box_id === boxId);
    }
    // Сортировка: system всегда сверху, потом по order, потом по created_at
    return filtered.sort((a, b) => {
      if (a.system && !b.system) return -1;
      if (!a.system && b.system) return 1;
      const oa = a.order ?? 999999;
      const ob = b.order ?? 999999;
      if (oa !== ob) return oa - ob;
      return a.created_at.localeCompare(b.created_at);
    });
  },

  /** Переставить колонку. Принимает массив id в новом порядке (для текущего фильтра/группы). */
  reorderColumns: (orderedIds: string[]): void => {
    const list = loadRaw<CustomColumn[]>(getColsKey(), []);
    const byId = new Map(list.map(c => [c.id, c]));
    orderedIds.forEach((id, idx) => {
      const col = byId.get(id);
      if (col) col.order = idx;
    });
    save(getColsKey(), list);
  },

  /** Только пользовательские колонки конкретной группы. */
  getGroupColumns: (boxId: string): CustomColumn[] => {
    const user = loadRaw<CustomColumn[]>(getColsKey(), []);
    return user.filter(c => c.box_id === boxId);
  },

  addColumn: (col: Omit<CustomColumn, 'id' | 'created_at' | 'system'>): CustomColumn => {
    const list = loadRaw<CustomColumn[]>(getColsKey(), []);
    // Shift existing user-defined columns (for same box or global) up by 1
    // so the new column can take order=0 and appear at the top.
    for (const c of list) {
      if (!c.system && (c.box_id === col.box_id || col.box_id === null)) {
        c.order = (c.order ?? 999998) + 1;
      }
    }
    const newCol: CustomColumn = {
      ...col,
      id: crypto.randomUUID(),
      order: 0,   // Always insert at position 0 → appears at the beginning
      created_at: new Date().toISOString(),
    };
    list.push(newCol);
    save(getColsKey(), list);
    return newCol;
  },

  updateColumn: (id: string, updates: Partial<CustomColumn>): void => {
    if (SYSTEM_COLUMNS.find(c => c.id === id)) {
      // Системные пока не редактируются (можно расширить позже — менять label/show_in_table)
      return;
    }
    const list = loadRaw<CustomColumn[]>(getColsKey(), []);
    const idx = list.findIndex(c => c.id === id);
    if (idx === -1) return;
    list[idx] = { ...list[idx], ...updates, id: list[idx].id, system: list[idx].system };
    save(getColsKey(), list);
  },

  deleteColumn: (id: string): void => {
    if (SYSTEM_COLUMNS.find(c => c.id === id)) return; // системные неудаляемы
    const list = loadRaw<CustomColumn[]>(getColsKey(), []).filter(c => c.id !== id);
    save(getColsKey(), list);
    // Удаляем значения этой колонки у всех товаров
    const vals = loadRaw<Record<string, Record<string, any>>>(getValsKey(), {});
    for (const offerId of Object.keys(vals)) {
      if (vals[offerId][id] !== undefined) {
        delete vals[offerId][id];
      }
    }
    save(getValsKey(), vals);
  },

  // ── Values ─────────────────────────────────────────────────────
  /** Получить все значения. */
  getAllValues: (): Record<string, Record<string, any>> =>
    loadRaw(getValsKey(), {}),

  /** Получить значения для одного товара. */
  getValuesFor: (offerId: string): Record<string, any> => {
    const vals = customColumnsDb.getAllValues();
    return vals[offerId] ?? {};
  },

  /** Установить значение. value=null — удалить. */
  setValue: (offerId: string, columnId: string, value: any): void => {
    const vals = customColumnsDb.getAllValues();
    if (!vals[offerId]) vals[offerId] = {};
    if (value === null || value === undefined || value === '') {
      delete vals[offerId][columnId];
      if (Object.keys(vals[offerId]).length === 0) delete vals[offerId];
    } else {
      vals[offerId][columnId] = value;
    }
    save(getValsKey(), vals);
    // Синхронизация cost_price → costPriceDb
    if (columnId === 'cost_price') {
      import('./costPriceDb').then(({ costPriceDb }) => {
        const n = Number(value);
        if (value != null && value !== '' && isFinite(n) && n > 0) {
          costPriceDb.set(offerId, n);
        } else {
          costPriceDb.remove(offerId);
        }
      }).catch(() => {});
    }
  },

  /** Сохранить много значений атомарно — для импорта. */
  bulkSetValues: (updates: Array<{ offer_id: string; column_id: string; value: any }>): void => {
    const vals = customColumnsDb.getAllValues();
    const costItems: Array<{ vendorCode: string; cost: number }> = [];
    for (const u of updates) {
      if (!vals[u.offer_id]) vals[u.offer_id] = {};
      if (u.value === null || u.value === undefined || u.value === '') {
        delete vals[u.offer_id][u.column_id];
      } else {
        vals[u.offer_id][u.column_id] = u.value;
      }
      if (Object.keys(vals[u.offer_id]).length === 0) delete vals[u.offer_id];
      // Собираем cost_price для синхронизации
      if (u.column_id === 'cost_price' && u.value != null && u.value !== '') {
        const n = Number(u.value);
        if (isFinite(n) && n > 0) costItems.push({ vendorCode: u.offer_id, cost: n });
      }
    }
    save(getValsKey(), vals);
    // Синхронизация cost_price → costPriceDb
    if (costItems.length > 0) {
      import('./costPriceDb').then(({ costPriceDb }) => {
        costPriceDb.bulkSet(costItems);
      }).catch(() => {});
    }
  },

  /** Получить себестоимость товара (для удобства). */
  getCostPrice: (offerId: string): number | null => {
    const v = customColumnsDb.getValuesFor(offerId)['cost_price'];
    if (v == null || v === '') return null;
    const n = Number(v);
    return isFinite(n) ? n : null;
  },
};
