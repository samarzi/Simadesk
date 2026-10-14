/**
 * Налоги.
 *
 * Налог с выручки (УСН 6%, НПД, патент) и НДС линейны — их честно считать по
 * каждому заказу. Налог с прибыли (УСН 15%, ОСНО) нелинеен: убыточный заказ
 * уменьшает базу, а по отдельному заказу этого не видно. Поэтому он считается
 * за период целиком по магазину (computeProfitTax в kpiAggregator), а здесь
 * для таких режимов возвращается только НДС.
 */

import { TaxModel } from '../types';

export interface OrderTax {
  /** Налог с выручки + НДС. */
  tax: number;
  /** НДС к уплате (часть tax). */
  vat: number;
}

/** Режимы, где налог берётся с прибыли и считается за период. */
export function isProfitTaxModel(model: TaxModel): boolean {
  return model === 'usn15' || model === 'osn';
}

/** Минимальный налог от выручки: на УСН 15% — 1%. */
export function minTaxRate(model: TaxModel): number {
  return model === 'usn15' ? 0.01 : 0;
}

/**
 * НДС к уплате по заказу. Цены маркетплейсов включают НДС.
 * ОСНО: исходящий НДС минус входящий с услуг маркетплейса (они облагаются НДС).
 * УСН с НДС 5% / 7%: вычетов нет, налог с полной выручки.
 */
export function calcVat(revenue: number, mpFees: number, model: TaxModel, vatRate: number): number {
  if (!vatRate || vatRate <= 0 || revenue <= 0) return 0;
  if (model === 'npd' || model === 'patent' || model === 'none') return 0;
  const k = vatRate / (1 + vatRate);
  if (model === 'osn') return Math.max(0, (revenue - Math.max(0, mpFees)) * k);
  return revenue * k;
}

export function calcOrderTax(
  revenue: number,
  mpFees: number,
  model: TaxModel,
  rate: number,
  vatRate = 0,
): OrderTax {
  if (revenue <= 0 || model === 'none') return { tax: 0, vat: 0 };
  const vat = calcVat(revenue, mpFees, model, vatRate);
  let income = 0;
  if (rate > 0) {
    switch (model) {
      // Доход на УСН с НДС считается без НДС.
      case 'usn6':   income = (revenue - vat) * rate; break;
      case 'npd':
      case 'patent': income = revenue * rate; break;
      default:       income = 0; // usn15 / osn — за период
    }
  }
  return { tax: income + vat, vat };
}

/** Налог с прибыли за период по одному магазину. */
export function calcProfitTax(revenueExVat: number, expenses: number, rate: number, minRate: number): number {
  if (rate <= 0 || revenueExVat <= 0) return 0;
  const byProfit = Math.max(0, revenueExVat - expenses) * rate;
  return Math.max(byProfit, revenueExVat * minRate);
}

/** @deprecated оставлено для совместимости: налог по одному заказу без НДС. */
export function calcTax(revenue: number, expensesBeforeTax: number, model: TaxModel, rate: number): number {
  if (rate <= 0 || model === 'none' || revenue <= 0) return 0;
  if (isProfitTaxModel(model)) {
    const base = revenue - expensesBeforeTax;
    return base > 0 ? base * rate : 0;
  }
  return revenue * rate;
}
