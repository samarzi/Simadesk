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
  /** Себестоимость единицы по артикулу. null = не задана. */
  get(vendorCode: string, sku?: string): number | null;
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

  const get = (vendorCode: string, sku?: string): number | null => {
    if (vendorCode) {
      const v = cache.get(vendorCode) ?? cache.get(vendorCode.toLowerCase());
      if (v != null) return v;
    }
    if (sku) {
      const v = cache.get(sku);
      if (v != null) return v;
    }
    return null;
  };

  return {
    get,
    has(vc, sku) { return get(vc, sku) != null; },
  };
}
