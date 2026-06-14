/**
 * Единая логика расчёта целевой цены по правилу репрайсера.
 * Используется и для отображения «цели» в списке, и при реальном применении цены —
 * раньше эти два места считали по-разному (см. историю), что приводило к расхождению
 * между тем, что показывает UI, и тем, что реально ставится на маркетплейс.
 */

import type { RepricerRule } from './types';
import { evalFormula } from './utils';

export interface PriceContext {
  /** Остаток конкретного товара (для stock/formula правил). */
  stock: number;
  /** Себестоимость конкретного товара (для margin/formula правил), если задана. */
  cost: number | null;
  /** Момент времени для schedule-правил. По умолчанию — текущий. */
  now?: Date;
}

/** Применяет глобальные min/max границы правила к рассчитанной цене. */
function clampToRule(rule: RepricerRule, price: number): number {
  if (rule.minPrice && price < rule.minPrice) return rule.minPrice;
  if (rule.maxPrice && price > rule.maxPrice) return rule.maxPrice;
  return price;
}

/**
 * Рассчитать целевую цену товара по правилу.
 * Возвращает null, если цену рассчитать невозможно (нет себестоимости, невалидная формула,
 * сейчас не подходящий период расписания и т.п.).
 */
export function computeTargetPrice(rule: RepricerRule, ctx: PriceContext): number | null {
  const { stock, cost } = ctx;
  const now = ctx.now ?? new Date();

  switch (rule.type) {
    case 'target':
      return rule.targetPrice ?? null;

    case 'margin': {
      if (cost == null || !rule.marginMultiplier) return null;
      return clampToRule(rule, Math.round(cost * rule.marginMultiplier));
    }

    case 'stock': {
      // Multi-tier: ищем первый порог где stock ≤ maxStock (отсортировано по возрастанию)
      if (rule.stockTiers && rule.stockTiers.length > 0) {
        const tiers = [...rule.stockTiers].sort((a, b) => a.maxStock - b.maxStock);
        for (const t of tiers) {
          if (stock <= t.maxStock) return clampToRule(rule, t.price);
        }
        // Остаток больше всех порогов — берём цену последнего (самого "избыточного") порога.
        return clampToRule(rule, tiers[tiers.length - 1].price);
      }
      // Legacy single-tier
      if (rule.stockThreshold != null) {
        return stock <= rule.stockThreshold
          ? clampToRule(rule, rule.highStockPrice ?? 0)
          : clampToRule(rule, rule.lowStockPrice ?? 0);
      }
      return null;
    }

    case 'schedule': {
      // Multi-period: проверяем дни недели И время суток для каждого периода
      if (rule.schedulePeriods && rule.schedulePeriods.length > 0) {
        const day = now.getDay();
        const curMin = now.getHours() * 60 + now.getMinutes();
        for (const period of rule.schedulePeriods) {
          if (!period.days.includes(day)) continue;
          const [fh, fm] = (period.fromTime || '00:00').split(':').map(Number);
          const [th, tm] = (period.toTime || '23:59').split(':').map(Number);
          const fromMin = fh * 60 + fm;
          const toMin = th * 60 + tm;
          if (curMin >= fromMin && curMin <= toMin) return clampToRule(rule, period.price);
        }
        return null;
      }
      // Legacy weekday/weekend
      const isWeekday = [1, 2, 3, 4, 5].includes(now.getDay());
      return isWeekday ? (rule.weekdayPrice ?? null) : (rule.weekendPrice ?? null);
    }

    case 'formula': {
      if (!rule.formula) return null;
      if (cost == null && /\bcost_price\b/.test(rule.formula)) return null;
      const result = evalFormula(rule.formula, {
        cost_price: cost ?? 0,
        stock,
        margin: rule.marginMultiplier ?? 1,
      });
      if (result == null) return null;
      return clampToRule(rule, Math.round(result));
    }
  }
}
