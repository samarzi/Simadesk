/**
 * Расчёт налога per-order.
 * УСН 6 / НПД / Патент / без НДС: налог = выручка × ставка.
 * УСН 15 / ОСНО: налог = max(0, прибыль_до_налога) × ставка.
 */

import { TaxModel } from '../types';

export function calcTax(
  revenue: number,
  expensesBeforeTax: number,
  model: TaxModel,
  rate: number,
): number {
  if (rate <= 0 || model === 'none' || revenue <= 0) return 0;
  switch (model) {
    case 'usn6':
    case 'npd':
    case 'patent':
      return revenue * rate;
    case 'usn15':
    case 'osn': {
      const base = revenue - expensesBeforeTax;
      return base > 0 ? base * rate : 0;
    }
    default:
      return 0;
  }
}
