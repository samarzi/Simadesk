/**
 * Резолв себестоимости с приоритетами:
 *   1) costPriceDb (главная таблица «Себестоимости»)
 *   2) customColumnsDb.cost_price (для обратной совместимости)
 *   3) null — себестоимость не задана
 */

import { debug } from '@/utils/debug';
import { costPriceDb } from '@/services/costPriceDb';
import { customColumnsDb } from '@/services/customColumnsDb';

export interface CogsResolver {
  /** Себестоимость единицы по артикулу на дату заказа. null = не задана. */
  get(vendorCode: string, sku?: string, date?: string): number | null;
  /** Есть ли значение. */
  has(vendorCode: string, sku?: string): boolean;
}

/** Строит resolver один раз — кэширует обращения к localStorage. */
export function buildCogsResolver(): CogsResolver {
  const cache = new Map<string, number>();

  try {
    for (const e of costPriceDb.all()) {
      if (isFinite(e.cost) && e.cost > 0) {
        cache.set(e.vendorCode, e.cost);
        cache.set(e.vendorCode.toLowerCase(), e.cost);
      }
    }
  } catch (e) { debug.warn('[cogsResolver] swallowed error', e); }

  try {
    const allValues = customColumnsDb.getAllValues();
    for (const [offerId, values] of Object.entries(allValues)) {
      if (cache.has(offerId)) continue;
      const v = values['cost_price'];
      if (v != null && v !== '') {
        const n = Number(v);
        if (isFinite(n) && n > 0) cache.set(offerId, n);
      }
    }
  } catch (e) { debug.warn('[cogsResolver] swallowed error', e); }

  const get = (vendorCode: string, sku?: string, date?: string): number | null => {
    for (const code of [vendorCode, sku]) {
      if (!code) continue;
      const v = cache.get(code) ?? cache.get(code.toLowerCase());
      if (v == null) continue;
      // История есть только у себестоимостей из главной таблицы.
      if (date) {
        try {
          const dated = costPriceDb.costAt(code, date);
          if (dated != null && dated > 0) return dated;
        } catch { /* нет истории — берём текущую */ }
      }
      return v;
    }
    return null;
  };

  return {
    get,
    has(vc, sku) { return get(vc, sku) != null; },
  };
}
