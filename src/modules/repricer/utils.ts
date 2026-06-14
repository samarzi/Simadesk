import type { RepricerRule, RuleProduct, Mp } from './types';

// ── Rule helpers ──────────────────────────────────────────────────────────────

/** Получить все товары правила (обратная совместимость). */
export function ruleProducts(r: RepricerRule): RuleProduct[] {
  if (r.products && r.products.length > 0) return r.products;
  return [{ productId: r.productId, vendorCode: r.vendorCode, productTitle: r.productTitle }];
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

/** HTML-escape строки. */
export function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function uid(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

/** Публичная ссылка на карточку товара. */
export function productPageUrl(mp: Mp, productId: string, ozonProductId?: number | null, marketSku?: number | null): string | null {
  if (mp === 'wb') {
    const nmId = Number(productId);
    return nmId > 0 ? `https://www.wildberries.ru/catalog/${nmId}/detail.aspx` : null;
  }
  if (mp === 'ozon') {
    const id = ozonProductId ?? productId;
    return `https://www.ozon.ru/product/${encodeURIComponent(String(id))}/`;
  }
  return marketSku ? `https://market.yandex.ru/product/${marketSku}` : null;
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
