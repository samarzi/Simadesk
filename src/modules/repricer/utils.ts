import type { RepricerRule, RuleProduct, Mp, MrcItem, UnifiedProduct } from './types';
import { MRC_MAX_CHANGE_PCT, MRC_DEVIATION_THRESHOLD, MRC_DEVIATION_MIN_RUB } from './types';
export { esc } from '@/utils/format';

// ── Rule helpers ──────────────────────────────────────────────────────────────

/** Получить все товары правила (обратная совместимость). */
export function ruleProducts(r: RepricerRule): RuleProduct[] {
  if (r.products && r.products.length > 0) return r.products;
  // МРЦ хранит состав в mrcItems (по одной ячейке на товар×магазин) — products
  // на самом правиле мог не сохраниться в более старых версиях, поэтому
  // восстанавливаем уникальный список товаров прямо из ячеек.
  if (r.type === 'mrc' && r.mrcItems && r.mrcItems.length > 0) {
    const seen = new Map<string, RuleProduct>();
    for (const item of r.mrcItems) {
      if (!seen.has(item.vendorCode)) {
        seen.set(item.vendorCode, { productId: item.productId, vendorCode: item.vendorCode, productTitle: item.productTitle });
      }
    }
    return [...seen.values()];
  }
  return [{ productId: r.productId, vendorCode: r.vendorCode, productTitle: r.productTitle }];
}

/**
 * Строит ячейки МРЦ-сетки: для каждого товара — по одной ячейке на каждый
 * маркетплейс/магазин, где товар реально продаётся (по данным unified-каталога).
 * existingItems — для слияния при редактировании (сохраняем enabled/mrcPrice
 * уже существующих ячеек, добавляем только новые).
 */
export function buildMrcItems(
  unified: UnifiedProduct[],
  products: RuleProduct[],
  mrcPriceFor: (vendorCode: string) => number,
  existingItems: MrcItem[] = [],
): MrcItem[] {
  const items: MrcItem[] = [];
  for (const prod of products) {
    const u = unified.find(u => u.vendorCode === prod.vendorCode);
    if (!u) continue;
    for (const variant of u.variants) {
      const existing = existingItems.find(it => it.storeId === variant.storeId && it.vendorCode === prod.vendorCode);
      if (existing) {
        items.push(existing);
        continue;
      }
      items.push({
        key: uid(),
        mp: variant.mp,
        storeId: variant.storeId,
        storeName: variant.storeName,
        productId: variant.productId,
        vendorCode: prod.vendorCode,
        productTitle: variant.title || prod.productTitle,
        mrcPrice: mrcPriceFor(prod.vendorCode),
        enabled: true,
      });
    }
  }
  return items;
}

// ── МРЦ — расчёты ────────────────────────────────────────────────────────────

/** Стабильный ключ для журнала анализа — одна ячейка правила. */
export function mrcItemStateKey(rule: RepricerRule, item: MrcItem): string {
  return `${rule.id}:${item.key}`;
}

/**
 * Общая формула для WB/Ozon/ЯМ: масштабируем текущую цену продавца пропорционально
 * тому, насколько витрина отличается от цели, с ограничением ±20% за один цикл —
 * чтобы система не "прыгала" слишком резко при разовых аномалиях (используется
 * для автоматического применения без участия пользователя).
 */
export function computeNewSellerPrice(
  targetShowcase: number,
  currentSellerPrice: number,
  showcasePrice: number,
): number {
  if (showcasePrice <= 0 || currentSellerPrice <= 0) return currentSellerPrice;
  const raw     = exactSellerPriceForMrc(targetShowcase, currentSellerPrice, showcasePrice);
  const maxDiff = Math.ceil(currentSellerPrice * MRC_MAX_CHANGE_PCT);
  return Math.min(currentSellerPrice + maxDiff, Math.max(currentSellerPrice - maxDiff, raw));
}

/**
 * Точная цена продавца (без ограничения ±20%), при которой витрина должна
 * совпасть с targetShowcase — исходя из текущего соотношения витрина/цена продавца.
 * Используется для подсказки «поставьте цену в ЛК» и для ручного применения
 * по кнопке «Применить» (пользователь сам решает, насколько менять цену).
 */
export function exactSellerPriceForMrc(
  targetShowcase: number,
  currentSellerPrice: number,
  showcasePrice: number,
): number {
  if (showcasePrice <= 0 || currentSellerPrice <= 0) return currentSellerPrice;
  return Math.round(currentSellerPrice * (targetShowcase / showcasePrice));
}

/** Витринная цена отклонилась от МРЦ? Порог: max(5₽, МРЦ×1%) */
export function mrcShowcaseDeviated(showcasePrice: number, mrcPrice: number): boolean {
  if (mrcPrice <= 0 || showcasePrice <= 0) return false;
  const threshold = Math.max(MRC_DEVIATION_MIN_RUB, mrcPrice * MRC_DEVIATION_THRESHOLD);
  return Math.abs(showcasePrice - mrcPrice) > threshold;
}

// ── Formula ───────────────────────────────────────────────────────────────────

/** Безопасный вычислитель формул — без eval, только числа и базовые операции. */
export function evalFormula(expr: string, vars: Record<string, number>): number | null {
  if (!expr.trim()) return null;
  try {
    let s = expr;
    for (const [name, val] of Object.entries(vars)) {
      s = s.replace(new RegExp(`\\b${name}\\b`, 'g'), String(val));
    }
    if (!/^[\d.+\-*/()\s]+$/.test(s)) return null;
    const result = Function(`"use strict"; return (${s})`)();
    return typeof result === 'number' && isFinite(result) ? result : null;
  } catch {
    return null;
  }
}

// ── Utility ───────────────────────────────────────────────────────────────────

export function uid(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

/** Публичная ссылка на карточку товара на маркетплейсе. */
export function productPageUrl(
  mp: Mp, productId: string,
  opts: { ozonSku?: number | null; marketSku?: number | null; marketModelId?: number | null } = {},
): string | null {
  if (mp === 'wb') {
    const nmId = Number(productId);
    return nmId > 0 ? `https://www.wildberries.ru/catalog/${nmId}/detail.aspx` : null;
  }
  if (mp === 'ozon') {
    return opts.ozonSku ? `https://www.ozon.ru/product/${opts.ozonSku}/` : null;
  }
  if (opts.marketModelId && opts.marketSku) {
    return `https://market.yandex.ru/product/${opts.marketModelId}?sku=${opts.marketSku}`;
  }
  return opts.marketSku ? `https://market.yandex.ru/search?text=${opts.marketSku}` : null;
}

/** Promise с тайм-аутом. */
export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${label}: тайм-аут ${Math.round(ms / 1000)}с`)), ms),
    ),
  ]);
}
